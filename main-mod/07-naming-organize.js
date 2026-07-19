// ---------------------------------------------------------------------------
// MEASURED camera motion — vision models guess motion poorly from a contact
// sheet, so we measure it and feed it to the AI as ground truth. For GoPro clips
// we read the real GYRO from the embedded GPMF telemetry stream (no video decode);
// otherwise we fall back to mean frame-difference over sampled frames.
// ---------------------------------------------------------------------------
const motionCache = new Map();   // srcPath -> string ('' = unknown)
let motionCounter = 0;
// Single spawn-and-capture-stdout helper. Returns the captured stdout as a STRING;
// the '' empty-string sentinel means "no usable output" (spawn threw, timed out, errored,
// or — with onlyOnSuccess — the process exited non-zero). Callers test `if (out)`.
function runCapture(cmd, args, { timeoutMs = 20000, onlyOnSuccess = false, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let out = ''; let done = false;
    let proc; try { proc = spawn(cmd, args, { windowsHide: true }); } catch { resolve(''); return; }
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => { treeKill(proc); finish(''); }, timeoutMs);
    // Cap the buffer so a runaway/misdirected process can't balloon main-process heap.
    proc.stdout.on('data', (d) => { out += d.toString(); if (out.length > maxBytes) { treeKill(proc); finish(onlyOnSuccess ? '' : out); } });
    proc.on('error', () => finish(''));
    // onlyOnSuccess: discard partial output from a non-zero exit (e.g. ffprobe failure).
    proc.on('close', (code) => finish(onlyOnSuccess && code !== 0 ? '' : out));
  });
}

// STREAMING spawn — for long jobs whose stdout is parsed line-by-line as it runs (vs
// runCapture, which buffers then returns). Streams each stdout line to onLine, captures
// stderr, and supports an IDLE watchdog: if the child produces NO output for idleMs it's
// assumed hung (e.g. an MTP CopyHere stuck in a COM call on a yanked phone) and killed —
// unlike killAfter's fixed deadline, the idle timer RESETS on every chunk, so a genuinely
// long-but-progressing transfer is never killed. Resolves {code, out, err, timedOut}.
function streamSpawn(cmd, args, { onLine, onData, idleMs = 0, timeoutMs = 0, env, maxBytes = 8 * 1024 * 1024, abortCheck = null } = {}) {
  return new Promise((resolve) => {
    let proc;
    // Merge env INTO process.env (don't replace it) so a caller passing a couple of extra
    // vars can't accidentally drop PATH/SystemRoot and make the child fail to launch.
    try { proc = spawn(cmd, args, { windowsHide: true, env: env ? { ...process.env, ...env } : process.env }); }
    catch (e) { resolve({ code: -1, out: '', err: (e && e.message) || String(e), timedOut: false }); return; }
    let out = ''; let err = ''; let buf = ''; let done = false; let timedOut = false; let aborted = false;
    let idleTimer = null; let hardTimer = null; let abortTimer = null;
    const kill = () => { treeKill(proc); };   // tear down the whole tree (COM/conhost/children)
    const resetIdle = () => { if (!idleMs) return; clearTimeout(idleTimer); idleTimer = setTimeout(() => { timedOut = true; kill(); }, idleMs); };
    const finish = (code) => {
      if (done) return; done = true;
      clearTimeout(idleTimer); clearTimeout(hardTimer); clearInterval(abortTimer);
      if (onLine && buf) onLine(buf);   // flush a trailing partial line
      resolve({ code, out, err, timedOut, aborted });
    };
    if (timeoutMs) hardTimer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    // Cooperative cancel: when the caller's abort flag flips, tear the child down. Whatever file the
    // child was mid-copy on is left truncated — but the phone:pull staging gate declines a file short
    // of its source size, so a cancelled transfer never finalizes a partial clip. `aborted` lets the
    // caller tell a user-cancel apart from a genuine timeout/crash.
    if (typeof abortCheck === 'function') abortTimer = setInterval(() => { try { if (abortCheck()) { aborted = true; kill(); } } catch { /* ignore */ } }, 400);
    resetIdle();
    proc.stdout.on('data', (d) => {
      const s = d.toString(); if (out.length < maxBytes) out += s; resetIdle();
      if (onData) onData(s);
      // Cap buf so a stream with no newline can't grow unbounded (keep the tail).
      if (onLine) { buf += s; let nl; while ((nl = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, nl).replace(/\r$/, '')); buf = buf.slice(nl + 1); } if (buf.length > maxBytes) buf = buf.slice(-maxBytes); }
    });
    proc.stderr.on('data', (d) => { if (err.length < maxBytes) err += d.toString(); resetIdle(); });
    proc.on('error', (e) => { err += (e && e.message) || String(e); finish(-1); });
    proc.on('close', (code) => finish(code));
  });
}
function classifyGyro(meanMag) {
  // A NaN mean (undecodable gyro samples) fails EVERY `<` test below and falls through to
  // the max-motion bucket, mislabelling a locked-off tripod shot as "fast action" and
  // feeding that lie to the AI namer. No reading beats a confidently wrong one.
  if (!Number.isFinite(meanMag)) return '';
  if (meanMag < 0.05) return 'locked off / static (tripod or set down)';
  if (meanMag < 0.5) return 'handheld with small movement';
  if (meanMag < 1.5) return 'moving — panning, walking or following the subject';
  return 'lots of movement — fast action';
}
// Find the GoPro GPMF telemetry stream index ('gpmd' codec tag), or -1.
async function gpmfIndex(srcPath) {
  const out = await runCapture(config.ffprobePath, ['-v', 'error', '-show_entries', 'stream=index,codec_tag_string', '-of', 'csv=p=0', srcPath], { timeoutMs: 15000 });
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split(',');
    if ((parts[1] || '').trim() === 'gpmd') return Number(parts[0]);
  }
  return -1;
}
async function detectMotionGoPro(srcPath) {
  const idx = await gpmfIndex(srcPath);
  if (idx < 0) return '';
  await ensureDir(THUMB_DIR);
  motionCounter += 1;
  const binPath = path.join(THUMB_DIR, `gpmf_${motionCounter}.bin`);
  // Stream-copy ONLY the telemetry track — fast even on multi-GB 4K (no decode).
  const ok = await new Promise((resolve) => {
    const p = killAfter(spawn(config.ffmpegPath, ['-y', '-i', srcPath, '-codec', 'copy', '-map', `0:${idx}`, '-f', 'rawvideo', binPath], { windowsHide: true }), 90000);
    p.on('error', () => resolve(false));
    p.on('close', (c) => resolve(c === 0));
  });
  if (!ok) return '';
  try {
    const raw = await fsp.readFile(binPath);
    // eslint-disable-next-line global-require
    const gt = require('gopro-telemetry');
    const data = await new Promise((resolve) => {
      try {
        gt({ rawData: raw, timing: { frameDuration: 1 / 30, start: new Date(), samples: [] } }, { stream: ['GYRO'], repeatSticky: false },
          (...args) => resolve(args.find((a) => a && typeof a === 'object' && Object.keys(a).some((k) => a[k] && a[k].streams)) || null));
      } catch { resolve(null); }
    });
    if (!data) return '';
    const dev = Object.keys(data).find((k) => data[k] && data[k].streams && data[k].streams.GYRO);
    const samples = dev ? (data[dev].streams.GYRO.samples || []) : [];
    if (!samples.length) return '';
    let sum = 0; let n = 0;
    for (const s of samples) { const v = s.value || []; sum += Math.hypot(v[0] || 0, v[1] || 0, v[2] || 0); n += 1; }
    return n ? `${classifyGyro(sum / n)} (from the camera's motion sensor)` : '';
  } catch { return ''; }
  finally { try { fs.rmSync(binPath, { force: true }); } catch { /* ignore */ } }
}
// Fallback: mean absolute frame-difference (mafd) over sampled small frames via
// ffmpeg scdet → coarse static/moving signal for non-GoPro footage.
async function detectMotionFrames(srcPath) {
  let durationSec = 0;
  try { durationSec = (await probeMeta(srcPath)).durationSec || 0; } catch { /* ignore */ }
  if (!durationSec || !isFinite(durationSec)) return '';
  await acquirePoster();
  try {
    await ensureDir(THUMB_DIR);
    motionCounter += 1;
    const tag = `mo${motionCounter}`;
    const N = 14; let k = 0;
    for (let i = 0; i < N; i += 1) {
      const ss = Math.max(0, durationSec * ((i + 0.5) / N));
      const fp = path.join(THUMB_DIR, `${tag}_${String(k + 1).padStart(3, '0')}.jpg`);
      // eslint-disable-next-line no-await-in-loop
      const ok = await extractFrame(srcPath, ss, fp, '160:-2');
      if (ok) k += 1;
    }
    if (k < 3) return '';
    const metaFile = path.join(THUMB_DIR, `${tag}_meta.txt`);
    await new Promise((r) => { const p = killAfter(spawn(config.ffmpegPath, ['-y', '-i', path.join(THUMB_DIR, `${tag}_%03d.jpg`), '-vf', `scdet=s=1,metadata=print:file=${metaFile}`, '-f', 'null', '-'], { windowsHide: true }), 90000); p.on('error', () => r()); p.on('close', () => r()); });
    let mafds = [];
    try { mafds = (await fsp.readFile(metaFile, 'utf8')).split(/\r?\n/).map((l) => { const m = l.match(/lavfi\.scd\.mafd=([\d.]+)/); return m ? Number(m[1]) : null; }).filter((x) => x != null); } catch { /* ignore */ }
    for (let i = 1; i <= k; i += 1) { try { fs.rmSync(path.join(THUMB_DIR, `${tag}_${String(i).padStart(3, '0')}.jpg`), { force: true }); } catch { /* ignore */ } }
    try { fs.rmSync(metaFile, { force: true }); } catch { /* ignore */ }
    if (!mafds.length) return '';
    const mean = mafds.reduce((a, b) => a + b, 0) / mafds.length;
    const cls = mean < 2 ? 'mostly static, little change between frames' : mean < 8 ? 'some movement / the scene changes moderately' : 'a lot of change between frames — moving camera or multiple shots';
    return `${cls} (estimated from the frames)`;
  } finally { releasePoster(); }
}
async function detectMotion(srcPath) {
  if (motionCache.has(srcPath)) return motionCache.get(srcPath);
  let result = '';
  try { result = await detectMotionGoPro(srcPath); } catch { result = ''; }
  if (!result) { try { result = await detectMotionFrames(srcPath); } catch { result = ''; } }
  motionCache.set(srcPath, result);
  return result;
}

