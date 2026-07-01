// ---------------------------------------------------------------------------
// People / face recognition store (fully local). Each person keeps a few face
// DESCRIPTORS (128-float embeddings produced in the renderer by face-api.js).
// Matching is by euclidean distance. Detection runs in the renderer (WebGL, no
// native modules); main just persists + matches. Auto-tagged people flow into
// the clip's XMP PersonInImage + keywords (see buildEmbedTags).
// ---------------------------------------------------------------------------
// Each person keeps a list of FACES = { d:[128 descriptor], t:'thumb dataURL' } so
// the People dashboard can show every face per person (digiKam-style). Older configs
// stored parallel `descriptors`+`thumb`/`thumbs`; migratePerson() folds them into faces.
function migratePerson(p) {
  if (!Array.isArray(p.faces)) {
    const ds = Array.isArray(p.descriptors) ? p.descriptors : [];
    const ts = Array.isArray(p.thumbs) ? p.thumbs : (p.thumb ? [p.thumb] : []);
    p.faces = ds.map((d, i) => ({ d, t: ts[i] || p.thumb || '' }));
  }
  // Existing faces were user-named → treat as confirmed. New unconfirmed ones come
  // in with confirmed:false.
  p.faces.forEach((f) => { if (f.confirmed === undefined) f.confirmed = true; });
  if (!p.thumb && p.faces.length) p.thumb = ((p.faces.find((f) => f.confirmed && f.t) || p.faces.find((f) => f.t)) || {}).t || '';
  return p;
}
function aiPeople() { config.ai = config.ai || {}; if (!Array.isArray(config.ai.people)) config.ai.people = []; config.ai.people.forEach(migratePerson); return config.ai.people; }
function aiIgnoredFaces() { config.ai = config.ai || {}; if (!Array.isArray(config.ai.ignored)) config.ai.ignored = []; return config.ai.ignored; }
function personCover(p) { return p.thumb || ((p.faces || []).find((f) => f.confirmed && f.t) || (p.faces || []).find((f) => f.t) || {}).t || ''; }
function faceDist(a, b) { if (!a || !b) return Infinity; let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i += 1) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }
function personCounts(p) { const fs = p.faces || []; const conf = fs.filter((f) => f.confirmed).length; return { count: fs.length, confirmed: conf, unconfirmed: fs.length - conf }; }
ipcMain.handle('people:get', () => aiPeople().map((p) => ({ id: p.id, name: p.name, thumb: personCover(p), ...personCounts(p) })));
ipcMain.handle('faces:ignoredCount', () => aiIgnoredFaces().length);
// Full detail incl. every face thumb + confirmed flag — for the dashboard's grid.
ipcMain.handle('people:detail', (_e, id) => {
  const p = aiPeople().find((x) => x.id === id);
  if (!p) return { ok: false };
  return { ok: true, id: p.id, name: p.name, cover: personCover(p), ...personCounts(p), faces: (p.faces || []).map((f, i) => ({ i, t: f.t || '', confirmed: !!f.confirmed })) };
});
ipcMain.handle('people:save', (_e, payload) => {
  // Upsert a person by name; append new faces (descriptor + its thumb). `confirmed`
  // false = a recognized-but-not-yet-confirmed face (shows in the dashboard's
  // Unconfirmed section). Near-duplicate faces are skipped to keep the store diverse.
  const name = String((payload && payload.name) || '').trim();
  if (!name) return { ok: false, error: 'No name' };
  const descriptors = Array.isArray(payload && payload.descriptors) ? payload.descriptors.filter((d) => Array.isArray(d) && d.length) : [];
  const thumb = String((payload && payload.thumb) || '');
  const confirmed = !(payload && payload.confirmed === false);
  const people = aiPeople();
  let p = people.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!p) { p = { id: `pp${Date.now()}${Math.random().toString(36).slice(2, 6)}`, name, faces: [], thumb: '', ts: Date.now() }; people.push(p); }
  migratePerson(p);
  const isDup = (d) => d && (p.faces || []).some((f) => f.d && faceDist(f.d, d) < 0.35);
  for (const d of descriptors) { if (!isDup(d)) p.faces.push({ d, t: thumb, confirmed }); }
  if (!descriptors.length && thumb) p.faces.push({ d: null, t: thumb, confirmed });
  if (p.faces.length > 80) p.faces = p.faces.slice(-80);
  if (thumb && confirmed && !p.thumb) p.thumb = thumb;
  saveConfig();
  return { ok: true, id: p.id };
});
// Promote an unconfirmed face to confirmed.
ipcMain.handle('people:confirmFace', (_e, payload) => {
  const p = aiPeople().find((x) => x.id === (payload && payload.id));
  const idx = Number(payload && payload.index);
  if (!p || !p.faces || !(idx >= 0 && idx < p.faces.length)) return { ok: false };
  p.faces[idx].confirmed = true;
  if (!p.thumb && p.faces[idx].t) p.thumb = p.faces[idx].t;
  saveConfig();
  return { ok: true };
});
// Move a face into the global Ignored bin (won't be suggested as a person again).
ipcMain.handle('faces:ignore', (_e, payload) => {
  const ig = aiIgnoredFaces();
  const fromId = payload && payload.id; const idx = Number(payload && payload.index);
  if (fromId !== undefined && idx >= 0) {
    const p = aiPeople().find((x) => x.id === fromId);
    if (p && p.faces && idx < p.faces.length) { ig.push(p.faces[idx]); p.faces.splice(idx, 1); if (p.thumb && !(p.faces || []).some((f) => f.t === p.thumb)) p.thumb = personCover(p); }
  } else if (Array.isArray(payload && payload.descriptor)) {
    ig.push({ d: payload.descriptor, t: String(payload.thumb || ''), confirmed: false });
  }
  if (ig.length > 200) config.ai.ignored = ig.slice(-200);
  saveConfig();
  return { ok: true };
});
// Move one face from person `fromId` to a (possibly new) person `toName` — for
// "this isn't them, it's <someone else>" (digiKam-style reassign). The face keeps
// its descriptor so the target person learns from it; it lands confirmed.
ipcMain.handle('people:reassignFace', (_e, payload) => {
  const from = aiPeople().find((x) => x.id === (payload && payload.fromId));
  const idx = Number(payload && payload.index);
  const toName = String((payload && payload.toName) || '').trim();
  if (!from || !toName || !(idx >= 0 && idx < (from.faces || []).length)) return { ok: false };
  const face = from.faces[idx];
  from.faces.splice(idx, 1);
  if (from.thumb && !(from.faces || []).some((f) => f.t === from.thumb)) from.thumb = personCover(from);
  const people = aiPeople();
  let to = people.find((x) => x.name.toLowerCase() === toName.toLowerCase());
  if (!to) { to = { id: `pp${Date.now()}${Math.random().toString(36).slice(2, 6)}`, name: toName, faces: [], thumb: '', ts: Date.now() }; people.push(to); }
  migratePerson(to);
  if (!(to.faces || []).some((f) => f.d && faceDist(f.d, face.d) < 0.2)) to.faces.push({ d: face.d, t: face.t, confirmed: true });
  if (face.t && !to.thumb) to.thumb = face.t;
  if (to.faces.length > 80) to.faces = to.faces.slice(-80);
  saveConfig();
  return { ok: true, toId: to.id, toName: to.name };
});
ipcMain.handle('faces:listIgnored', () => aiIgnoredFaces().map((f, i) => ({ i, t: f.t || '' })));
ipcMain.handle('faces:unignore', (_e, idx) => { const ig = aiIgnoredFaces(); const i = Number(idx); if (i >= 0 && i < ig.length) { ig.splice(i, 1); saveConfig(); } return { ok: true }; });
ipcMain.handle('people:rename', (_e, payload) => { const p = aiPeople().find((x) => x.id === (payload && payload.id)); if (p) { p.name = String(payload.name || p.name).trim() || p.name; saveConfig(); } return { ok: true }; });
ipcMain.handle('people:delete', (_e, id) => { config.ai.people = aiPeople().filter((p) => p.id !== id); saveConfig(); return { ok: true }; });
// Merge `fromId` into `intoId` (combines faces, deletes the source) — for fixing
// the same person split across two names.
ipcMain.handle('people:merge', (_e, payload) => {
  const into = aiPeople().find((x) => x.id === (payload && payload.intoId));
  const from = aiPeople().find((x) => x.id === (payload && payload.fromId));
  if (!into || !from || into === from) return { ok: false };
  into.faces = [...(into.faces || []), ...(from.faces || [])].slice(-60);
  config.ai.people = aiPeople().filter((x) => x.id !== from.id);
  saveConfig();
  return { ok: true };
});
// Remove one face (a wrong crop) from a person.
ipcMain.handle('people:removeFace', (_e, payload) => {
  const p = aiPeople().find((x) => x.id === (payload && payload.id));
  const idx = Number(payload && payload.index);
  if (!p || !Array.isArray(p.faces) || !(idx >= 0 && idx < p.faces.length)) return { ok: false };
  p.faces.splice(idx, 1);
  if (p.thumb && !(p.faces || []).some((f) => f.t === p.thumb)) p.thumb = personCover(p);
  saveConfig();
  return { ok: true, faces: (p.faces || []).map((f, i) => ({ i, t: f.t || '' })) };
});
ipcMain.handle('people:setCover', (_e, payload) => {
  const p = aiPeople().find((x) => x.id === (payload && payload.id));
  const t = String((payload && payload.thumb) || '');
  if (!p || !t) return { ok: false };
  p.thumb = t; saveConfig(); return { ok: true };
});
// Given a face descriptor, return the best-matching known person (or null).
ipcMain.handle('people:match', (_e, payload) => {
  const desc = Array.isArray(payload && payload.descriptor) ? payload.descriptor : null;
  const threshold = Number(payload && payload.threshold) || 0.52;
  if (!desc) return { ok: true, match: null };
  // If the face is closest to an IGNORED face, treat it as a non-match (digiKam's
  // "Ignored" bin — stops suggesting people you've told it to skip).
  let ignD = Infinity;
  for (const f of aiIgnoredFaces()) { if (!f.d) continue; const dist = faceDist(desc, f.d); if (dist < ignD) ignD = dist; }
  let best = null; let bestD = Infinity;
  for (const p of aiPeople()) { for (const f of (p.faces || [])) { if (!f.d) continue; const dist = faceDist(desc, f.d); if (dist < bestD) { bestD = dist; best = p; } } }
  if (ignD < bestD && ignD <= threshold) return { ok: true, match: null, dist: bestD, ignored: true };
  return { ok: true, match: (best && bestD <= threshold) ? { id: best.id, name: best.name, dist: bestD } : null, dist: bestD };
});