ipcMain.handle('ai:status', async () => {
  try {
    const res = await ollamaFetch('/api/tags', {}, 4000);
    if (!res.ok) return { running: false, error: `HTTP ${res.status}`, models: [], vision: [] };
    const j = await res.json();
    const names = (j.models || []).map((m) => m.name).filter(Boolean);
    const vision = [];
    for (const n of names) { if (await ollamaModelVision(n)) vision.push(n); }
    return { running: true, endpoint: aiEndpoint(), models: names, vision };
  } catch (err) {
    return { running: false, error: err.message || String(err), models: [], vision: [] };
  }
});

// Vision guidance + an optional "what the user told us" note injected as ground truth.
function aiContextBlock(context) {
  const c = String(context || '').trim();
  // The note helps IDENTIFY things (who the people are, what the shoot is) and
  // resolve ambiguity — but it must NOT be copied into the fields. The #1 failure
  // mode is the model reshuffling the note's words (esp. names) into the
  // description, so we forbid that explicitly.
  return c ? `\nBACKGROUND from the videographer (for understanding only, NOT text to reuse): "${c}". Use it only to identify the subject/people or settle what's ambiguous in the frames. NEVER copy these words — especially people's names — into the description. The description must describe what is VISIBLY happening in the footage, not restate this note.` : '';
}
// Measured camera-motion fact (gyro or frame-diff) injected as ground truth.
function aiMotionBlock(motion) {
  const m = String(motion || '').trim();
  return m ? `\nCamera motion (MEASURED, not guessed): ${m}. Trust this over the frames when judging movement and shot type.` : '';
}
// Recognized people (from FACE recognition — reliable identities, unlike the free
// note). The model MAY use these exact names in the subject/description.
function aiPeopleBlock(people) {
  const ppl = uniqStrings(Array.isArray(people) ? people : []).filter(Boolean);
  if (!ppl.length) return '';
  const first = ppl[0].toLowerCase();
  return `\nRecognized people in this clip (confirmed by face recognition — reliable, unlike the background note): ${ppl.join(', ')}. USE the real name(s): wherever you would otherwise write a generic word like "person", "man", "woman", "guy", "kid", "someone", replace it with the recognized name. Put the name in the subject or description when a person is the focus (e.g. "${first}-pushups", "${first}-carrying-firewood", not "person-carrying-object"). Action first, then the name.`;
}
// ---- Deterministic naming clean-up -----------------------------------------
// Weak local models still emit prose ("a man in a car", "2 people walking") even
// when told not to. We NEVER trust the model to obey — every subject/description
// is passed through here so the result is always clean hyphen-keywords AND uses
// the recognized person's real name instead of a generic word. This is what makes
// names actually show up; the prompt is only a hint, this is the guarantee.
const NAME_STOPWORDS = new Set(['a', 'an', 'the', 'is', 'are', 'am', 'was', 'were', 'be', 'being', 'been',
  'of', 'on', 'in', 'at', 'to', 'into', 'onto', 'with', 'and', 'or', 'for', 'from', 'by', 'as', 'over',
  'under', 'this', 'that', 'these', 'those', 'it', 'its', 'their', 'there', 'while', 'who', 'which']);
// Generic person words we replace with a real name when face recognition gave us one.
const GENERIC_PERSON = new Set(['someone', 'somebody', 'anyone', 'person', 'persons', 'people', 'man', 'men',
  'woman', 'women', 'guy', 'guys', 'lady', 'boy', 'boys', 'girl', 'girls', 'kid', 'kids', 'child', 'children',
  'male', 'female', 'figure', 'individual', 'individuals', 'subject', 'human', 'adult', 'adults']);
// Count words that often precede a generic ("two people", "group of guys").
const COUNT_WORDS = new Set(['two', 'three', 'four', 'five', 'several', 'multiple', 'group', 'couple', 'bunch', 'pair']);

function nameToTokens(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9\s\-]+/g, '').split(/[\s\-]+/).filter(Boolean);
}

// Turn a raw field string into clean lowercase hyphen-keywords, dropping articles/
// filler, and swapping generic person words for the recognized name(s).
function cleanNameField(raw, people) {
  const names = uniqStrings(Array.isArray(people) ? people : []).filter(Boolean);
  const nameTokenSets = names.map(nameToTokens);                 // [["liam"], ["josiah"]]
  let toks = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_]+/g, ' ')
    .split(/[\s\-_]+/)
    .filter(Boolean)
    .filter((t) => !NAME_STOPWORDS.has(t));

  const out = [];
  let injectedNames = false;
  // Inject the FIRST name of each recognized person (cleaner filenames, matches the
  // "liam-pushups" style); the FULL name still lands in XMP via the people array.
  const injectNames = () => {
    if (injectedNames) return;
    nameTokenSets.forEach((set) => { if (set[0]) out.push(set[0]); });
    injectedNames = true;
  };
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    // "two people" / "group of guys" → drop the count, the generic gets handled next.
    if ((COUNT_WORDS.has(t) || /^\d+$/.test(t)) && (GENERIC_PERSON.has(toks[i + 1]) || GENERIC_PERSON.has(toks[i + 2]))) continue;
    if (GENERIC_PERSON.has(t)) {
      if (names.length) injectNames();         // swap generic → real name(s)
      else out.push(t);                        // no name known → keep the cleaned generic word
      continue;
    }
    out.push(t);
  }
  // Collapse duplicates while preserving order (so a name isn't repeated).
  const seen = new Set();
  let res = out.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
  // If the model never mentioned a person but we DID recognize one and the field is
  // about a person-centric subject, we still don't force it in — avoids misattribution.
  // But if the ONLY content was the generic word (now empty) and we have names, keep names.
  if (!res.length && names.length) res = nameTokenSets.map((s) => s[0]).filter(Boolean);
  return res.join('-');
}

// Clean an AI tags array into tidy, human-readable keyword tags (digiKam-style):
// lowercase, trimmed, de-duplicated, no junk/empties, capped so a runaway answer
// can't flood the tag row. Tags keep spaces ("golden hour") unlike hyphen-fields.
function cleanTags(raw) {
  const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const seen = new Set(); const out = [];
  for (const t of arr) {
    const s = String(t == null ? '' : t).toLowerCase().replace(/[_]+/g, ' ').replace(/[^a-z0-9\s\-]+/g, '').replace(/\s+/g, ' ').trim();
    if (!s || s.length < 2 || s.length > 28 || seen.has(s)) continue;
    seen.add(s); out.push(s);
    if (out.length >= 10) break;
  }
  return out;
}

// Normalize a full naming result. Subject + description get cleaned & name-swapped;
// shotType/category pass through aiFieldStr untouched; tags get tidied.
function normalizeNaming(out, people) {
  const o = out || {};
  return {
    subject: cleanNameField(aiFieldStr(o.subject), people),
    description: cleanNameField(aiFieldStr(o.description), people),
    shotType: aiFieldStr(o.shotType),
    category: aiFieldStr(o.category),
    tags: cleanTags(o.tags)
  };
}

// Shared naming spec (field list + rules + style/memory) — used by ai:suggest AND
// the self-review ai:improve pass so they stay consistent. `hasPeople` relaxes the
// no-names rule (recognized people are fine; only the free NOTE's words are banned).
function aiNamingSpec(ai, opts) {
  const { subjects, categories, hasPeople } = opts || {};
  const subjHint = (Array.isArray(subjects) ? subjects : []).slice(0, 40).join(', ');
  const catList = (Array.isArray(categories) ? categories : []).slice(0, 40);
  const wantCat = !(ai.suggestCategory === false) && catList.length > 0;
  const detectShot = ai.detectShot !== false;
  const wantTags = ai.suggestTags !== false;   // default ON — auto-fill the tag row
  const fields = ['"subject": "..."', '"description": "..."'];
  if (detectShot) fields.push('"shotType": "..."');
  if (wantCat) fields.push('"category": "..."');
  if (wantTags) fields.push('"tags": ["...", "..."]');
  const fieldSpec = `{${fields.join(', ')}}`;
  const nameRule = hasPeople
    ? 'You MAY include a RECOGNIZED person\'s name (from the recognized-people list) when they are the focus, but NEVER invent names or copy words from the background note.'
    : 'NEVER put a person\'s name in the description (no recognized people here). Describe the action.';
  const rules = [
    'subject: 1-3 words naming the main thing/activity in the footage, lowercase, hyphens for spaces (e.g. "lawn-mowing", "calisthenics").',
    `description: usually 2-6 keywords for WHAT IS VISIBLY HAPPENING — the specific action plus the setting/object (good: "pushups-on-grass", "liam-mowing-front-lawn", "chainsaw-stump-removal"). There is NO hard limit — use a few more keywords when they genuinely make the clip more specific and findable (e.g. "liam-josiah-building-treehouse-backyard"); just never pad with filler. Base it ONLY on the observed footage. Do NOT include the shot type here (it has its own field). ${nameRule} No articles/filler ("a","the","is","of","on","with"), no sentences. lowercase, hyphens for spaces.`,
    'Use ALL the information you have — the observation, recognized people, measured motion, shot type and the user\'s style — to make the description as specific and useful as possible. Describe the FOOTAGE, not the note.'
  ];
  if (detectShot) {
    const sts = aiShotTypes();
    const defs = sts.map((s) => `${s.name}${s.desc ? ` (${s.desc})` : ''}`).join('; ');
    rules.push(`shotType: exactly ONE of [${sts.map((s) => s.name).join(', ')}]. Judge from camera motion + framing. Definitions — ${defs}.`);
  }
  if (wantCat) rules.push(`category: pick the SINGLE best match ONLY from [${catList.join(', ')}], or "" if none fit.`);
  if (wantTags) rules.push('tags: 3-8 SHORT lowercase keyword tags for browsing/searching this clip later — concrete things VISIBLE in the footage: objects, setting/place, activity, season/time-of-day, mood. Each tag is 1-2 plain words (e.g. "backyard", "golden hour", "power tools", "winter"). Do NOT just repeat the subject/description words; add the broader searchable concepts. No people names (handled separately).');
  if (subjHint) rules.push(`Prefer these known subjects when they genuinely fit: [${subjHint}].`);
  const rulesText = rules.map((r) => `- ${r}`).join('\n');
  const exs = styleFewShot(12);   // one owner: his corrections first, then the mined archive
  // `exs` was capped at 12; `mems` was capped at NOTHING. The store holds up to 300 memories, so a
  // well-used install injected ~18 KB of English rules into EVERY clip's prompt, on a 7B model. A
  // 7B model does not follow 300 rules — it drowns in them, and the ones that matter get buried.
  const mems = selectMemories(ai.memories, (opts && opts.clipText) || '', 24)
    .map((m) => (m.example ? `${m.text} (e.g. ${m.example})` : m.text));
  let styleBlock = '';
  if (exs.length) styleBlock += `\nMatch this user's own naming style. Real examples (subject / description):\n${exs.join('\n')}`;
  if (mems.length) styleBlock += `\nFollow these learned preferences from the user:\n- ${mems.join('\n- ')}`;
  return { fieldSpec, rulesText, styleBlock, detectShot, wantCat };
}

// Which of the user's learned preferences are worth spending prompt budget on for THIS clip?
//
// Not a pure relevance filter, deliberately. A rule like "always lowercase with hyphens" is global —
// it has zero lexical overlap with any clip, and a naive relevance ranker would drop exactly the
// style rules that matter most. So: keep everything while it fits, and only once we're over budget
// rank by relevance to this clip, falling back to recency (a newer correction reflects what the user
// wants NOW). The chosen set is emitted in its original order, so the prompt stays stable between
// clips and the model isn't re-anchored by reshuffling.
function selectMemories(memories, clipText, cap = 24) {
  const mems = (Array.isArray(memories) ? memories : []).filter((m) => m && m.text);
  if (mems.length <= cap) return mems;

  const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const clipWords = new Set(words(clipText));
  const score = (m) => words(`${m.text} ${m.example || ''}`).reduce((n, t) => n + (clipWords.has(t) ? 1 : 0), 0);

  return mems
    .map((m, i) => ({ m, i, s: score(m) }))
    .sort((a, b) => (b.s - a.s) || (b.i - a.i))   // relevant first, then newest
    .slice(0, cap)
    .sort((a, b) => a.i - b.i)                    // …but emit in the original order
    .map((x) => x.m);
}