// Extract a single large frame (960px wide) for face detection — much better than a
// contact-sheet grid where faces are tiny. Cached separately from the poster.
async function getFaceFrame(srcPath) {
  if (faceFrameCache.has(srcPath)) return faceFrameCache.get(srcPath);
  await acquirePoster();
  try {
    await ensureDir(THUMB_DIR);
    const tag = Buffer.from(srcPath).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
    const outPath = path.join(THUMB_DIR, `face_${tag}.jpg`);
    if (await fsp.access(outPath).then(() => true).catch(() => false)) {
      faceFrameCache.set(srcPath, outPath); return outPath;
    }
    const extract = (ss) => new Promise((resolve) => {
      const proc = killAfter(spawn(config.ffmpegPath, ['-y', '-ss', String(ss), '-i', srcPath, '-frames:v', '1', '-vf', 'scale=960:-2', outPath], { windowsHide: true }), 60000);
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
    let ok = await extract(1);
    if (!ok) ok = await extract(0);
    if (!ok) return null;
    faceFrameCache.set(srcPath, outPath);
    return outPath;
  } finally { releasePoster(); }
}

// A clip's frame as a data URL, for the renderer to run face detection on.
// Uses a single 960px-wide frame (not a grid) so face-api gets a big target.
ipcMain.handle('faces:image', async (_e, payload) => {
  const sourcePath = String((payload && payload.sourcePath) || '');
  if (!sourcePath) return { ok: false, error: 'No clip' };
  try {
    const framePath = await getFaceFrame(sourcePath);
    if (!framePath) return { ok: false, error: 'Could not read frame' };
    const b64 = (await fsp.readFile(framePath)).toString('base64');
    return { ok: true, dataUrl: `data:image/jpeg;base64,${b64}` };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Sample frames ACROSS THE WHOLE CLIP for face detection (digiKam-style "scan the
// whole video"). N = ceil(duration / interval), capped at maxFrames, spread evenly.
// Fast `-ss`-before-`-i` keyframe seeking keeps it quick even on big 4K GoPro clips.
async function getFaceFrames(srcPath, interval, maxFrames) {
  let durationSec = 0;
  try { durationSec = (await probeMeta(srcPath)).durationSec || 0; } catch { /* ignore */ }
  if (!durationSec || !isFinite(durationSec) || durationSec < interval) {
    const one = await getFaceFrame(srcPath);
    return one ? [one] : [];
  }
  const N = Math.max(1, Math.min(maxFrames, Math.ceil(durationSec / interval)));
  await ensureDir(THUMB_DIR);
  const tag = Buffer.from(srcPath).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  const jobs = [];
  for (let i = 0; i < N; i += 1) {
    const ss = durationSec * ((i + 0.5) / N);
    const out = path.join(THUMB_DIR, `fscan_${tag}_${i}.jpg`);
    jobs.push((async () => {
      await acquirePoster();
      try {
        const ok = await new Promise((res) => {
          const p = killAfter(spawn(config.ffmpegPath, ['-y', '-ss', String(ss), '-i', srcPath, '-frames:v', '1', '-vf', 'scale=1100:-2', out], { windowsHide: true }), 60000);
          p.on('error', () => res(false)); p.on('close', (c) => res(c === 0));
        });
        return ok ? out : null;
      } finally { releasePoster(); }
    })());
  }
  return (await Promise.all(jobs)).filter(Boolean);
}

// Returns an ARRAY of frame data-URLs spanning the clip, for whole-clip face scan.
ipcMain.handle('faces:frames', async (_e, payload) => {
  const sourcePath = String((payload && payload.sourcePath) || '');
  if (!sourcePath) return { ok: false, error: 'No clip' };
  // A PHOTO is its own single "frame" — hand the image straight to face detection
  // (no ffmpeg frame extraction). This is what lets face recognition run on stills.
  if (isImagePath(sourcePath)) {
    try {
      const ext = path.extname(sourcePath).slice(1).toLowerCase();
      const mime = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
      const b64 = (await fsp.readFile(sourcePath)).toString('base64');
      return { ok: true, frames: [`data:${mime};base64,${b64}`] };
    } catch (err) { return { ok: false, error: err.message || String(err) }; }
  }
  const ai = config.ai || {};
  const interval = Math.max(1, Math.min(15, Number(payload && payload.interval) || Number(ai.faceInterval) || 2));
  const maxFrames = Math.max(1, Math.min(120, Number(payload && payload.maxFrames) || Number(ai.faceMaxFrames) || 24));
  try {
    const paths = await getFaceFrames(sourcePath, interval, maxFrames);
    if (!paths.length) return { ok: false, error: 'Could not read frames' };
    const frames = [];
    for (const fp of paths) {
      try { const b64 = (await fsp.readFile(fp)).toString('base64'); frames.push(`data:image/jpeg;base64,${b64}`); } catch { /* skip */ }
      fsp.unlink(fp).catch(() => {});   // temp scan frames — don't keep them around
    }
    return { ok: true, frames };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

ipcMain.handle('ai:consolidateMemories', async (_evt) => {
  const ai = config.ai || (config.ai = {});
  const mems = (ai.memories || []).filter((m) => m && m.text);
  if (mems.length < 2) return { ok: false, error: 'Not enough memories to group' };
  if (!aiTextModel()) return { ok: false, error: 'No model selected' };
  const list = mems.map((m, i) => `${i + 1}. ${m.text}${m.example ? ` (e.g. ${m.example})` : ''}`).join('\n');
  try {
    const prompt = `Here is a list of preference rules for an AI that names and organizes video clips. Many are tiny or overlapping. Merge closely-related rules into fewer, well-grouped rules; combine duplicates; keep genuinely distinct rules separate. PRESERVE every concrete requirement and keep one good example per rule. Prefer a handful of clear grouped rules over many tiny ones. Reply STRICT JSON only: {"memories":[{"rule":"...","example":"..."}]}.\n\nRULES:\n${list}`;
    const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.2, timeout: 180000 }));
    const merged = aiExtractRules((o && o.memories !== undefined) ? o.memories : o);
    if (!merged.length) return { ok: false, error: 'No result from the model' };
    return { ok: true, proposed: merged, before: mems.length };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Replace the whole memory list (used after the user approves a consolidation).
ipcMain.handle('ai:replaceMemories', (evt, payload) => {
  const rules = aiExtractRules(Array.isArray(payload) ? payload : (payload && payload.rules) || []).slice(0, 100);
  const ai = config.ai || (config.ai = {});
  const now = Date.now();
  ai.memories = rules.map((r) => ({ id: newMemId(), text: r.text, example: r.example || '', ts: now }));
  saveConfig();
  try { evt.sender.send('ai:memory-updated', { memories: ai.memories }); } catch { /* ignore */ }
  return { ok: true, memories: ai.memories };
});

// --- In-app feedback log (Help → Feedback, or right-click → Report feedback) ---
// Captured to a JSONL file in the app data folder so both the local AI and Claude
// can read it while the app is being built. Export to CSV or an AI-bundled summary.
const FEEDBACK_FILE = path.join(path.dirname(USER_CONFIG), 'feedback.jsonl');
function readFeedback() {
  try {
    return fs.readFileSync(FEEDBACK_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
ipcMain.handle('feedback:add', (_evt, payload) => {
  const text = String((payload && payload.text) || '').trim();
  const srcImgs = Array.isArray(payload && payload.images) ? payload.images : [];
  if (!text && !srcImgs.length) return { ok: false, error: 'Empty feedback' };
  // Copy any attached screenshots into the app data folder so the log is self-contained.
  const images = [];
  if (srcImgs.length) {
    const imgDir = path.join(path.dirname(USER_CONFIG), 'feedback-images');
    try { fs.mkdirSync(imgDir, { recursive: true }); } catch { /* ignore */ }
    let n = 0;
    for (const src of srcImgs.slice(0, 8)) {
      try {
        const dst = path.join(imgDir, `${Date.now().toString(36)}_${n += 1}${path.extname(src) || '.png'}`);
        fs.copyFileSync(src, dst); images.push(dst);
      } catch { /* skip unreadable image */ }
    }
  }
  const rec = { ts: new Date().toISOString(), section: String((payload && payload.section) || '').slice(0, 200), context: String((payload && payload.context) || '').slice(0, 500), text, images };
  try { fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(rec) + '\n'); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, file: FEEDBACK_FILE };
});
ipcMain.handle('feedback:list', () => ({ ok: true, items: readFeedback(), file: FEEDBACK_FILE }));
// Return all feedback as ready-to-copy TEXT (plain list, or AI-refined markdown).
ipcMain.handle('feedback:text', async (_evt, payload) => {
  const refine = !!(payload && payload.refine);
  const items = readFeedback();
  if (!items.length) return { ok: false, error: 'No feedback recorded yet' };
  const plain = items.map((it, i) => `${i + 1}. [${it.section || 'general'}] ${it.text}${it.context ? ` (${it.context})` : ''}`).join('\n');
  if (!refine) return { ok: true, text: plain };
  if (!aiTextModel()) return { ok: false, error: 'Select an AI model first (or copy the raw list)' };
  try {
    const prompt = `These are raw feedback notes a developer left while building a desktop app (each tagged with the UI section). Group them by theme/section and rewrite as a clean, prioritized markdown summary with headings and bullets. Keep every concrete request; merge duplicates. Notes:\n${plain}`;
    const md = await ollamaGenerate(aiTextModel(), prompt, { temperature: 0.3, timeout: 180000 });
    return { ok: true, text: `# Feedback summary (${items.length} notes)\n\n${md}` };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});
// Write text to the system clipboard (reliable; navigator.clipboard is flaky on file://).
ipcMain.handle('clipboard:write', (_evt, text) => { try { require('electron').clipboard.writeText(String(text || '')); return true; } catch { return false; } });
ipcMain.handle('feedback:export', async (_evt, payload) => {
  const refine = !!(payload && payload.refine);
  const items = readFeedback();
  if (!items.length) return { ok: false, error: 'No feedback recorded yet' };
  const dir = path.dirname(USER_CONFIG);
  if (refine) {
    if (!aiTextModel()) return { ok: false, error: 'Select an AI model first (or export as CSV)' };
    try {
      const lines = items.map((it, i) => `${i + 1}. [${it.section || 'general'}] ${it.text}`).join('\n');
      const prompt = `These are raw feedback notes a developer left while building a desktop app (each tagged with the UI section it's about). Group them by theme/section and rewrite as a clean, prioritized markdown summary with headings and bullet points. Keep every concrete request; merge duplicates. Notes:\n${lines}`;
      const md = await ollamaGenerate(aiTextModel(), prompt, { temperature: 0.3, timeout: 180000 });
      const out = path.join(dir, 'feedback-summary.md');
      fs.writeFileSync(out, `# Feedback summary (${items.length} notes)\n\n${md}\n`, 'utf8');
      return { ok: true, path: out };
    } catch (err) { return { ok: false, error: err.message || String(err) }; }
  }
  const esc = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
  const rows = ['ts,section,context,text', ...items.map((it) => [esc(it.ts), esc(it.section), esc(it.context), esc(it.text)].join(','))];
  const out = path.join(dir, 'feedback.csv');
  try { fs.writeFileSync(out, rows.join('\r\n'), 'utf8'); } catch (err) { return { ok: false, error: err.message }; }
  return { ok: true, path: out };
});

// Default playback speed for the in-app <video> previews (persisted).
ipcMain.handle('player:info', () => ({ defaultSpeed: Number(config.defaultSpeed) || 1 }));
ipcMain.handle('player:setSpeed', (_evt, speed) => {
  config.defaultSpeed = Number(speed) || 1;
  saveConfig();
  return config.defaultSpeed;
});

ipcMain.handle('subjects:get', () => config.subjects || []);

ipcMain.handle('subjects:add', (_evt, name) => {
  const s = String(name || '').trim();
  config.subjects = config.subjects || [];
  if (s && !config.subjects.includes(s)) {
    config.subjects.push(s);
    config.subjects.sort((a, b) => a.localeCompare(b));
    saveConfig();
  }
  return config.subjects;
});

ipcMain.handle('subjects:remove', (_evt, name) => {
  config.subjects = (config.subjects || []).filter((s) => s !== name);
  saveConfig();
  return config.subjects;
});

// Locations (e.g. a named lawn/client "dusty") — remembered + autocompleted like
// subjects, embedded into XMP keywords at Finalize.
ipcMain.handle('locations:get', () => config.locations || []);
ipcMain.handle('locations:add', (_evt, name) => {
  const s = String(name || '').trim();
  config.locations = config.locations || [];
  if (s && !config.locations.includes(s)) {
    config.locations.push(s);
    config.locations.sort((a, b) => a.localeCompare(b));
    saveConfig();
  }
  return config.locations;
});

// Descriptions are stored with usage counts and returned most-used first
// ("smart indexed") so autocomplete favours what you actually type a lot.
ipcMain.handle('descriptions:get', () => {
  const d = config.descriptions || {};
  return Object.keys(d).sort((a, b) => (d[b] - d[a]) || a.localeCompare(b));
});

ipcMain.handle('descriptions:add', (_evt, value) => {
  const v = String(value || '').trim();
  if (v) {
    config.descriptions = config.descriptions || {};
    config.descriptions[v] = (config.descriptions[v] || 0) + 1;
    saveConfig();
  }
  return true;
});

// Categories & Projects — remembered value history for the organizing fields
// (used for metadata + the Compressed/<Category>/<Project>/ folder structure).
function makeListHandlers(key) {
  ipcMain.handle(`${key}:get`, () => config[key] || []);
  ipcMain.handle(`${key}:add`, (_evt, name) => {
    const s = String(name || '').trim();
    config[key] = config[key] || [];
    if (s && !config[key].includes(s)) {
      config[key].push(s);
      config[key].sort((a, b) => a.localeCompare(b));
      saveConfig();
    }
    return config[key];
  });
  ipcMain.handle(`${key}:remove`, (_evt, name) => {
    config[key] = (config[key] || []).filter((s) => s !== name);
    saveConfig();
    return config[key];
  });
}
makeListHandlers('categories');
makeListHandlers('projects');

// Custom organizing fields (the user-managed taxonomy) + their value history.
ipcMain.handle('fields:get', () => config.organizeFields);
ipcMain.handle('fields:set', (_evt, list) => {
  config.organizeFields = normalizeOrganizeFields(list);
  for (const f of config.organizeFields) if (!Array.isArray(config.fieldHistory[f.id])) config.fieldHistory[f.id] = [];
  saveConfig();
  return config.organizeFields;
});
ipcMain.handle('fieldHistory:get', () => config.fieldHistory || {});
ipcMain.handle('fieldHistory:add', (_evt, payload) => {
  const id = String((payload && payload.id) || '').trim().toLowerCase();
  const value = String((payload && payload.value) || '').trim();
  if (!id || !value) return config.fieldHistory[id] || [];
  if (!Array.isArray(config.fieldHistory[id])) config.fieldHistory[id] = [];
  if (!config.fieldHistory[id].includes(value)) {
    config.fieldHistory[id].push(value);
    config.fieldHistory[id].sort((a, b) => a.localeCompare(b));
    saveConfig();
  }
  return config.fieldHistory[id];
});
ipcMain.handle('fieldHistory:remove', (_evt, payload) => {
  const id = String((payload && payload.id) || '').trim().toLowerCase();
  const value = String((payload && payload.value) || '');
  if (Array.isArray(config.fieldHistory[id])) {
    config.fieldHistory[id] = config.fieldHistory[id].filter((v) => v !== value);
    saveConfig();
  }
  return config.fieldHistory[id] || [];
});

// Rename drafts — persist in-progress naming (date/subject/description) keyed by
// a per-clip fingerprint (name + size) so work survives an app restart, not just
// in-session navigation. Pruned by age + count so the store can't grow forever.

// In-app diagnostics — reports what THIS process actually sees (env, resolved
// paths, raw file bytes, parsed drafts). Surfaced via Help → Copy diagnostics so
// the exact runtime view can be copied out, since external inspection of the
// same paths has been disagreeing with what the app reads.
ipcMain.handle('debug:info', () => {
  const safe = (fn) => { try { return fn(); } catch (e) { return `ERR: ${e.message}`; } };
  const info = {
    now: new Date().toISOString(),
    pid: process.pid,
    appName: safe(() => app.getName()),
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    dirname: __dirname,
    env_APPDATA: process.env.APPDATA || '(unset)',
    env_LOCALAPPDATA: process.env.LOCALAPPDATA || '(unset)',
    getPath_appData: safe(() => app.getPath('appData')),
    getPath_userData: safe(() => app.getPath('userData')),
    ROAMING_DIR,
    USER_CONFIG,
    BUNDLED_CONFIG,
    userConfigExists: safe(() => fs.existsSync(USER_CONFIG)),
    inMemoryDraftKeys: Object.keys(config.renameDrafts || {}),
    currentDraftKeys: safe(() => Object.keys(currentDrafts()))
  };
  try {
    const raw = fs.readFileSync(USER_CONFIG, 'utf8');
    info.userConfigBytes = raw.length;
    info.userConfigMtime = safe(() => fs.statSync(USER_CONFIG).mtime.toISOString());
    const pj = JSON.parse(raw);
    info.userConfigDraftKeys = Object.keys(pj.renameDrafts || {});
  } catch (e) { info.userConfigReadError = e.message; }
  try {
    const braw = fs.readFileSync(BUNDLED_CONFIG, 'utf8');
    info.bundledDraftKeys = Object.keys((JSON.parse(braw).renameDrafts) || {});
  } catch (e) { info.bundledReadError = e.message; }
  // Other USB-app config.json folders that might be shadowing this one.
  try {
    const roam = process.env.APPDATA || '';
    info.siblingConfigs = ['USB SD Auto-Action', 'usb-auto-action'].map((n) => {
      const p = path.join(roam, n, 'config.json');
      let k = '(missing)';
      try { k = Object.keys((JSON.parse(fs.readFileSync(p, 'utf8')).renameDrafts) || {}).length; } catch { /* missing */ }
      return `${n}: ${fs.existsSync(p) ? `exists drafts=${k}` : 'missing'}`;
    });
  } catch (e) { info.siblingError = e.message; }
  return info;
});

// Merge the freshest on-disk renameDrafts into our in-memory copy, then return
// it. Reading fresh means a draft written by another instance is still seen.
function currentDrafts() {
  const fresh = readConfigFresh();
  if (fresh && fresh.renameDrafts && typeof fresh.renameDrafts === 'object') {
    config.renameDrafts = fresh.renameDrafts;
    // Adopt other fresh fields too so a later save can't write stale settings.
    for (const k of Object.keys(fresh)) if (k !== 'renameDrafts') config[k] = fresh[k];
  }
  if (!config.renameDrafts || typeof config.renameDrafts !== 'object') config.renameDrafts = {};
  return config.renameDrafts;
}

ipcMain.handle('drafts:get', () => currentDrafts());

// ADD/UPDATE-only, and a NO-OP when the incoming map carries no real data. This
// is the crucial guard: a session showing blank fields auto-saves an empty map,
// which now writes NOTHING — so it can never wipe previously-saved names.
// Removal happens solely via drafts:clear (when footage is copied).
ipcMain.handle('drafts:save', (_evt, map) => {
  if (!map || typeof map !== 'object') return false;
  // A draft carries real data if ANY of its values (besides the timestamp) is
  // non-empty — covers subject/description/date + any custom organizing field.
  const hasData = (v) => v && Object.entries(v).some(([k, val]) => k !== 'ts' && val);
  const additions = Object.entries(map).filter(([, v]) => hasData(v));
  if (!additions.length) return true;
  const drafts = currentDrafts();
  const now = Date.now();
  for (const [k, v] of additions) drafts[k] = { ...v, ts: now };
  // Prune: drop entries older than 60 days, then cap to the 4000 most recent.
  const MAX_AGE = 60 * 24 * 3600 * 1000;
  let entries = Object.entries(drafts).filter(([, v]) => v && (now - (v.ts || 0)) < MAX_AGE);
  if (entries.length > 1000) {   // each draft is ~230B; 1000 is plenty and keeps config small
    entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    entries = entries.slice(0, 1000);
  }
  config.renameDrafts = Object.fromEntries(entries);
  saveConfig();
  return true;
});

// Clear drafts: the given keys (consumed by a copy), or all of them.
ipcMain.handle('drafts:clear', (_evt, keys) => {
  const drafts = currentDrafts();
  if (Array.isArray(keys) && keys.length) {
    for (const k of keys) delete drafts[k];
  } else {
    config.renameDrafts = {};
  }
  saveConfig();
  return true;
});

// ---------------------------------------------------------------------------
// Version history / save points. A "version" is a full snapshot of every clip's
// editable naming fields (same shape as a draft map), captured manually or
// automatically before an AI run, so the user can roll back. Persisted in config
// as a newest-first array; capped so it can't grow without bound.
// ---------------------------------------------------------------------------
function currentVersions() {
  if (!Array.isArray(config.renameVersions)) config.renameVersions = [];
  return config.renameVersions;
}
ipcMain.handle('versions:get', () => currentVersions());
ipcMain.handle('versions:save', (_evt, entry) => {
  if (!entry || typeof entry !== 'object' || !entry.map || typeof entry.map !== 'object') return currentVersions();
  const list = currentVersions();
  list.unshift({
    id: String(entry.id || `v${Date.now()}`),
    ts: Number(entry.ts) || Date.now(),
    label: String(entry.label || 'Save point').slice(0, 120),
    auto: !!entry.auto,
    count: Number(entry.count) || 0,
    map: entry.map
  });
  if (list.length > 12) list.length = 12;   // each save-point's map is ~60KB — keep few
  config.renameVersions = list;
  saveConfig();
  return list;
});
ipcMain.handle('versions:delete', (_evt, id) => {
  config.renameVersions = currentVersions().filter((v) => v && v.id !== id);
  saveConfig();
  return config.renameVersions;
});
ipcMain.handle('versions:clear', () => { config.renameVersions = []; saveConfig(); return []; });

// ---------------------------------------------------------------------------
// Metadata-by-final-filename store. renameDrafts is keyed by the SOURCE clip
// (name+size), but compressed files are re-encoded — different size, sometimes a
// different container — so the draft key can't match them. When a copy finishes,
// the renderer persists a record keyed by the clip's FINAL filename (e.g.
// 2026-06-01_vlog_josiah_v1.mp4) so the Finalize step can match the compressed
// file by name and write its metadata. Keyed lower-cased for robust matching.
// ---------------------------------------------------------------------------
function currentFinalMeta() {
  const fresh = readConfigFresh();
  if (fresh && fresh.finalMeta && typeof fresh.finalMeta === 'object') {
    config.finalMeta = fresh.finalMeta;
    for (const k of Object.keys(fresh)) if (k !== 'finalMeta') config[k] = fresh[k];
  }
  if (!config.finalMeta || typeof config.finalMeta !== 'object') config.finalMeta = {};
  return config.finalMeta;
}

ipcMain.handle('finalMeta:save', (_evt, map) => {
  if (!map || typeof map !== 'object') return false;
  const incoming = Object.entries(map).filter(([k, v]) => k && v && typeof v === 'object');
  if (!incoming.length) return true;
  const store = currentFinalMeta();
  const now = Date.now();
  for (const [name, v] of incoming) {
    // Store all provided fields generically (subject/description/date + whatever
    // custom organizing fields the clip carried), plus the keyword list.
    const rec = { ts: now };
    for (const [k, val] of Object.entries(v)) {
      if (k === 'ts') continue;
      if (k === 'keywords' || k === 'people' || k === 'peopleAuto' || k === 'tags') rec[k] = Array.isArray(val) ? val : [];
      else rec[k] = (val == null ? '' : String(val));
    }
    if (!Array.isArray(rec.keywords)) rec.keywords = [];
    store[String(name).toLowerCase()] = rec;
  }
  // Prune: drop entries older than 180 days, then cap to the 5000 most recent.
  const MAX_AGE = 180 * 24 * 3600 * 1000;
  let entries = Object.entries(store).filter(([, v]) => v && (now - (v.ts || 0)) < MAX_AGE);
  if (entries.length > 5000) {
    entries.sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
    entries = entries.slice(0, 5000);
  }
  config.finalMeta = Object.fromEntries(entries);
  saveConfig();
  return true;
});

// Find every stored clip (organized finalMeta + in-progress drafts) tagged with a person
// name — powers the "you changed X, re-tag N clips?" offer after a rename/merge/reassign.
ipcMain.handle('clips:findByPerson', (_evt, name) => {
  const nm = String(name || '').trim();
  if (!nm) return { ok: true, finalMeta: [], drafts: [], total: 0 };
  const has = (rec) => rec && ((Array.isArray(rec.people) && rec.people.includes(nm)) || (Array.isArray(rec.peopleAuto) && rec.peopleAuto.includes(nm)));
  const fm = currentFinalMeta(); const fmHits = Object.keys(fm).filter((k) => has(fm[k]));
  const dr = currentDrafts(); const drHits = Object.keys(dr).filter((k) => has(dr[k]));
  return { ok: true, finalMeta: fmHits, drafts: drHits, total: fmHits.length + drHits.length };
});

// Re-tag a person across all stored clips: rename `from` -> `to` in people/peopleAuto
// (drop it if `to` is empty) and swap the name inside subject/description text too — the
// cheap "re-tag + re-name" offered after you change a face/person. Returns how many
// records changed. Never touches or deletes the media files themselves.
ipcMain.handle('clips:retagPerson', (_evt, payload) => {
  const from = String((payload && payload.from) || '').trim();
  const to = String((payload && payload.to) || '').trim();   // '' => remove the tag
  if (!from) return { ok: false, changed: 0 };
  const fixArr = (arr) => {
    if (!Array.isArray(arr) || !arr.includes(from)) return { arr, changed: false };
    const out = [...new Set(arr.map((n) => (n === from ? to : n)).filter(Boolean))];
    return { arr: out, changed: true };
  };
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fixText = (s) => (to && typeof s === 'string') ? s.replace(new RegExp(`\\b${esc}\\b`, 'g'), to) : s;
  let changed = 0;
  const apply = (store) => {
    for (const k of Object.keys(store)) {
      const rec = store[k]; if (!rec) continue;
      const p = fixArr(rec.people); const pa = fixArr(rec.peopleAuto);
      if (p.changed || pa.changed) {
        if (p.changed) rec.people = p.arr;
        if (pa.changed) rec.peopleAuto = pa.arr;
        rec.subject = fixText(rec.subject);
        rec.description = fixText(rec.description);
        changed += 1;
      }
    }
  };
  apply(currentFinalMeta());
  apply(currentDrafts());
  saveConfig();
  return { ok: true, changed };
});

ipcMain.handle('finalMeta:get', () => currentFinalMeta());