// Perceive ONE clip (vision only) → a free-text observation. Used by the batch
// flow to do all vision passes first (model stays loaded), then name them all.
ipcMain.handle('ai:perceive', async (_evt, payload) => {
  const { sourcePath, model } = payload || {};
  if (!sourcePath) return { ok: false, error: 'No clip' };
  const ai = config.ai || {};
  const useModel = model || ai.model;
  if (!useModel) return { ok: false, error: 'No model selected' };
  const temp = isFinite(Number(ai.temperature)) ? Number(ai.temperature) : 0.2;
  const guidance = (ai.prompt && ai.prompt.trim()) || AI_DEFAULT_GUIDANCE;
  try {
    const sheet = await getContactSheet(sourcePath, ai.frames || 3);
    if (!sheet) return { ok: false, error: 'Could not read frames' };
    const imgB64 = (await fsp.readFile(sheet)).toString('base64');
    const motion = await detectMotion(sourcePath);
    const perceivePrompt = `${guidance}${aiMotionBlock(motion)}\n${PERCEIVE_INSTRUCTION}`;
    const observation = (await ollamaVisionGenerate(useModel, perceivePrompt, { images: [imgB64], temperature: temp, timeout: 180000 })).trim();
    return { ok: true, observation: `${observation}${motion ? `\n(Measured camera motion: ${motion})` : ''}`, note: takeVisionNote(), switchedTo: takeVisionSwitch() };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

ipcMain.handle('ai:suggest', async (evt, payload) => {
  const { sourcePath, model, subjects, categories } = payload || {};
  if (!sourcePath) return { ok: false, error: 'No clip' };
  const ai = config.ai || {};
  const useModel = model || ai.model;
  if (!useModel) return { ok: false, error: 'No model selected' };
  const temp = isFinite(Number(ai.temperature)) ? Number(ai.temperature) : 0.2;
  const step = (phase) => { try { evt.sender.send('ai:suggest-step', { phase }); } catch { /* ignore */ } };
  const ctxBlock = aiContextBlock(payload && payload.context);
  const peopleBlock = aiPeopleBlock(payload && payload.people);
  const hasPeople = !!(payload && Array.isArray(payload.people) && payload.people.filter(Boolean).length);
  const precomputed = String((payload && payload.observation) || '').trim();
  // Measured motion (gyro / frame-diff) — when the observation is precomputed it
  // already carries this, so only fetch it when we'll build prompts ourselves.
  const motionBlock = precomputed ? '' : aiMotionBlock(await detectMotion(sourcePath));
  // "Refine" mode: the user already wrote a name — improve it, don't start over.
  const draft = (payload && payload.draft) || null;
  const draftBlock = (draft && (draft.subject || draft.description || draft.location))
    ? `\nThe user already wrote this for the clip — subject: "${draft.subject || ''}", description: "${draft.description || ''}", location: "${draft.location || ''}". Treat all of it as authoritative CONTEXT about what's shown, and IMPROVE/tighten the subject + description: keep their meaning and correct keywords, just fix wording to match the rules and style. Do NOT start from scratch unless clearly wrong.`
    : '';

  // Read the contact sheet lazily — multi-pass with a precomputed observation
  // needs no image at all (the text model just names from the observation).
  const readSheet = async () => {
    const sheet = await getContactSheet(sourcePath, ai.frames || 3);
    if (!sheet) throw new Error('Could not read frames from this clip');
    return (await fsp.readFile(sheet)).toString('base64');
  };

  const guidance = (ai.prompt && ai.prompt.trim()) || AI_DEFAULT_GUIDANCE;
  // Relevance context for selectMemories: what this clip is actually ABOUT. With no precomputed
  // observation we still have the user's shoot context and the recognised people.
  const clipText = [precomputed, (payload && payload.context) || '', ((payload && payload.people) || []).join(' ')].filter(Boolean).join(' ');
  const { fieldSpec, rulesText, styleBlock } = aiNamingSpec(ai, { subjects, categories, hasPeople, clipText });

  const finish = (out) => {
    const named = normalizeNaming(out, payload && payload.people);
    // An empty reply (parseJsonLoose returns {} on a total model failure / a non-JSON answer) must NOT
    // count as a named clip: the renderer would tick it "named", leave every field blank, mark no
    // failure, and never offer a retry. Report it as a failure so it lands in the retry queue instead.
    if (!aiFieldStr(named.subject) && !aiFieldStr(named.description)) return { ok: false, error: 'the model returned no usable name — try again' };
    return { ok: true, ...named };
  };
  const errMsg = (err) => (/aborted|timeout/i.test(err.message || '') ? 'Timed out — the model may still be loading; try again.' : (err.message || String(err)));

  // --- Multi-pass reasoning: perceive (vision) → name (text) → critique (text).
  // Weak local models name better when perception is separated from style-matching.
  // A "quick" request forces the single fast vision call (skips the 2 extra text
  // passes) — ~3x fewer model calls per clip for big batches.
  const multiPass = (payload && payload.quick) ? false : ai.multiPass;
  if (multiPass) {
    // Perception uses the vision model; the naming + critique passes use the
    // (optional) dedicated reasoning model when set — better at style + JSON.
    const reason = aiTextModel() || useModel;
    try {
      let observation = precomputed;
      if (!observation) {
        step('perceiving');
        const imgB64 = await readSheet();
        const perceivePrompt = `${guidance}${motionBlock}\n${PERCEIVE_INSTRUCTION}`;
        observation = (await ollamaVisionGenerate(useModel, perceivePrompt, { images: [imgB64], temperature: temp, timeout: 180000 })).trim();
      }

      // Run a JSON text call on the reasoning model; if THAT fails (e.g. the
      // chosen reasoning model isn't actually pulled → HTTP 404), fall back to the
      // vision model so naming never silently produces nothing.
      const genJson = async (prompt, t) => {
        try { return parseJsonLoose(await ollamaGenerate(reason, prompt, { format: 'json', temperature: t, timeout: 120000 })); }
        catch (e) {
          if (reason !== useModel) return parseJsonLoose(await ollamaGenerate(useModel, prompt, { format: 'json', temperature: t, timeout: 120000 }));
          throw e;
        }
      };
      step('naming');
      let p2 = `A videographer needs to name one video clip for their archive. Here is an objective observation of what the clip's frames actually show:\n"${observation}"${ctxBlock}${peopleBlock}${motionBlock}\n\nThe subject and description MUST come from the observation (what is visibly happening). The background note only helps you identify the subject/people — it is NOT to be copied into the description. Output STRICT JSON only — no prose, no code fences: ${fieldSpec}\n${rulesText}${styleBlock}${draftBlock}`;
      const draft = await genJson(p2, temp);

      step('checking');
      const p3 = `Here is a draft name for a video clip, plus the observation of what the frames actually show:\nDRAFT: ${JSON.stringify({ subject: aiFieldStr(draft.subject), description: aiFieldStr(draft.description), shotType: aiFieldStr(draft.shotType), category: aiFieldStr(draft.category) })}\nOBSERVATION: "${observation}"${peopleBlock}\n\nFix any violations of the user's rules. In particular: is the description just words copied from the videographer note instead of the VISIBLE action? If so, rewrite it to describe what's happening in the observation. Is it using ALL the available detail (action, setting, recognized people, shot type)? Also: description too long or containing articles/filler? subject not 1-3 words? shotType not in the allowed list? category not from the allowed list? If everything already fits, return it unchanged.\n${rulesText}${styleBlock}\nOutput corrected STRICT JSON only: ${fieldSpec}`;
      let out;
      try { out = await genJson(p3, Math.max(0, temp - 0.1)); }
      catch { out = draft; }   // critique pass is best-effort; fall back to the draft
      if (!out || !aiFieldStr(out.subject)) out = draft;   // guard against an empty correction
      // Return the observation too so Improve / Learn-rules can reuse what was SEEN
      // without re-watching the footage (one shared analysis across all AI features).
      return { ...finish(out || {}), observation, note: takeVisionNote(), switchedTo: takeVisionSwitch() };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  }

  // --- Single-pass (default): one vision call → JSON. We ALSO ask for a short
  // "observation" field so this one call records what was seen — Improve and
  // Learn-rules then reuse it instead of telling the user to analyze first.
  const obsField = '"observation": "one plain sentence: what is visibly happening across the frames"';
  const fieldSpecO = `{${obsField}, ${fieldSpec.slice(1)}`;
  let prompt = `${guidance}${ctxBlock}${peopleBlock}${motionBlock}\nReply with STRICT JSON only — no prose, no code fences: ${fieldSpecO}\n${rulesText}${styleBlock}${draftBlock}`;
  try {
    step('naming');
    const imgB64 = await readSheet();
    const out = parseJsonLoose(await ollamaVisionGenerate(useModel, prompt, { images: [imgB64], format: 'json', temperature: temp, timeout: 180000 }));
    const observation = precomputed || aiFieldStr(out.observation) || '';
    return { ...finish(out), observation, note: takeVisionNote(), switchedTo: takeVisionSwitch() };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
});

// SELF-REVIEW: go back to the cached visual observation + the current draft and FIX
// the name — TEXT-ONLY (no re-vision), using all available data (observation,
// recognized people, shot type, the user's style + learned memories). "See where it
// went wrong and make it better." Uses the reasoning model when set.
ipcMain.handle('ai:improve', async (_e, payload) => {
  const ai = config.ai || {};
  const reason = aiTextModel() || ai.model;
  if (!reason) return { ok: false, error: 'No model selected' };
  const observation = String((payload && payload.observation) || '').trim();
  if (!observation) return { ok: false, error: 'No earlier analysis to review for this clip' };
  const temp = isFinite(Number(ai.temperature)) ? Number(ai.temperature) : 0.2;
  const draft = (payload && payload.draft) || {};
  const peopleBlock = aiPeopleBlock(payload && payload.people);
  const hasPeople = !!(payload && Array.isArray(payload.people) && payload.people.filter(Boolean).length);
  const ctxBlock = aiContextBlock(payload && payload.context);
  const clipText2 = [observation, (payload && payload.context) || '', ((payload && payload.people) || []).join(' ')].filter(Boolean).join(' ');
  const { fieldSpec, rulesText, styleBlock } = aiNamingSpec(ai, { subjects: payload && payload.subjects, categories: payload && payload.categories, hasPeople, clipText: clipText2 });
  const prompt = `You earlier looked at a video clip and recorded this observation of what its frames show:\n"${observation}"${ctxBlock}${peopleBlock}\n\nThe clip's CURRENT name is:\nDRAFT: ${JSON.stringify({ subject: aiFieldStr(draft.subject), description: aiFieldStr(draft.description), shotType: aiFieldStr(draft.shotType), category: aiFieldStr(draft.category) })}\n\nReview the draft AGAINST the observation. Decide where it is wrong, vague, generic, or missing detail, and REWRITE it to be the best, most specific, most useful name possible using ALL the information (the visible action, the setting/objects, recognized people, the shot type). Don't lose anything correct; sharpen everything else. Output corrected STRICT JSON only — no prose: ${fieldSpec}\n${rulesText}${styleBlock}`;
  const sourcePath = (payload && payload.sourcePath) || '';
  // When there's no DEDICATED text model, `reason` is the vision model. Many vision
  // models (e.g. qwen2.5vl) fail or stall on a TEXT-ONLY generate, which is why
  // Improve died on the first clip while Analyze (vision, with an image) worked. So:
  // if we're leaning on the vision model, run Improve WITH the footage too; and on
  // ANY failure, fall back to a vision pass using the cached frames.
  const usingVisionModel = !(ai.textModel && ai.textModel !== ai.model);
  const sheetImage = async () => {
    if (!sourcePath) return null;
    const sheet = await getContactSheet(sourcePath, ai.frames || 3);
    if (!sheet) return null;
    return (await fsp.readFile(sheet)).toString('base64');
  };
  const visionPass = async () => {
    const img = await sheetImage();
    if (!img) return null;
    const raw = await ollamaVisionGenerate(reason, prompt, { images: [img], format: 'json', temperature: temp, timeout: 180000 });
    return { ok: true, ...normalizeNaming(parseJsonLoose(raw), payload && payload.people), note: takeVisionNote(), switchedTo: takeVisionSwitch() };
  };
  try {
    // Preferred path: vision-assisted when only a vision model is available, else text-only.
    if (usingVisionModel && sourcePath) {
      const r = await visionPass();
      if (r) return r;
    }
    const out = parseJsonLoose(await ollamaGenerate(reason, prompt, { format: 'json', temperature: temp, timeout: 120000 }));
    return { ok: true, ...normalizeNaming(out, payload && payload.people) };
  } catch (err) {
    // Last resort: if the text-only call errored but we have the footage, re-try as vision.
    try { const r = await visionPass(); if (r) return r; } catch { /* fall through */ }
    return { ok: false, error: /aborted|timeout/i.test(err.message || '') ? 'Timed out — the model may still be loading; try again.' : (err.message || String(err)) };
  }
});

// Pull a model into Ollama from inside the app, streaming progress to the UI.
ipcMain.handle('ai:pull', async (evt, name) => {
  const model = String(name || '').trim();
  if (!model) return { ok: false, error: 'No model name' };
  const sender = evt.sender;
  try {
    const res = await fetch(aiEndpoint() + '/api/pull', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }), signal: AbortSignal.timeout(3600000)
    });
    if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.error) { sender.send('ai:pull-progress', { error: o.error }); return { ok: false, error: o.error }; }
        const pct = (o.total && o.completed) ? Math.round((o.completed / o.total) * 100) : null;
        sender.send('ai:pull-progress', { status: o.status || '', percent: pct });
      }
    }
    sender.send('ai:pull-progress', { status: 'success', percent: 100, done: true });
    return { ok: true };
  } catch (err) {
    sender.send('ai:pull-progress', { error: err.message || String(err) });
    return { ok: false, error: err.message || String(err) };
  }
});

// In-app model "store": a curated list of current local VISION models (Ollama has
// no official API to browse its whole library), enriched with install-state and a
// best-effort live peek at ollama.com for anything newer. Download uses ai:pull.
// VISION MODEL QUALITY, best → worst. Not a marketing order — measured on real footage.
//
// Side by side on the same contact sheets, given a man at a desk with "COME AND SEE" on his monitor
// and bunk beds behind him:
//   qwen2.5vl:7b   → "desk, monitor displaying COME AND SEE, headphones, bunk beds"   (read the screen)
//   llava-llama3   → "a sign that reads Cabinets for Sale"                            (invented)
// and given a pickup truck with its doors open on a farm:
//   qwen2.5vl:7b   → "white pickup truck, doors open... farm, barns"
//   llava-llama3   → "a person riding a motorcycle on a road"                         (invented)
//
// llava-* does not merely caption vaguely, it HALLUCINATES WHOLE OBJECTS — and everything downstream
// (the name, the tags, the placement) is then built on a fabrication. That is a large part of why the
// AI feels "gimmicky". The model at the top of this list is the one to run.
//
// llama3.2-vision is deliberately last: it returns HTTP 500 on this hardware (an 11B vision model is
// simply too big alongside anything else), so "capable on paper" is not the same as "works".
const VISION_QUALITY = [
  'qwen2.5vl',          // grounded; reads on-screen text; best descriptions by a wide margin
  'minicpm-v',          // strong fine detail
  'gemma3',             // modern multimodal
  // ---- anything we have never heard of sorts HERE (VISION_UNKNOWN_RANK) ----
  'llava-phi3',         // llava family — see below
  'llava-llama3',       // MEASURED HALLUCINATING on real footage. Worse than an unknown model.
  'llava',
  'bakllava',
  'moondream',
  'granite3.2-vision',  // tuned for documents, not footage
  'llama3.2-vision',    // returns HTTP 500 on this hardware — "capable on paper" is not "works"
];
// An unknown model sorts BELOW everything we've measured as good, and ABOVE the llava family.
//
// That placement is deliberate. A model we've never heard of is a coin toss; llava is a KNOWN
// hallucinator — it described a pickup truck as "a person riding a motorcycle" on Jake's own footage.
// Ranking the unknown below a measured failure would be assuming the worst of the new and the best of
// the broken.
const VISION_UNKNOWN_RANK = 3;
function visionRankOf(name) {
  const n = String(name || '').toLowerCase();
  const i = VISION_QUALITY.findIndex((p) => n === p || n.startsWith(`${p}:`));
  if (i < 0) return VISION_UNKNOWN_RANK + 0.5;                     // unknown → just below the good ones
  return i < VISION_UNKNOWN_RANK ? i : i + 1;                      // leave a slot for the unknowns
}

const AI_MODEL_CATALOG = [
  { name: 'qwen2.5vl:7b', params: '7B', size: '6.0 GB', desc: 'Qwen2.5-VL — best-in-class at reading the actual action & detail in a frame. Best descriptions (recommended).', rec: true },
  { name: 'minicpm-v', params: '8B', size: '5.5 GB', desc: 'MiniCPM-V — excellent fine detail and on-screen text.', rec: true },
  { name: 'llava-llama3', params: '8B', size: '5.5 GB', desc: 'LLaVA on Llama 3 — solid general captions, light footprint.', rec: true },
  { name: 'gemma3', params: '4B', size: '3.3 GB', desc: 'Google Gemma 3 — modern multimodal, quick.', rec: false },
  { name: 'llava-phi3', params: '3.8B', size: '2.9 GB', desc: 'Compact LLaVA on Phi-3 — fast, lower memory.', rec: false },
  { name: 'moondream', params: '1.8B', size: '1.7 GB', desc: 'Tiny and very fast — good on modest hardware.', rec: false },
  { name: 'granite3.2-vision', params: '2B', size: '2.4 GB', desc: 'IBM Granite Vision — tuned for documents and charts.', rec: false },
  { name: 'llama3.2-vision', params: '11B', size: '7.8 GB', desc: "Meta Llama 3.2 Vision — strong, but needs a RECENT Ollama; older builds fail to load it ('mllama' error).", rec: false },
  { name: 'llava', params: '7B', size: '4.7 GB', desc: 'Original LLaVA — reliable baseline.', rec: false },
  { name: 'bakllava', params: '7B', size: '4.7 GB', desc: 'BakLLaVA on Mistral — alternative captioner.', rec: false }
];
ipcMain.handle('ai:catalog', async () => {
  let installed = [];
  try {
    const res = await ollamaFetch('/api/tags', {}, 4000);
    if (res.ok) { const j = await res.json(); installed = (j.models || []).map((m) => m.name).filter(Boolean); }
  } catch { /* offline — still show the curated catalog so the user can plan */ }
  const instBase = new Set(installed.map((n) => n.split(':')[0]));
  const isInstalled = (name) => instBase.has(name) || installed.includes(name);
  const catalog = AI_MODEL_CATALOG.map((m) => ({ ...m, installed: isInstalled(m.name) }));
  // Best-effort live discovery of newer vision models (network; never fatal).
  let live = false;
  try {
    const r = await fetch('https://ollama.com/search?c=vision', { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const html = await r.text();
      const known = new Set(AI_MODEL_CATALOG.map((x) => x.name));
      const visionRe = /llava|vision|-vl\b|vl\b|moondream|minicpm-v|bakllava|gemma3|pixtral|cogvlm|janus/i;
      const re = /\/library\/([a-z0-9][a-z0-9._-]*)/gi;
      let m;
      while ((m = re.exec(html))) {
        const name = m[1].toLowerCase();
        if (known.has(name) || !visionRe.test(name)) continue;
        known.add(name);
        catalog.push({ name, params: '', size: '', desc: 'From the Ollama vision library.', rec: false, installed: isInstalled(name), live: true });
        if (catalog.length >= 40) break;
      }
      live = true;
    }
  } catch { /* offline or blocked — the curated list is enough */ }
  return { ok: true, installed, catalog, live };
});

// Uninstall a model from Ollama (frees disk). DELETE /api/delete.
ipcMain.handle('ai:delete', async (_evt, name) => {
  const model = String(name || '').trim();
  if (!model) return { ok: false, error: 'No model' };
  try {
    const res = await fetch(aiEndpoint() + '/api/delete', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model }), signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    // If the removed model was selected anywhere, clear it.
    const ai = config.ai || (config.ai = {});
    let changed = false;
    if (ai.model === model) { ai.model = ''; changed = true; }
    if (ai.textModel === model) { ai.textModel = ''; changed = true; }
    if (changed) saveConfig();
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Feedback → memory: store the raw note, then ask the model to fold it into the
// running "learned preferences" memory that gets injected into every suggestion.
// Runs in the background; the renderer is notified when the memory updates.
ipcMain.handle('ai:feedback', async (evt, payload) => {
  const fb = String((payload && payload.feedback) || '').trim();
  if (!fb) return { ok: false, error: 'Empty feedback' };
  const ai = config.ai || (config.ai = {});
  if (!Array.isArray(ai.feedbackLog)) ai.feedbackLog = [];
  if (!Array.isArray(ai.memories)) ai.memories = [];
  ai.feedbackLog.push({ text: fb, example: String((payload && payload.example) || ''), ts: Date.now() });
  if (ai.feedbackLog.length > 200) ai.feedbackLog = ai.feedbackLog.slice(-200);

  // Distil the feedback into 1-2 concise preference rules, EACH WITH a concrete
  // example so the rule is never vague later. Appended to the list, not rewritten.
  let newItems = [];
  try {
    if (aiTextModel()) {
      const ex = (payload && payload.example) ? ` about the clip description "${payload.example}"` : '';
      const prompt = `Convert this user feedback about how AI should name video clips into 1-2 short, standalone preference rules. Feedback${ex}: "${fb}". Reply with STRICT JSON only: {"memories": [{"rule": "...", "example": "..."}]}. Each rule is a concise imperative ≤ 12 words; each example is a SHORT concrete illustration of the rule (e.g. a sample subject/description). Use 1 rule unless the feedback clearly covers two separate points.`;
      const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.3, timeout: 120000 }));
      newItems = extractRulesFrom(o).slice(0, 3);
    }
  } catch { /* fall back below */ }
  if (!newItems.length) newItems = [{ text: fb, example: String((payload && payload.example) || '') }];   // no model → store raw

  const now = Date.now();
  const added = [];
  for (const it of newItems) {
    if (ai.memories.some((m) => (m.text || '').toLowerCase() === it.text.toLowerCase())) continue;   // dedup
    ai.memories.push({ id: newMemId(), text: it.text, example: it.example || '', ts: now });
    added.push(it.text);
  }
  // SELF-CORRECT: also REMOVE any existing rule this feedback directly contradicts or
  // makes obsolete, so memory shrinks as well as grows (anti-bloat, anti-conflict).
  let removed = 0;
  try {
    if (aiTextModel() && ai.memories.length > 1) {
      const list = ai.memories.map((m, i) => `${i + 1}. ${m.text}`).join('\n');
      const rprompt = `A user just gave this feedback about how to name video clips: "${fb}". Below are the existing saved rules. List the NUMBERS of any rule that this feedback CONTRADICTS, overrides, or makes obsolete and should be REMOVED. Be conservative — only clear conflicts. If none, return an empty list. STRICT JSON only: {"remove":[numbers]}.\nRULES:\n${list}`;
      const ro = parseJsonLoose(await ollamaGenerate(aiTextModel(), rprompt, { format: 'json', temperature: 0.1, timeout: 120000, think: false }));
      const idxs = (Array.isArray(ro && ro.remove) ? ro.remove : []).map((n) => Number(n) - 1).filter((n) => n >= 0 && n < ai.memories.length);
      // don't remove the rules we just added
      const addedSet = new Set(added.map((t) => t.toLowerCase()));
      const drop = new Set(idxs.filter((i) => !addedSet.has((ai.memories[i].text || '').toLowerCase())));
      if (drop.size) { ai.memories = ai.memories.filter((m, i) => !drop.has(i)); removed = drop.size; }
    }
  } catch { /* best-effort */ }
  if (ai.memories.length > 300) ai.memories = ai.memories.slice(-300);
  saveConfig();
  try { evt.sender.send('ai:memory-updated', { memories: ai.memories }); } catch { /* ignore */ }
  maybeAutoConsolidate();
  return { ok: true, memories: ai.memories, added, removed };
});

// Learn from edits (implicit): the renderer records when the user changes a value
// the AI suggested ({field, from, to}); distil the corrections into 1-3 candidate
// rules. We do NOT save them here — they're PROPOSED back to the renderer, which
// queues them as questions for the user to confirm before they become memory.
ipcMain.handle('ai:learnEdits', async (_evt, payload) => {
  const edits = (Array.isArray(payload) ? payload : (payload && payload.edits) || [])
    .filter((e) => e && e.from && e.to && String(e.from).toLowerCase() !== String(e.to).toLowerCase())
    .slice(0, 30);
  if (!edits.length) return { ok: false, error: 'No edits' };
  const ai = config.ai || (config.ai = {});
  if (!Array.isArray(ai.memories)) ai.memories = [];
  if (!Array.isArray(ai.feedbackLog)) ai.feedbackLog = [];
  ai.feedbackLog.push({ kind: 'edits', edits, ts: Date.now() });
  if (ai.feedbackLog.length > 200) ai.feedbackLog = ai.feedbackLog.slice(-200);
  saveConfig();   // keep the raw edits even if distillation/confirmation never happens

  const lines = edits.map((e) => `- ${e.field}: AI suggested "${e.from}" → user changed to "${e.to}"`).join('\n');
  let proposed = [];
  try {
    if (aiTextModel()) {
      const prompt = `An AI suggested names for video clips, but the user corrected them:\n${lines}\n\nInfer 1-3 short, standalone preference rules the AI should follow so it makes these corrections itself next time (about wording, length, format, or subject choice). Ignore one-off changes that aren't a pattern. Reply with STRICT JSON only: {"memories": [{"rule": "...", "example": "..."}]}. Each rule is a concise imperative ≤ 12 words; each example is a SHORT concrete illustration (e.g. the corrected wording).`;
      const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.3, timeout: 120000 }));
      proposed = extractRulesFrom(o).slice(0, 3);
    }
  } catch { /* no model / parse failure → nothing to propose */ }
  // Drop rules already in memory so we don't ask about ones we've learned.
  proposed = proposed.filter((p) => p.text && !ai.memories.some((m) => (m.text || '').toLowerCase() === p.text.toLowerCase()));
  return { ok: true, proposed };
});

// Commit user-confirmed memory rules (from the review form's "remember this" step,
// or anywhere else the renderer wants to add rules). Dedups + persists + notifies.
ipcMain.handle('ai:addMemories', (evt, payload) => {
  const rules = aiExtractRules(Array.isArray(payload) ? payload : (payload && payload.rules) || []).slice(0, 20);
  const ai = config.ai || (config.ai = {});
  if (!Array.isArray(ai.memories)) ai.memories = [];
  const now = Date.now();
  const added = [];
  for (const it of rules) {
    if (ai.memories.some((m) => (m.text || '').toLowerCase() === it.text.toLowerCase())) continue;   // dedup
    ai.memories.push({ id: newMemId(), text: it.text, example: it.example || '', ts: now });
    added.push(it.text);
  }
  if (!added.length) return { ok: true, memories: ai.memories, added: [] };
  if (ai.memories.length > 300) ai.memories = ai.memories.slice(-300);
  saveConfig();
  try { evt.sender.send('ai:memory-updated', { memories: ai.memories }); } catch { /* ignore */ }
  maybeAutoConsolidate();   // background-compress when it grows
  return { ok: true, memories: ai.memories, added };
});

// REFLECT: work BACKWARDS from how clips were SEEN (the vision observation across
// frames) and what they were NAMED → derive durable, reusable naming RULES and add
// them to memory. This is the app learning from its OWN analysis, not just edits.
ipcMain.handle('ai:reflect', async (evt, payload) => {
  const ai = config.ai || (config.ai = {});
  const model = aiTextModel() || ai.model;
  if (!model) return { ok: false, error: 'No model selected' };
  const samples = (Array.isArray(payload && payload.samples) ? payload.samples : [])
    .filter((s) => s && s.observation && (s.subject || s.description)).slice(0, 24);
  if (samples.length < 2) return { ok: false, error: 'Not enough analyzed clips to learn from' };
  const lines = samples.map((s, i) => {
    const name = [s.subject, s.description].filter(Boolean).join(' / ');
    const extra = [s.shotType ? `shot:${s.shotType}` : '', (Array.isArray(s.people) && s.people.length) ? `people:${s.people.join(',')}` : ''].filter(Boolean).join(' ');
    const ctx = s.context ? ` (user's intent: "${String(s.context).slice(0, 140)}")` : '';
    return `${i + 1}. SAW: "${String(s.observation).slice(0, 320)}"${ctx} -> NAMED: "${name}"${extra ? ` [${extra}]` : ''}`;
  }).join('\n');
  const existing = (ai.memories || []).map((m) => m.text).filter(Boolean).slice(0, 40);
  // The samples are clips the USER corrected (the renderer filters to `_userNamed` — see
  // reflectFromClips). The prompt used to say "a system … produced these names" and ask what rules
  // explained *its own* choices, which is how the memory list filled up with the AI's own habits
  // dressed as the user's preferences. These are the user's names. Say so — it changes what the
  // model looks for entirely.
  const prompt = `Here are video clips: what was SEEN in the frames, and the name THE USER chose for each. The user's name is the ground truth — where it differs from what was seen, that difference IS the preference.\n${lines}\n\nWork BACKWARDS from THE USER'S choices: what GENERAL, reusable naming rules would let you name similar future footage the way THE USER would have? Focus on DURABLE patterns — how they describe an action, what they call a recurring subject or place, their shot-type conventions, how they use people's names — NOT facts about these specific clips. Do NOT repeat anything already covered by these existing rules:\n- ${existing.join('\n- ') || '(none yet)'}\nReturn 0-4 genuinely NEW rules (or none — none is a perfectly good answer). STRICT JSON only: {"memories":[{"rule":"<= 14 words","example":"short illustration or empty"}]}`;
  try {
    const o = parseJsonLoose(await ollamaGenerate(model, prompt, { format: 'json', temperature: 0.3, timeout: 120000, think: false }));
    const rules = aiExtractRules(o && o.memories ? o.memories : o).slice(0, 4);
    if (!Array.isArray(ai.memories)) ai.memories = [];
    const now = Date.now(); const added = [];
    for (const it of rules) {
      const t = (it.text || '').trim(); if (!t) continue;
      if (ai.memories.some((m) => (m.text || '').toLowerCase() === t.toLowerCase())) continue;
      ai.memories.push({ id: newMemId(), text: t, example: it.example || '', ts: now });
      added.push(t);
    }
    if (added.length) {
      if (ai.memories.length > 300) ai.memories = ai.memories.slice(-300);
      saveConfig();
      try { evt.sender.send('ai:memory-updated', { memories: ai.memories }); } catch { /* ignore */ }
      maybeAutoConsolidate();
    }
    return { ok: true, added };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Refine/compact one memory's text into a tidy keyword-style rule (used by the
// add-memory editor's "Refine with AI" button; returns the refined text only).
ipcMain.handle('ai:refineMemory', async (_evt, payload) => {
  const text = String((payload && payload.text) || '').trim();
  if (!text) return { ok: false, error: 'Empty' };
  const ai = config.ai || {};
  if (!aiTextModel()) return { ok: false, error: 'No model selected' };
  try {
    const prompt = `Rewrite this note as ONE concise, standalone preference rule for an AI that names video clips. Keep every useful keyword, drop filler. Reply with STRICT JSON only: {"rule": "...", "example": "..."} — rule ≤ 14 words, example a SHORT concrete illustration (may be "").\nNote: "${text}"`;
    const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.2, timeout: 120000 }));
    const r = extractRulesFrom(o)[0];   // handles bare {rule,example} / {memories:[…]} / {text} identically
    if (!r || !r.text) return { ok: false, error: 'No result' };
    return { ok: true, text: r.text, example: r.example || '' };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Import a document (e.g. a naming SOP): extract the useful rules+keywords into
// PROPOSED memory items the user then confirms. Reads a text-like file directly.
ipcMain.handle('ai:importDoc', async (_evt, payload) => {
  const filePath = String((payload && payload.path) || '').trim();
  let text = String((payload && payload.text) || '');
  if (!text && filePath) { try { text = await fsp.readFile(filePath, 'utf8'); } catch (err) { return { ok: false, error: `Couldn't read file: ${err.message}` }; } }
  text = text.slice(0, 16000).trim();   // cap context
  if (!text) return { ok: false, error: 'Nothing to read in that file' };
  const ai = config.ai || {};
  if (!aiTextModel()) return { ok: false, error: 'No model selected' };
  try {
    const prompt = `The following is a videographer's notes/SOP. Extract EVERY concrete, reusable fact or rule that would help an AI name, tag, organize, or file their video clips — including: naming format, wording/casing, keywords or tags, folder and location conventions, storage paths, and any specific values mentioned (folder names, drive paths, etc.). Capture specifics verbatim where useful. Ignore only pure prose/boilerplate. If a line states a concrete convention, it IS a rule. Reply with STRICT JSON only: {"memories": [{"rule": "...", "example": "..."}]} — up to 15 rules, each ≤ 18 words, example a SHORT illustration or the concrete value (may be "").\n\nNOTES:\n${text}`;
    const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.2, timeout: 180000 }));
    const proposed = extractRulesFrom(o).slice(0, 12);
    return { ok: true, proposed };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Learn the user's naming STYLE from the names they've already given clips (the
// Compressed folder + saved records). Stores example pairs (injected into every
// suggestion) and asks the model to distil 3-6 style rules into memory.
ipcMain.handle('ai:learnNames', async (_evt, payload) => {
  const ai = config.ai || (config.ai = {});
  const dir = (payload && payload.dir) || config.finalizeSource || '';
  const pairs = [];
  if (dir) {
    let files = [];
    try { files = await listVideosShallow(dir); } catch { /* ignore */ }
    for (const f of files) {
      const p = parseNamedClip(f.name);
      if (p && (p.subject || p.description)) pairs.push(`${p.subject || '?'} / ${p.description || '?'}`);
    }
  }
  // Also mine the saved final-metadata records.
  try {
    for (const v of Object.values(currentFinalMeta())) {
      if (v && (v.subject || v.description)) pairs.push(`${v.subject || '?'} / ${v.description || '?'}`);
    }
  } catch { /* ignore */ }
  const uniq = [...new Set(pairs)].filter((s) => s !== '? / ?');
  if (!uniq.length) return { ok: false, error: dir ? 'No app-named clips found in that folder.' : 'No Compressed folder set and no saved names yet.' };

  // Deep mining: feed up to 200 of the user's own names and ask for MORE rules,
  // each carrying a real example drawn from their data.
  const sample = uniq.slice(0, 200);
  let rules = [];
  try {
    if (aiTextModel()) {
      const prompt = `Here is how a videographer names their own video clips, as "subject / description" pairs (${sample.length} examples):\n${sample.join('\n')}\n\nStudy their STYLE in depth and summarise it into 5-10 short imperative rules an AI should follow to name clips exactly the same way — cover word count, format/casing, what they consistently include or omit, how they phrase subjects vs descriptions, and any recurring vocabulary. Reply with STRICT JSON only: {"rules": [{"rule": "...", "example": "..."}]}. Each rule ≤ 14 words; each example is a REAL pair from the list above that illustrates the rule.`;
      const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.3, timeout: 180000 }));
      rules = extractRulesFrom(o, 'rules').slice(0, 10);
    }
  } catch { /* keep examples even if rule distillation fails */ }

  if (!Array.isArray(ai.memories)) ai.memories = [];
  ai.styleExamples = uniq.slice(0, 60);   // few-shot examples — fine to keep silently
  saveConfig();
  // PROPOSE the distilled rules (don't auto-add) — the user confirms which to keep.
  const proposed = rules.filter((r) => r.text && !ai.memories.some((m) => (m.text || '').toLowerCase() === r.text.toLowerCase()));
  return { ok: true, examples: uniq.length, proposed };
});

// Consolidate the memory list: merge tiny/overlapping rules into fewer, grouped
// ones (each keeps an example). PROPOSES a new list — the renderer confirms before
// it replaces the old one. This is the "stop creating many tiny memories" lever.
// Memory inbox: a plain file (memory-inbox.jsonl) that anything — including Claude
// between sessions — can append learnings to. On launch we fold them into AI memory
// (deduped) and archive the inbox, so external refinements flow in without touching
// the live config.json. Each line is {"text":"…","example":"…"} or just raw text.
function ingestMemoryInbox() {
  const inbox = path.join(path.dirname(USER_CONFIG), 'memory-inbox.jsonl');
  let lines = [];
  try { lines = fs.readFileSync(inbox, 'utf8').split(/\r?\n/).filter((l) => l.trim()); } catch { return; }
  if (!lines.length) return;
  const ai = config.ai || (config.ai = {});
  if (!Array.isArray(ai.memories)) ai.memories = [];
  const have = new Set(ai.memories.map((m) => String((m && m.text) || '').toLowerCase()));
  let added = 0;
  for (const l of lines) {
    let text = ''; let example = '';
    try { const o = JSON.parse(l); text = String(o.text || o.rule || '').trim(); example = String(o.example || ''); }
    catch { text = l.trim(); }
    if (text && !have.has(text.toLowerCase())) { have.add(text.toLowerCase()); ai.memories.push({ id: newMemId(), text, example, ts: Date.now() }); added += 1; }
  }
  if (ai.memories.length > 300) ai.memories = ai.memories.slice(-300);   // cap (a huge inbox can't bloat config)
  if (added) saveConfig();
  try { fs.renameSync(inbox, `${inbox}.${Date.now()}.done`); } catch { try { fs.writeFileSync(inbox, ''); } catch { /* ignore */ } }
  if (added) setTimeout(() => { maybeAutoConsolidate(); }, 2000);
}

// Self-compressing memory: when it grows past a threshold, merge/dedupe it in the
// BACKGROUND (no approval) so it stays a tight set of distinct rules forever.
let _autoConsolidating = false;
const AUTO_CONSOLIDATE_AT = 20;
async function maybeAutoConsolidate() {
  const ai = config.ai || {};
  const mems = (ai.memories || []).filter((m) => m && m.text);
  if (mems.length < AUTO_CONSOLIDATE_AT || _autoConsolidating || !aiTextModel()) return;
  _autoConsolidating = true;
  try {
    // Memories are listed OLDEST→NEWEST; on a CONFLICT, the later rule reflects the
    // user's more recent preference and wins.
    const list = mems.map((m, i) => `${i + 1}. ${m.text}${m.example ? ` (e.g. ${m.example})` : ''}`).join('\n');
    const prompt = `Here are preference rules (oldest first) for an AI that names & organizes video clips. Clean them into a tight, NON-CONTRADICTORY set:\n- MERGE overlapping/duplicate rules into fewer well-grouped ones.\n- If two rules CONFLICT (say opposite things), DROP the older one and keep the newer (later-numbered) rule — it is the user's more recent preference.\n- DELETE anything redundant, vague, or now contradicted. Do not invent new rules.\n- PRESERVE every distinct concrete requirement + one short example.\nAim for ≤ 18 rules. Reply STRICT JSON only: {"memories":[{"rule":"...","example":"..."}]}.\n\nRULES:\n${list}`;
    const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.2, timeout: 180000 }));
    const merged = extractRulesFrom(o).slice(0, 60);
    const before = mems.map((m) => (m.text || '').toLowerCase().trim()).join('|');
    const after = merged.map((r) => (r.text || '').toLowerCase().trim()).join('|');
    // Apply when the set actually changed, didn't GROW, and didn't COLLAPSE.
    //
    // The floor is the point. `merged.length <= mems.length` bounds growth and says nothing about
    // shrinkage, so one rule returned for twenty passed cleanly and nineteen hand-taught rules were
    // gone — unattended, with no undo and no version history. And that isn't the model
    // misbehaving: the prompt above asks it to "DELETE anything redundant" and "Aim for ≤ 18 rules",
    // so enthusiastic collapse is the requested behaviour. The sibling path
    // (ai:consolidateMemories) never had this problem because it only PROPOSES and waits for the
    // user to approve; this one commits on its own, so it needs the bound the other gets from
    // consent.
    //
    // min(18, half) tracks the prompt's own target: a big list may always compress to 18 (the
    // documented aim), and a smaller one may at most halve. Anything past that is not a merge.
    const FLOOR = Math.min(18, Math.ceil(mems.length / 2));
    if (merged.length && merged.length <= mems.length && merged.length >= FLOOR && after !== before) {
      const now = Date.now();
      // This is destructive, automatic and irreversible, so keep what it replaced. There is no undo
      // and no history for this store; a snapshot at least makes a bad consolidation recoverable by
      // hand from config.json instead of simply lost.
      config.ai.memoriesPrev = mems.map((m) => ({ text: m.text, example: m.example || '', ts: m.ts || 0 }));
      config.ai.memories = merged.map((r) => ({ id: newMemId(), text: r.text, example: r.example || '', ts: now }));
      saveConfig();
      if (mainWindow && !mainWindow.isDestroyed()) { try { mainWindow.webContents.send('ai:memory-updated', { memories: config.ai.memories, consolidated: true }); } catch { /* ignore */ } }
    }
  } catch { /* best-effort */ }
  _autoConsolidating = false;
}


// Is the user on a measurably worse vision model than one they already have installed?
//
// This is not a nag about a model they might download — it is "you own a better one and the app is
// not using it". Jake's config pointed at llava-llama3 while qwen2.5vl:7b sat installed on the same
// machine, and llava was inventing motorcycles and shop signs that were not in the footage. Every
// name, tag and placement downstream was then built on a fabrication.
ipcMain.handle('ai:visionAdvice', async () => {
  const ai = config.ai || {};
  const current = ai.model || '';
  let installed = [];
  try { installed = await ollamaListModels(); } catch { return { ok: true, advice: null }; }

  const vision = [];
  for (const n of installed) {
    // eslint-disable-next-line no-await-in-loop
    if (await ollamaModelVision(n)) vision.push(n);
  }
  if (!vision.length) return { ok: true, advice: null };
  vision.sort((a, b) => visionRankOf(a) - visionRankOf(b));

  const best = vision[0];
  if (!current) return { ok: true, advice: { kind: 'unset', best, installed: vision } };
  if (best === current || visionRankOf(best) >= visionRankOf(current)) return { ok: true, advice: null };

  return {
    ok: true,
    advice: {
      kind: 'upgrade',
      current,
      best,
      installed: vision,
      // Say WHY, concretely. "A better model exists" is ignorable; "yours invented a motorcycle" is not.
      why: /^llava/i.test(current)
        ? `${current} invents things that aren't in the footage — on your own clips it described a pickup truck as "a person riding a motorcycle". ${best} read the text off a monitor in the same frames.`
        : `${best} is measurably more accurate at describing what is actually in a frame than ${current}.`,
    },
  };
});

// Switch to it. Kept separate from the advice so nothing is changed behind the user's back.
ipcMain.handle('ai:useVisionModel', (_e, name) => {
  const n = String(name || '').trim();
  if (!n) return { ok: false, error: 'No model' };
  config.ai = config.ai || {};
  config.ai.model = n;
  saveConfig();
  return { ok: true, model: n };
});
