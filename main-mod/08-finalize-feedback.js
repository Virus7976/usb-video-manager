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
// --- face crops live on DISK, not inside people.json --------------------------------------
//
// The crops used to be base64 data: URLs stored inline in the JSON — about 70% of the file's bytes,
// growing every single time you confirm a face, with no ceiling. A realistic mature library
// (40 people × 15 faces) was ~5 MB of JSON that had to be parsed and then held in memory in full
// the moment the People view opened. Deferring the load (LAZY_STORES) took it off the boot path but
// did nothing about the size.
//
// Crops are now ordinary .jpg files and the store keeps a file:// URL. The renderer's CSP already
// allows `img-src 'self' file: data:`, and posters are served the same way, so nothing downstream
// has to change.
//
// SAFETY: reading tolerates BOTH forms, forever. A record still carrying an inline data: URL renders
// exactly as before and is migrated opportunistically. If a crop cannot be written to disk, the
// inline copy is KEPT — a migration is never allowed to lose a face.
const FACES_DIR = path.join(STORE_DIR, 'faces');
let faceCropSeq = 0;
function saveFaceCrop(dataUrl) {
  const s = String(dataUrl || '');
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/i.exec(s);
  if (!m) return s;                       // already a file:// URL (or empty) — pass straight through
  try {
    ensureDirSync(FACES_DIR);
    const kind = m[1].toLowerCase();
    const ext = kind === 'png' ? 'png' : (kind === 'webp' ? 'webp' : 'jpg');
    faceCropSeq += 1;
    const file = path.join(FACES_DIR, `f${Date.now().toString(36)}${faceCropSeq.toString(36)}.${ext}`);
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    return pathToFileURL(file).href;
  } catch {
    return s;                             // couldn't write → keep it inline rather than lose the face
  }
}

// Delete crop files nothing points at any more.
//
// Several operations silently drop faces — deleting a person, merging two (`.slice(-60)`), removing
// a wrong crop, or simply hitting the 80-face-per-person cap. Sprinkling an unlink into each of them
// is how you eventually miss one and leak. This is reference-counted instead: it scans what the
// store ACTUALLY references and removes only files nothing points at, so it cannot delete a live
// crop no matter which call site forgot to think about it.
//
// Best-effort by construction: a GC failure must never break a save.
function gcFaceCrops() {
  try {
    if (!fs.existsSync(FACES_DIR)) return;
    // LOAD EVERY REFERENCE STORE, or the reference count is a lie. All three of these are lazy
    // (LAZY_STORES, 01-core.js) and none has a key in the config default, so an unloaded one reads
    // as `undefined` → `|| []` → its crops are simply absent from the keep-set and get unlinked.
    // `ai.people` was the one missing: `faces:saveScenes` loads only ai.faceScenes, and on the
    // renderer side people is pulled in by matchPerson — which runs PER DETECTED FACE. So a scan
    // over footage with no faces in it (b-roll, drone, product) reached the GC with people unloaded
    // and deleted EVERY enrolled crop. people.json survived, still pointing at files that no longer
    // existed, so the dashboard and review grid showed broken images with no way back.
    ensureStore('ai.people');         // enrolled faces + their cover thumbs
    ensureStore('ai.facesPending');   // pending clusters can reference crops too — never GC blind
    ensureStore('ai.faceScenes');     // …and so do the group shots. Miss this and the GC deletes every
                                      // scene frame the first time it runs — the store still points at
                                      // them, so the review grid silently shows broken images.

    // A store that FAILED to read leaves an empty default in memory. saveStore already refuses to
    // write those ("writing it would destroy the face DB") and quarantines the file — but the GC had
    // no matching guard, so the JSON was protected while the crops it references were deleted. An
    // incomplete keep-set must abort the sweep entirely: leaking a few orphans until the next clean
    // launch costs disk, and getting this wrong costs enrolment work that cannot be rebuilt.
    for (const k of ['ai.people', 'ai.facesPending', 'ai.faceScenes']) {
      if (storeReadFailed[k]) { console.error(`[people] gc: skipped — ${k} failed to read this launch`); return; }
    }
    // ⚠ THE FOURTH REFERENCE STORE. `config.ai.ignored` is part of the keep-set below, but it lives
    // in config.json — NOT a sidecar — so `storeReadFailed` never covers it and the loop above
    // cannot see it. Without this, an unreadable config.json means the session runs on defaults,
    // `ignored` reads [], and the very next people:delete / people:merge / faces:saveScenes unlinks
    // every ignored face's crop. config.json itself is left intact by the save guard, so on the next
    // good launch the Ignored view points at files that no longer exist — and each entry carries the
    // `from`/`fromName` needed to restore a CONFIRMED enrolment face, so this is a one-way loss of
    // confirmed work, not just a dismissal.
    if (config_readFailed) { console.error('[people] gc: skipped — config.json failed to read this launch'); return; }
    const keep = new Set();
    const note = (u) => {
      const s = String(u || '');
      if (!s.startsWith('file:')) return;
      try { keep.add(path.resolve(fileURLToPath(s))); } catch { /* not a path we own */ }
    };
    for (const p of ((config.ai && config.ai.people) || [])) {
      note(p.thumb);
      for (const f of (p.faces || [])) note(f.t);
    }
    for (const c of ((config.ai && config.ai.facesPending) || [])) note(c && c.thumb);
    for (const s of ((config.ai && config.ai.faceScenes) || [])) note(s && s.img);
    // Ignored faces keep their crop too — faces:ignore moves a face (with a real faces/*.jpg in `.t`)
    // into this bin. Missing it here meant the next GC unlinked the crop and the Ignored view showed
    // broken images with the crop gone for good.
    for (const f of ((config.ai && config.ai.ignored) || [])) note(f && f.t);

    let removed = 0;
    for (const name of fs.readdirSync(FACES_DIR)) {
      const full = path.resolve(path.join(FACES_DIR, name));
      if (keep.has(full)) continue;
      try { fs.unlinkSync(full); removed += 1; } catch { /* in use / gone already */ }
    }
    if (removed) console.log(`[people] gc: removed ${removed} orphaned face crop(s)`);
  } catch { /* never let housekeeping break a save */ }
}

// Stable per-face id, so an enrolment can be undone precisely. Additive: faces written before this
// existed simply have none, and an undo skips them rather than guessing.
let faceFidSeq = 0;
function newFaceFid() { faceFidSeq += 1; return `f${Date.now().toString(36)}${faceFidSeq.toString(36)}`; }

function migratePerson(p) {
  if (!Array.isArray(p.faces)) {
    const ds = Array.isArray(p.descriptors) ? p.descriptors : [];
    const ts = Array.isArray(p.thumbs) ? p.thumbs : (p.thumb ? [p.thumb] : []);
    p.faces = ds.map((d, i) => ({ d, t: ts[i] || p.thumb || '' }));
  }
  // Existing faces were user-named → treat as confirmed. New unconfirmed ones come
  // in with confirmed:false.
  p.faces.forEach((f) => { if (f.confirmed === undefined) f.confirmed = true; });
  // Opportunistically move any inline crop out to a file. saveFaceCrop returns the value unchanged
  // if it can't write, so a person is never left holding a broken reference.
  let moved = 0;
  p.faces.forEach((f) => {
    if (f.t && f.t.startsWith('data:')) { const next = saveFaceCrop(f.t); if (next !== f.t) { f.t = next; moved += 1; } }
  });
  if (p.thumb && p.thumb.startsWith('data:')) { const next = saveFaceCrop(p.thumb); if (next !== p.thumb) { p.thumb = next; moved += 1; } }
  if (moved) p._cropsMoved = moved;   // tells aiPeople() the store is worth re-saving
  if (!p.thumb && p.faces.length) p.thumb = ((p.faces.find((f) => f.confirmed && f.t) || p.faces.find((f) => f.t)) || {}).t || '';
  return p;
}
// people.json is a LAZY store (see LAZY_STORES in 01-core.js) — it is not read at boot.
// ensureStore() pulls it in the first time anyone reaches for it. Every read AND write path
// for the face DB goes through this accessor, which is what makes deferring it safe: the
// sidecar can never be read after a caller has already mutated the in-memory value.
function aiPeople() {
  ensureStore('ai.people');
  config.ai = config.ai || {};
  if (!Array.isArray(config.ai.people)) config.ai.people = [];
  config.ai.people.forEach(migratePerson);
  // If migratePerson moved any inline crop out to a file, WRITE THE STORE BACK — otherwise the
  // crops are on disk but people.json still carries the fat base64 copies, and we'd re-do the whole
  // migration on every single load while the file never actually shrinks.
  const moved = config.ai.people.reduce((n, p) => n + (p._cropsMoved || 0), 0);
  if (moved) {
    config.ai.people.forEach((p) => { delete p._cropsMoved; });
    saveStore('ai.people');
    console.log(`[people] moved ${moved} inline face crop(s) out to ${FACES_DIR}`);
  }
  return config.ai.people;
}
function aiIgnoredFaces() { config.ai = config.ai || {}; if (!Array.isArray(config.ai.ignored)) config.ai.ignored = []; return config.ai.ignored; }
function personCover(p) { return p.thumb || ((p.faces || []).find((f) => f.confirmed && f.t) || (p.faces || []).find((f) => f.t) || {}).t || ''; }
function faceDist(a, b) { if (!a || !b) return Infinity; let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i += 1) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }
function personCounts(p) { const fs = p.faces || []; const conf = fs.filter((f) => f.confirmed).length; return { count: fs.length, confirmed: conf, unconfirmed: fs.length - conf }; }
ipcMain.handle('people:get', () => aiPeople().map((p) => ({ id: p.id, name: p.name, thumb: personCover(p), ...personCounts(p) })));
ipcMain.handle('faces:ignoredCount', () => aiIgnoredFaces().length);
// Persist the unconfirmed face-review clusters so the grid (crops + all) survives
// restarts — no re-scanning to see your faces again.
// Lazy store (LAZY_STORES): the pending-face crops are only needed once the face-review grid
// is opened, so nothing reads faces-pending.json at boot. Both handlers go through this
// accessor so the sidecar is always pulled in BEFORE the value is read or replaced.
function aiFacesPending() { ensureStore('ai.facesPending'); config.ai = config.ai || {}; if (!Array.isArray(config.ai.facesPending)) config.ai.facesPending = []; return config.ai.facesPending; }
ipcMain.handle('faces:getPending', () => aiFacesPending());
ipcMain.handle('faces:savePending', (_e, list) => {
  aiFacesPending();                                    // load first, then replace
  // Externalize each crop (base64 → a faces/*.jpg file) exactly like people:save and faces:saveScenes.
  // This handler alone stored the renderer's list verbatim, so the base64 thumbs lived INLINE — that
  // is what made faces-pending.json balloon to ~9 MB and get fully re-parsed + re-serialized on every
  // 700 ms debounced save during a scan. A crop that can't be written stays inline (never lose a face).
  config.ai.facesPending = (Array.isArray(list) ? list : []).map((c) => (c && typeof c.thumb === 'string' && c.thumb.startsWith('data:') ? { ...c, thumb: saveFaceCrop(c.thumb) } : c));
  saveStore('ai.facesPending');
  return { ok: true };
});

// --- THE GROUP SHOTS --------------------------------------------------------------------------
//
// One frame per clip — whichever showed the most faces at once — plus a box per face, so a shot with
// three people can be reviewed AS that shot instead of as three disembodied heads.
//
// The frame is a ~1100px JPEG, which is an order of magnitude fatter than a 144px crop, so it goes
// straight out to the faces/ folder through the SAME saveFaceCrop path everything else uses. Inline it
// and face-scenes.json becomes megabytes of base64 that is re-read and re-written on every save. A
// frame that cannot be written is DROPPED rather than kept inline: unlike a face descriptor it is pure
// UI sugar, and it is regenerated by the next scan.
function aiFaceScenes() { ensureStore('ai.faceScenes'); config.ai = config.ai || {}; if (!Array.isArray(config.ai.faceScenes)) config.ai.faceScenes = []; return config.ai.faceScenes; }
ipcMain.handle('faces:getScenes', () => aiFaceScenes());
ipcMain.handle('faces:saveScenes', (_e, list) => {
  aiFaceScenes();                                      // load first, then replace
  const out = [];
  for (const s of (Array.isArray(list) ? list : [])) {
    if (!s || !Array.isArray(s.faces) || s.faces.length < 2) continue;   // not a group shot
    const img = saveFaceCrop(String(s.img || ''));
    // Must be a REAL file on disk. Checking "not a data: URL" is not the same thing — saveFaceCrop
    // hands anything it does not recognise straight back, so junk passed that test and got stored.
    if (!img.startsWith('file:')) continue;            // couldn't reach disk — don't fatten the JSON
    out.push({
      clipKey: String(s.clipKey || ''),
      name: String(s.name || ''),
      img,
      w: Number(s.w) || 0,
      h: Number(s.h) || 0,
      faces: s.faces
        .filter((f) => f && Array.isArray(f.descriptor) && f.box)
        .map((f) => ({
          descriptor: f.descriptor,
          box: { x: Number(f.box.x) || 0, y: Number(f.box.y) || 0, width: Number(f.box.width) || 0, height: Number(f.box.height) || 0 },
        })),
    });
  }
  config.ai.faceScenes = out;
  saveStore('ai.faceScenes');
  gcFaceCrops();                                       // a replaced scene's old frame is now garbage
  return { ok: true };
});
// Full detail incl. every face thumb + confirmed flag — for the dashboard's grid.
ipcMain.handle('people:detail', (_e, id) => {
  const p = aiPeople().find((x) => x.id === id);
  if (!p) return { ok: false };
  return { ok: true, id: p.id, name: p.name, cover: personCover(p), ...personCounts(p), faces: (p.faces || []).map((f, i) => ({ i, t: f.t || '', confirmed: !!f.confirmed })) };
});
// #49 — cap a person's face list to `cap`, shedding UNCONFIRMED faces first so the hand-confirmed
// enrolment faces (the only ones that vote in recognition) are never pushed out by a pile of auto-saved
// guesses. Every place that capped by a plain newest-N slice (save/merge/reassign) now routes here.
function capFacesKeepingConfirmed(faces, cap) {
  const list = Array.isArray(faces) ? faces : [];
  if (list.length <= cap) return list;
  const conf = list.filter((f) => f && f.confirmed);
  const unconf = list.filter((f) => !(f && f.confirmed));
  const keptConf = conf.slice(-cap);
  return keptConf.concat(unconf.slice(-Math.max(0, cap - keptConf.length)));
}
ipcMain.handle('people:save', (_e, payload) => {
  // Upsert a person by name; append new faces (descriptor + its thumb). `confirmed`
  // false = a recognized-but-not-yet-confirmed face (shows in the dashboard's
  // Unconfirmed section). Near-duplicate faces are skipped to keep the store diverse.
  const name = String((payload && payload.name) || '').trim();
  if (!name) return { ok: false, error: 'No name' };
  const descriptors = Array.isArray(payload && payload.descriptors) ? payload.descriptors.filter((d) => Array.isArray(d) && d.length) : [];
  // The renderer hands us a base64 crop straight off a canvas. Write it out to a file HERE, so no
  // new base64 ever enters people.json — otherwise the store just starts growing again.
  const thumb = saveFaceCrop(String((payload && payload.thumb) || ''));
  const confirmed = !(payload && payload.confirmed === false);
  const people = aiPeople();
  let p = people.find((x) => x.name.toLowerCase() === name.toLowerCase());
  // RECEIPT — what this save actually changed, so its inverse doesn't have to guess. Each descriptor
  // takes one of three paths below (create / append / promote), and only the first two are safe to
  // delete on undo: unpicking a PROMOTION by removing the face would destroy an enrolment that
  // existed before this assign. `fid` is an additive optional field, so an old people.json still
  // reads fine — an entry without one simply can't be undone, which is the safe direction.
  const receipt = { personId: '', createdPerson: false, addedFids: [], promotedFids: [] };
  if (!p) { p = { id: `pp${Date.now()}${Math.random().toString(36).slice(2, 6)}`, name, faces: [], thumb: '', ts: Date.now() }; people.push(p); receipt.createdPerson = true; }
  receipt.personId = p.id;
  migratePerson(p);
  for (const d of descriptors) {
    // If a near-duplicate already exists and THIS save is a confirmation, PROMOTE the existing face to
    // confirmed (and refresh its crop) instead of skipping. Confirming a suggested face saves the SAME
    // descriptors that were auto-saved unconfirmed during the scan; skipping them meant the confirmed
    // set never grew and — since only confirmed faces vote — confirmations never improved matching.
    const near = (p.faces || []).find((f) => f.d && faceDist(f.d, d) < FACE_DEDUP_T);
    if (near) {
      if (confirmed && !near.confirmed) {
        near.confirmed = true; if (thumb) near.t = thumb;
        if (!near.fid) near.fid = newFaceFid();
        receipt.promotedFids.push(near.fid);
      }
    } else {
      const fid = newFaceFid();
      p.faces.push({ d, t: thumb, confirmed, fid });
      receipt.addedFids.push(fid);
    }
  }
  if (!descriptors.length && thumb) p.faces.push({ d: null, t: thumb, confirmed });
  p.faces = capFacesKeepingConfirmed(p.faces, 80);   // shed unconfirmed guesses first (#49)
  if (thumb && confirmed && !p.thumb) p.thumb = thumb;
  saveStore('ai.people');
  return { ok: true, id: p.id, receipt };
});

// The INVERSE of people:save, replaying a receipt backwards. Face-review's Undo reversed the clip
// tags (#26) but never the enrolment, and enrolment is the half that lasts: only CONFIRMED faces
// vote in faceDecide, so mis-naming a face and pressing Undo left the recognizer permanently taught
// that this face is that person — every later scan re-suggested it and "Confirm all" propagated it
// in bulk. The only repair was people:removeFace, buried behind a right-click in the dashboard.
//
// Deliberately NARROW: it removes only the faces this save appended, demotes only the ones it
// promoted, and deletes the person only if this save created them AND they have nothing left. It
// never touches a face that predates the assign. Unknown or replayed receipts are a no-op — Undo is
// a UI button and a double-click must not eat a second face.
ipcMain.handle('people:undoAssign', (_e, receipt) => {
  const r = receipt || {};
  const people = aiPeople();
  const p = people.find((x) => x.id === String(r.personId || ''));
  if (!p) return { ok: false };
  const added = new Set((Array.isArray(r.addedFids) ? r.addedFids : []).map(String).filter(Boolean));
  const promoted = new Set((Array.isArray(r.promotedFids) ? r.promotedFids : []).map(String).filter(Boolean));
  if (Array.isArray(p.faces)) {
    if (added.size) p.faces = p.faces.filter((f) => !(f && f.fid && added.has(String(f.fid))));
    for (const f of p.faces) if (f && f.fid && promoted.has(String(f.fid))) f.confirmed = false;
  }
  // The cover may have pointed at a face that just left.
  if (p.thumb && !(p.faces || []).some((f) => f && f.t === p.thumb)) p.thumb = personCover(p);
  let removedPerson = false;
  if (r.createdPerson && !(p.faces || []).length) {
    const i = people.indexOf(p);
    if (i >= 0) { people.splice(i, 1); removedPerson = true; }
  }
  saveStore('ai.people');
  gcFaceCrops();
  return { ok: true, removedPerson };
});
// Promote an unconfirmed face to confirmed.
ipcMain.handle('people:confirmFace', (_e, payload) => {
  const p = aiPeople().find((x) => x.id === (payload && payload.id));
  const idx = Number(payload && payload.index);
  if (!p || !p.faces || !(idx >= 0 && idx < p.faces.length)) return { ok: false };
  p.faces[idx].confirmed = true;
  if (!p.thumb && p.faces[idx].t) p.thumb = p.faces[idx].t;
  saveStore('ai.people');
  return { ok: true };
});
// Move a face into the global Ignored bin (won't be suggested as a person again).
ipcMain.handle('faces:ignore', (_e, payload) => {
  const ig = aiIgnoredFaces();
  const fromId = payload && payload.id; const idx = Number(payload && payload.index);
  if (fromId !== undefined && idx >= 0) {
    const p = aiPeople().find((x) => x.id === fromId);
    // REMEMBER THE OWNER. The bin used to store the bare `{d, t, confirmed}`, so un-ignoring could
    // only drop the record — the face could never go back, even though the UI offers "Restore all
    // ignored", "Not ignored — restore" and "Restore (not ignored)". Ignoring reads as "hide this",
    // so the person quietly lost a CONFIRMED enrolment face (the only kind that votes) for good.
    // `from`/`fromName` are additive optional fields; entries binned before this simply can't be
    // restored, which faces:unignore reports rather than pretends.
    if (p && p.faces && idx < p.faces.length) { ig.push({ ...p.faces[idx], from: p.id, fromName: p.name }); p.faces.splice(idx, 1); if (p.thumb && !(p.faces || []).some((f) => f.t === p.thumb)) p.thumb = personCover(p); }
  } else if (Array.isArray(payload && payload.descriptor)) {
    // Route the crop out to a file. config.ai.ignored lives in config.json, so a raw base64 dataURL
    // here re-bloats the very file the sidecar split exists to keep small (write-amplifies every save).
    ig.push({ d: payload.descriptor, t: saveFaceCrop(String(payload.thumb || '')), confirmed: false });
  }
  if (ig.length > 200) config.ai.ignored = ig.slice(-200);
  saveStore('ai.people'); saveConfig();
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
  // ⚠ UNEXPLAINED DIVERGENCE, deliberately left alone. This asks the same question as people:save
  // above ("is this face already on this person?") but at 0.2, while that one uses FACE_DEDUP_T
  // (0.35). `a847dce` named the constant and missed this call site.
  //
  // NOT changed to the constant, because it is not a rename — it is a behaviour change to face
  // matching. 0.35 rejects MORE candidates as duplicates, so reassigning would add fewer faces to a
  // person's enrolment set, which shifts how that person matches from then on. Tighter (0.2) errs
  // toward keeping a genuine variation; looser errs toward not bloating the set. Which is right
  // cannot be settled from here — it needs a run against real face data, like every other
  // accuracy-affecting constant in this file. Measure before touching it.
  if (!(to.faces || []).some((f) => f.d && faceDist(f.d, face.d) < 0.2)) to.faces.push({ d: face.d, t: face.t, confirmed: true });
  if (face.t && !to.thumb) to.thumb = face.t;
  to.faces = capFacesKeepingConfirmed(to.faces, 80);   // #49 — keep confirmed enrolment faces
  saveStore('ai.people');
  return { ok: true, toId: to.id, toName: to.name };
});
ipcMain.handle('faces:listIgnored', () => aiIgnoredFaces().map((f, i) => ({ i, t: f.t || '' })));
// Un-ignore = put the face BACK on the person it was taken from, not merely empty the bin. Returns
// `restoredTo` so the caller can say what actually happened: an entry binned before `from` existed,
// or one whose person has since been deleted, genuinely cannot be restored and says so.
ipcMain.handle('faces:unignore', (_e, idx) => {
  const ig = aiIgnoredFaces();
  const i = Number(idx);
  if (!(i >= 0 && i < ig.length)) return { ok: true, restoredTo: '' };
  const [face] = ig.splice(i, 1);
  let restoredTo = '';
  const owner = face && face.from ? aiPeople().find((x) => x.id === face.from) : null;
  if (owner) {
    if (!Array.isArray(owner.faces)) owner.faces = [];
    // Don't re-add a face the person already has (a restore replayed, or the same face re-enrolled
    // while it sat in the bin). Same near-duplicate test people:save uses.
    const dup = face.d && owner.faces.some((f) => f.d && faceDist(f.d, face.d) < FACE_DEDUP_T);
    if (!dup) {
      const { from, fromName, ...rest } = face;   // the bookkeeping fields don't belong on a person
      owner.faces.push(rest);
      owner.faces = capFacesKeepingConfirmed(owner.faces, 80);   // #49
    }
    if (!owner.thumb && face.t) owner.thumb = face.t;
    restoredTo = owner.name || '';
    saveStore('ai.people');
  }
  saveConfig();
  return { ok: true, restoredTo };
});
// Rename a person — REFUSING a name that already belongs to someone else.
//
// Both CREATE paths dedup case-insensitively (people:save above, people:reassignFace below); rename
// did not, so the exact case the People dashboard invites — fixing a typo, "Sara" → "Sarah", when a
// "Sarah" already exists — produced TWO records with the same name. The dashboard then shows two
// indistinguishable cards, the enrolment faces stay SPLIT across both so recognition of that person
// gets WORSE rather than better, and later people:save upserts land on whichever record `find` hits
// first, so confirmations silently reach only one of them.
//
// REFUSE rather than auto-merge: people:merge combines faces and deletes the source, which is not
// something to do behind the user's back on what looks like a typo fix. Reporting `existingId` lets
// the renderer offer the merge explicitly, which is the same shape as every other destructive
// action here — the user confirms it.
ipcMain.handle('people:rename', (_e, payload) => {
  const p = aiPeople().find((x) => x.id === (payload && payload.id));
  if (!p) return { ok: false, reason: 'not-found' };
  const next = String((payload && payload.name) || '').trim();
  if (!next) return { ok: true };                       // nothing to do — keep the current name
  // Its OWN record never counts as a collision, so "jake" → "Jake" (a casing correction of the same
  // person) is allowed.
  const clash = aiPeople().find((x) => x.id !== p.id && x.name.toLowerCase() === next.toLowerCase());
  if (clash) return { ok: false, reason: 'name-exists', existingId: clash.id, name: clash.name };
  p.name = next;
  saveStore('ai.people');
  return { ok: true };
});
ipcMain.handle('people:delete', (_e, id) => { config.ai.people = aiPeople().filter((p) => p.id !== id); saveStore('ai.people'); gcFaceCrops(); return { ok: true }; });
// Merge `fromId` into `intoId` (combines faces, deletes the source) — for fixing
// the same person split across two names.
ipcMain.handle('people:merge', (_e, payload) => {
  const into = aiPeople().find((x) => x.id === (payload && payload.intoId));
  const from = aiPeople().find((x) => x.id === (payload && payload.fromId));
  if (!into || !from || into === from) return { ok: false };
  // 80, matching people:save / reassignFace / unignore. It was 60 here alone, and merge is the ONE
  // path that combines two already-enrolled sets — so it was the one place most likely to exceed the
  // cap, applying the tightest limit at the worst moment. `capFacesKeepingConfirmed` sheds unconfirmed
  // guesses first, but once confirmed faces alone exceed the cap it slices those too: merging a
  // "Sara" and a "Sarah" with 40 confirmed faces each destroyed 20 hand-confirmed enrolments, with no
  // undo. Fixing a duplicate person must not make that person harder to recognise.
  into.faces = capFacesKeepingConfirmed([...(into.faces || []), ...(from.faces || [])], 80);   // #49 — confirmed-first
  config.ai.people = aiPeople().filter((x) => x.id !== from.id);
  saveStore('ai.people');
  gcFaceCrops();
  return { ok: true };
});
// Remove one face (a wrong crop) from a person.
ipcMain.handle('people:removeFace', (_e, payload) => {
  const p = aiPeople().find((x) => x.id === (payload && payload.id));
  const idx = Number(payload && payload.index);
  if (!p || !Array.isArray(p.faces) || !(idx >= 0 && idx < p.faces.length)) return { ok: false };
  p.faces.splice(idx, 1);
  if (p.thumb && !(p.faces || []).some((f) => f.t === p.thumb)) p.thumb = personCover(p);
  saveStore('ai.people');
  gcFaceCrops();
  return { ok: true, faces: (p.faces || []).map((f, i) => ({ i, t: f.t || '' })) };
});
ipcMain.handle('people:setCover', (_e, payload) => {
  const p = aiPeople().find((x) => x.id === (payload && payload.id));
  const t = String((payload && payload.thumb) || '');
  if (!p || !t) return { ok: false };
  p.thumb = t; saveStore('ai.people'); return { ok: true };
});
// Face-recognition decision thresholds (euclidean distance on face-api's 128-d
// embeddings). Deliberately STRICT — the app must not pretend an unknown face is a
// match. Tunable via config.ai.faceThreshold (a digiKam-style sensitivity ceiling).
const FACE_CONFIRM_T = 0.46;   // <= this AND unambiguous → CONFIDENT (safe to auto-tag)
const FACE_SUGGEST_T = 0.54;   // <= this → worth SUGGESTING (ask the user); above → unknown
const FACE_MARGIN = 0.04;      // the winner must beat the nearest OTHER person by this
const FACE_KNN = 5;            // vote among the K nearest confirmed faces (robust to one outlier)
// Two descriptors this close are the SAME face seen twice, not two views of a person — used when
// saving a face onto a person, so an all-but-identical crop is de-duplicated instead of padding the
// enrolment set (and, via #28, so confirming a suggestion promotes the existing unconfirmed copy
// rather than being skipped as a duplicate). Much tighter than FACE_CONFIRM_T: this is "is this the
// same photo of a face", not "is this the same person". It was a bare `0.35` at the one call site.
const FACE_DEDUP_T = 0.35;

// ⚠ THE RENDERER HAS ITS OWN COPY of the confirm/suggest values (src/mod/08-people.js:
// FACE_CONFIRM_DIST / FACE_SUGGEST_DIST) because main and renderer are SEPARATE concatenated
// bundles with no shared module — a single constant is not physically possible across the process
// boundary. They must stay numerically identical, and `face-thresholds-parity.test.mjs` fails if
// they drift. If you change one, change both.

// PURE decision (no electron/config deps → unit-testable). Given a query descriptor,
// a list of CONFIRMED enrolled faces `[{id,name,d}]`, the IGNORED faces `[{d}]`, and a
// suggest ceiling, decide who (if anyone) it is — digiKam-style:
//   • Only CONFIRMED faces vote (caller filters) — an unconfirmed guess never drives a match.
//   • k-nearest-neighbour PLURALITY vote so one noisy descriptor can't win.
//   • Require an ambiguity MARGIN over the 2nd-closest *different* person.
//   • Nothing within suggestT → null (genuinely unknown; never pretend).
// Returns { match, dist, confidence(0..1), confident } — `confident` gates auto-tagging.
function faceDecide(desc, confirmed, ignored, suggestT) {
  if (!desc) return { match: null, dist: Infinity };
  let ignD = Infinity;
  for (const f of (ignored || [])) { if (f && f.d) { const d = faceDist(desc, f.d); if (d < ignD) ignD = d; } }
  const scored = [];
  for (const f of (confirmed || [])) { if (f && f.d) scored.push({ id: f.id, name: f.name, dist: faceDist(desc, f.d) }); }
  if (!scored.length) {
    // Nobody enrolled yet — but an IGNORED face must STILL read as ignored, or a dismissed
    // statue/TV/poster re-clusters as "new face" on every scan until you happen to name someone
    // (#46). The old early-return skipped the ignore check whenever confirmed was empty. Caught by
    // the e2e test that ignores a face before any person exists.
    if (ignD <= suggestT) return { match: null, dist: Infinity, ignored: true };
    return { match: null, dist: Infinity };
  }
  scored.sort((a, b) => a.dist - b.dist);
  const bestD = scored[0].dist;
  if (ignD <= bestD && ignD <= suggestT) return { match: null, dist: bestD, ignored: true };
  if (bestD > suggestT) return { match: null, dist: bestD };

  const knn = scored.slice(0, FACE_KNN);
  const votes = new Map();
  for (const s of knn) { const v = votes.get(s.id) || { count: 0 }; v.count += 1; votes.set(s.id, v); }
  const winnerId = scored[0].id;
  let topId = winnerId; let topCount = -1;
  for (const [id, v] of votes) { if (v.count > topCount) { topCount = v.count; topId = id; } }
  const winsVote = topId === winnerId;

  const other = scored.find((s) => s.id !== winnerId);
  const margin = (other ? other.dist : Infinity) - bestD;
  const ambiguous = margin < FACE_MARGIN;

  const distScore = Math.max(0, Math.min(1, (suggestT - bestD) / (suggestT - 0.30)));
  const voteScore = (votes.get(winnerId) ? votes.get(winnerId).count : 1) / FACE_KNN;
  const marginScore = Math.max(0, Math.min(1, margin / 0.15));
  const confidence = +(0.5 * distScore + 0.25 * voteScore + 0.25 * marginScore).toFixed(3);

  if ((ambiguous || !winsVote) && bestD > FACE_CONFIRM_T) return { match: null, dist: bestD, ambiguous };
  const confident = bestD <= FACE_CONFIRM_T && winsVote && !ambiguous;
  return { match: { id: scored[0].id, name: scored[0].name, dist: bestD }, dist: bestD, confidence, confident };
}
// Given a face descriptor, decide who (if anyone) it is. Builds the CONFIRMED-only
// enrolled set + ignored bin, then defers to faceDecide (above).
ipcMain.handle('people:match', (_e, payload) => {
  const desc = Array.isArray(payload && payload.descriptor) ? payload.descriptor : null;
  if (!desc) return { ok: true, match: null, dist: Infinity };
  const cfgT = Number(config.ai && config.ai.faceThreshold);
  const suggestT = Math.min(Number(payload && payload.threshold) || FACE_SUGGEST_T,
    (isFinite(cfgT) && cfgT > 0) ? cfgT : FACE_SUGGEST_T);
  const r = faceDecide(desc, confirmedFaceSet(), aiIgnoredFaces(), suggestT);
  return { ok: true, ...r };
});

// Match MANY descriptors in one call (audit #75). The renderer detects several faces per clip and
// used to `await` one IPC per face inside a loop — so a scan paid a round-trip per face on top of
// rebuilding the enrolled set each time. Same decision function, same inputs, once per descriptor:
// this is purely about how many times we cross the bridge and rebuild the set, never about the
// verdict. `people-match-batch.test.mjs` pins that equivalence.
ipcMain.handle('people:matchBatch', (_evt, payload) => {
  const list = Array.isArray(payload && payload.descriptors) ? payload.descriptors : [];
  const cfgT = Number(config.ai && config.ai.faceThreshold);
  const suggestT = Math.min(Number(payload && payload.threshold) || FACE_SUGGEST_T,
    (isFinite(cfgT) && cfgT > 0) ? cfgT : FACE_SUGGEST_T);
  const set = confirmedFaceSet();          // built ONCE for the whole batch
  const ignored = aiIgnoredFaces();
  const results = list.map((desc) => (Array.isArray(desc)
    ? { ok: true, ...faceDecide(desc, set, ignored, suggestT) }
    : { ok: true, match: null, dist: Infinity }));
  return { ok: true, results };
});

// The flattened set of CONFIRMED enrolment faces — the only ones that vote (audit #75).
//
// This was rebuilt by walking every person x every face on EVERY match call, and the renderer calls
// match once per detected face, so a scan of a few thousand clips rebuilt it thousands of times.
//
// Invalidation is deliberately NOT sprinkled across the eleven places that mutate people — that is
// exactly how a sibling path gets missed. Two mechanisms cover it between them:
//   - identity: `aiPeople()` returns a NEW array whenever the store is re-read from disk, so an
//     external/rewritten store invalidates itself here;
//   - `saveStore('ai.people')` calls invalidateConfirmedFaces(), which catches in-place mutations
//     (pushing a face onto an existing person keeps the same array identity).
// Anything that changes people and does NOT persist would be a bug on its own terms.
let _confirmedFaces = null;
let _confirmedFacesFrom = null;   // the exact array identity the cache was built from
function invalidateConfirmedFaces() { _confirmedFaces = null; _confirmedFacesFrom = null; }
function confirmedFaceSet() {
  const people = aiPeople();
  if (_confirmedFaces && _confirmedFacesFrom === people) return _confirmedFaces;
  const out = [];
  for (const p of people) { for (const f of (p.faces || [])) { if (f.d && f.confirmed) out.push({ id: p.id, name: p.name, d: f.d }); } }
  _confirmedFaces = out; _confirmedFacesFrom = people;
  return out;
}

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
    const extract = (ss) => extractFrame(srcPath, ss, outPath, '960:-2');
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
        const ok = await extractFrame(srcPath, ss, out, '1100:-2');
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
    const merged = extractRulesFrom(o);
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

// MOST-USED FIRST. The stored list is alphabetical (subjects:add sorts it), and he has 396 remembered
// subjects — so the dropdown opened on "abby, adjusting-airsoft-gun, aiden…" while the words he
// actually uses sat hundreds of entries down. Measured on his real drafts: 112 subjects in use,
// `talking-head` 28 · `liam` 14 · `vlog` 7 … and **88 used exactly once**, which makes alphabetical
// close to worst-case — the one-offs are scattered through the exact place his real vocabulary
// belongs.
//
// The combobox was already built for this: "empty query keeps the caller's order (e.g. most-used
// descriptions first)". Nothing ever handed it a ranked list.
//
// A READ-ORDER view only — `config.subjects` is not touched, so storage never depends on when it was
// last read. Once he types a character the fuzzy scorer takes over as before. Counts come from drafts
// AND finalMeta: a subject he has FILED is the strongest signal of what he actually shoots.
ipcMain.handle('subjects:get', () => {
  const all = config.subjects || [];
  const counts = new Map();
  const bump = (v) => {
    const s = String((v && v.subject) || '').trim();
    if (s) counts.set(s, (counts.get(s) || 0) + 1);
  };
  try { for (const v of Object.values(currentDrafts() || {})) bump(v); } catch { /* ignore */ }
  try { for (const v of Object.values(currentFinalMeta() || {})) bump(v); } catch { /* ignore */ }
  if (!counts.size) return all;
  // Stable: used ones by count (desc), then everything else in the alphabetical order it arrived in.
  const used = all.filter((s) => counts.has(s)).sort((a, b) => (counts.get(b) - counts.get(a)) || a.localeCompare(b));
  const rest = all.filter((s) => !counts.has(s));
  return used.concat(rest);
});

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
// Drafts live in their own sidecar file now (drafts.json); freshStore re-reads it only
// if another process changed it since our last write — no more whole-config reload-merge.
function currentDrafts() { return freshStore('renameDrafts'); }

ipcMain.handle('drafts:get', () => currentDrafts());

// ADD/UPDATE-only, and a NO-OP when the incoming map carries no real data. This
// is the crucial guard: a session showing blank fields auto-saves an empty map,
// which now writes NOTHING — so it can never wipe previously-saved names.
// Removal happens solely via drafts:clear (when footage is copied).
// Fields that hold user work we must NEVER silently destroy. An incoming save that
// carries an EMPTY value for one of these can only be a stale/flag-only write (a
// face-scan flush, or a save that fired before restore re-applied the drafts) — it
// must not erase a name you already saved. This is the guard that makes a repeat of
// the "reopened and all my renames were gone" data loss impossible.
// The guard is a DENYLIST, not an allowlist.
//
// It used to name the protected fields explicitly (subject, description, location, …), which meant
// anything NOT on that list fell straight through `{...prev, ...incoming}` and could be blanked by
// a stale write. Three things were quietly unprotected:
//   • `facesScanned` — a stale save could flip it back to false, and the whole card would then be
//     re-face-scanned from scratch;
//   • `ledgerRel` — the same-shoot project the user explicitly confirmed;
//   • the user's CUSTOM organize fields, whose names we cannot know ahead of time (organizeFields
//     is user-configurable), so an allowlist can never cover them by construction.
//
// So: every field that has ever been saved is protected, and only the fields we explicitly WANT to
// be clearable may be cleared. That is the safe default — a new field added to the draft record is
// protected automatically instead of silently unguarded.
const draftNonEmpty = (val) => (Array.isArray(val) ? val.length > 0 : !!val);
// ⚠ "Does this draft hold WORK?" — the predicate that decides what the 60-day prune and DRAFTS_CAP
// are allowed to throw away. It used to read subject/description/location only, which meant a clip
// whose only content was a CONFIRMED FACE counted as empty and was shed first.
//
// Measured on his real store (2026-07-20): 4594 drafts, of which **200 hold `people` and nothing
// else** — i.e. 200 clips where the only record of his face-tagging was the thing being deleted.
// `clips:tagPerson` writes `rec.people` without touching `rec.ts`, so those records also carry a
// stale timestamp and are the FIRST to cross the 60-day line.
//
// Why this is an explicit list and NOT "any field that isn't clearable": `facesScanned` is present
// on all 4594 drafts and `date` on 4588. Both are bookkeeping the app wrote, not work he did, so a
// generic rule would make every draft permanently unprunable and defeat the cap entirely. Measured,
// not assumed — the generic version was written first and the numbers rejected it.
//
// ⚠ THE FIELD LIST IS INLINE ON PURPOSE — do not lift it to a module `const`.
//
// `const` does not hoist across the bundle, and 01-core.js calls this function at MODULE-INIT time
// (the DRAFTS_CAP boot trim, which fires on his 4594-draft store) — before 08's consts exist. A
// hoisted `function` is fine; a `const` it closes over is a TDZ crash at launch. The same reason
// this must not reference DRAFT_CLEARABLE, declared just below.
function draftIsNamed(v) {
  if (!v || typeof v !== 'object') return false;
  for (const k of ['subject', 'description', 'location', 'category', 'tags', 'people', 'shotType', 'observation']) {
    const val = v[k];
    if (Array.isArray(val) ? val.length > 0 : !!val) return true;
  }
  return false;
}
// `selected` is a UI tick, not work: unticking a clip MUST be able to persist. `ts` is bookkeeping.
const DRAFT_CLEARABLE = new Set(['selected', 'ts']);
// Merge an incoming draft onto the stored one WITHOUT ever blanking saved content.
function mergeDraft(prev, incoming) {
  const merged = { ...(prev || {}), ...incoming };
  if (!prev) return merged;
  for (const [f, pv] of Object.entries(prev)) {
    if (DRAFT_CLEARABLE.has(f)) continue;
    // An empty incoming value for a field we already hold content for can only be a stale or
    // flag-only write (a face-scan flush, or a save that fired before restore re-applied drafts).
    if (!draftNonEmpty(incoming[f]) && draftNonEmpty(pv)) merged[f] = pv;
  }
  return merged;
}
// THE draft write. Owned by one function so the async handler and the synchronous quit-time flush
// below cannot drift apart — the non-destructive upsert and the never-evict-a-named-draft pruning
// are the whole reason drafts survive, and a second copy of that logic would eventually diverge.
function writeDrafts(map) {
  if (!map || typeof map !== 'object') return false;
  const hasData = (v) => v && Object.entries(v).some(([k, val]) => k !== 'ts' && draftNonEmpty(val));
  const additions = Object.entries(map).filter(([, v]) => hasData(v));
  if (!additions.length) return true;
  const drafts = currentDrafts();
  const now = Date.now();
  // NON-DESTRUCTIVE upsert: set/update fields, but never overwrite saved content with
  // an empty value. A save can add a name; it can never blank one out.
  for (const [k, v] of additions) {
    drafts[k] = { ...mergeDraft(drafts[k], v), ts: now };
    // SUPERSEDE THE LEGACY TWIN. #8 writes new drafts under `name__size__mtime` and reads fall back
    // to `name__size`, and nothing on disk was ever removed — "rewrite-free". Safe in isolation, but
    // this function MERGES, so the first save after the migration went live added a SECOND entry for
    // every clip instead of replacing one. Measured on the real store: 4594 drafts became 9188, 331
    // typed names became 662, and the store hit 92% of DRAFTS_CAP with 812 entries of headroom.
    // Nothing was lost or mis-read — reads resolve V2-then-legacy — but the next card would start
    // evicting, and an evicted `facesScanned` flag means a clip gets re-scanned for nothing.
    //
    // This is a PER-WRITE supersede, not the cleanup pass the notes rightly forbid: no sweep, no
    // rewrite of entries nobody touched. A legacy entry disappears only at the moment its V2
    // replacement is written.
    //
    // ⚠ The legacy key is AMBIGUOUS — two clips sharing a name and size share it — so it may hold a
    // name typed for a DIFFERENT clip. Never drop a NAMED legacy entry for an unnamed replacement:
    // losing a duplicate is housekeeping, losing a typed name is what this whole area exists to
    // prevent.
    if (clipKeyHasMtime(k)) {
      const stem = clipKeyStem(k);
      if (stem && stem !== k && drafts[stem] && (draftIsNamed(drafts[k]) || !draftIsNamed(drafts[stem]))) {
        delete drafts[stem];
      }
    }
  }
  // Prune: drop entries older than 60 days; cap generously (users have thousands of
  // clips) and — crucially — NEVER evict a NAMED draft to make room for a flag-only one.
  // The AGE filter must exempt NAMED drafts, exactly as finalMeta:save exempts unconsumed work
  // ("An entry is only evictable once finalize:run has actually FILED that clip"). A typed name for
  // footage that hasn't been copied yet is the same kind of unconsumed work, and 01-core.js states
  // the intended contract outright: "Drafts are only removed by drafts:clear (when the footage is
  // copied)." Without the exemption, a card named but left uncopied for two months lost those names
  // — and because this prune runs on EVERY writeDrafts call, editing one clip today deleted another
  // clip's older name. The filter still sheds old FLAG-ONLY records, which carry no user work.
  const MAX_AGE = 60 * 24 * 3600 * 1000;
  let entries = Object.entries(drafts).filter(([, v]) => v && (draftIsNamed(v) || (now - (v.ts || 0)) < MAX_AGE));
  if (entries.length > DRAFTS_CAP) {
    entries.sort((a, b) => {
      const na = draftIsNamed(a[1]); const nb = draftIsNamed(b[1]);
      if (na !== nb) return na ? -1 : 1;              // named drafts are kept over flag-only ones
      return (b[1].ts || 0) - (a[1].ts || 0);         // then most-recent
    });
    entries = entries.slice(0, DRAFTS_CAP);
  }
  config.renameDrafts = Object.fromEntries(entries);
  saveStore('renameDrafts');
  return true;
}
ipcMain.handle('drafts:save', (_evt, map) => writeDrafts(map));

// Clear drafts: the given keys (consumed by a copy), or all of them.
//
// #8: the same cross-form match as copied:forget, and for the mirror-image reason. Here a MISS is
// the bad direction — the draft survives the copy, so re-inserting the card re-offers a name the
// user already dealt with, and drafts.json grows until DRAFTS_CAP evicts something still pending.
// A BLEED would delete a different clip's typed name, but it cannot happen: two clips only match
// across forms when they share name AND size, and under the legacy key those were ONE entry to
// begin with. Two fully-qualified keys that differ never match (clipKeyMatches returns false).
ipcMain.handle('drafts:clear', (_evt, keys) => {
  const drafts = currentDrafts();
  if (Array.isArray(keys) && keys.length) {
    const asked = keys.map(String).filter(Boolean);
    for (const k of Object.keys(drafts)) {
      if (asked.some((w) => clipKeyMatches(w, k))) delete drafts[k];
    }
  } else {
    config.renameDrafts = {};
  }
  saveStore('renameDrafts');
  return true;
});

// ---------------------------------------------------------------------------
// Version history / save points. A "version" is a full snapshot of every clip's
// editable naming fields (same shape as a draft map), captured manually or
// automatically before an AI run, so the user can roll back. Persisted in config
// as a newest-first array; capped so it can't grow without bound.
// ---------------------------------------------------------------------------
function currentVersions() {
  const list = freshStore('renameVersions');
  if (!Array.isArray(list)) { config.renameVersions = []; return config.renameVersions; }
  return list;
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
  saveStore('renameVersions');
  return list;
});
ipcMain.handle('versions:delete', (_evt, id) => {
  config.renameVersions = currentVersions().filter((v) => v && v.id !== id);
  saveStore('renameVersions');
  return config.renameVersions;
});
ipcMain.handle('versions:clear', () => { config.renameVersions = []; saveStore('renameVersions'); return []; });

// ---------------------------------------------------------------------------
// Metadata-by-final-filename store. renameDrafts is keyed by the SOURCE clip
// (name+size), but compressed files are re-encoded — different size, sometimes a
// different container — so the draft key can't match them. When a copy finishes,
// the renderer persists a record keyed by the clip's FINAL filename (e.g.
// 2026-06-01_vlog_josiah_v1.mp4) so the Finalize step can match the compressed
// file by name and write its metadata. Keyed lower-cased for robust matching.
// ---------------------------------------------------------------------------
function currentFinalMeta() { return freshStore('finalMeta'); }

// --- copiedLog: "what have I copied off a card, and where did it land?" ------------------
//
// Keyed by the stable name__size fingerprint of the SOURCE file, so it still matches after a
// replug under a different drive letter, and after a restart. This is what lets the Delete step
// work in a LATER session — the user's actual workflow is copy → compress → organize → and only
// then clear the card, which could be days apart.
//
// It is a convenience for REBUILDING the delete list, never an authority to delete: delete:source
// re-hashes source against dest itself and refuses anything it cannot prove. A stale or wrong
// record here can therefore cause a file to be offered and then refused — never wrongly deleted.
function currentCopiedLog() { return freshStore('copiedLog'); }

ipcMain.handle('copied:record', (_evt, entries) => {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && e.key && e.source && e.dest);
  if (!list.length) return true;
  const store = currentCopiedLog();
  const now = Date.now();
  for (const e of list) store[String(e.key)] = { source: String(e.source), dest: String(e.dest), name: String(e.name || ''), ts: now };
  config.copiedLog = store;
  saveStore('copiedLog');
  return true;
});

// Return only the records whose COPY still exists on disk. A record whose destination has been
// moved, renamed by the compressor, or deleted proves nothing any more — offering it for deletion
// would be offering to delete footage whose only other copy is gone.
ipcMain.handle('copied:get', async (_evt, keys) => {
  const store = currentCopiedLog();
  const want = Array.isArray(keys) && keys.length ? keys.map(String).filter(Boolean) : null;
  const out = {};
  const dead = [];
  for (const [k, v] of Object.entries(store)) {
    // #8: match across key forms. A record written before the migration carries `name__size`, while
    // the caller now asks with `name__size__mtime`. An exact-match miss reads as "not copied yet",
    // which makes the Delete step refuse to clear a card whose footage IS safely on disk — the only
    // cure being to copy the whole card again, which is precisely what this store exists to avoid.
    const asked = want ? want.find((w) => clipKeyMatches(w, k)) : k;
    if (want && !asked) continue;
    if (!v || !v.dest) { dead.push(k); continue; }
    // Keyed by what the CALLER ASKED FOR, not by how the record happens to be stored. The renderer
    // looks the result up by the key it sent, so returning the store's key would hand back a record
    // it then fails to find — a miss dressed up as a hit.
    try { await fsp.stat(v.dest); out[asked] = v; } catch { dead.push(k); }   // the copy is gone → forget it
  }
  if (dead.length) {
    for (const k of dead) delete store[k];
    config.copiedLog = store; saveStore('copiedLog');
  }
  return out;
});

// The AI's outstanding questions. Keyed by clipKey (name__size), never by array index — see the
// STORE_FILES note. Whole-list replace: the renderer owns the queue and re-saves it on every
// change, so there is no merge to get wrong.
ipcMain.handle('aiq:save', (_evt, list) => {
  const clean = (Array.isArray(list) ? list : []).filter((q) => q && q.type).map((q) => ({
    type: String(q.type),
    clipKey: q.clipKey ? String(q.clipKey) : '',
    field: q.field ? String(q.field) : '',
    suggested: q.suggested ? String(q.suggested) : '',
    rule: q.rule ? String(q.rule) : '',
  }));
  config.aiQueue = clean;
  saveStore('aiQueue');
  return true;
});

ipcMain.handle('aiq:get', () => freshStore('aiQueue') || []);

ipcMain.handle('copied:forget', (_evt, keys) => {
  const store = currentCopiedLog();
  let changed = false;
  // #8: same cross-form match as copied:get. A forget that MISSES is the dangerous direction — the
  // app would go on believing a clip is copied when its record should have been cleared.
  const asked = (Array.isArray(keys) ? keys : []).map(String).filter(Boolean);
  for (const k of Object.keys(store)) {
    if (!asked.some((w) => clipKeyMatches(w, k))) continue;
    delete store[k]; changed = true;
  }
  if (changed) { config.copiedLog = store; saveStore('copiedLog'); }
  return true;
});

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
      // Booleans are kept AS booleans. Everything else here is text, and blanket-stringifying was
      // fine while this store held only text — but it is a trap the moment a flag lands in it:
      // `String(false)` is `'false'`, which is TRUTHY, so a `false` written here would read back as
      // `true` forever. `facesScanned` is the first such flag (it is what lets a scan started from
      // the Finalize screen be remembered), and it must be able to say "no".
      else if (typeof val === 'boolean') rec[k] = val;
      else rec[k] = (val == null ? '' : String(val));
    }
    if (!Array.isArray(rec.keywords)) rec.keywords = [];
    store[String(name).toLowerCase()] = rec;
  }
  // Prune — but NEVER evict metadata for a clip that hasn't been organized yet.
  //
  // This store is the ONLY carrier of the AI's work across the gap between "copy to intake" and
  // "organize the output folder", and that gap is deliberately LONG: the whole workflow is to let
  // Tdarr compress, then come back to it later. Dropping entries at 180 days and capping to the
  // 5000 most recent therefore silently deleted work the user had not consumed yet — come back to
  // a shoot seven months later, or after 5000 newer clips, and everything the AI concluded was
  // gone, with no warning. That is precisely the "it forgets to remember things" complaint.
  //
  // An entry is only evictable once finalize:run has actually FILED that clip (`done: true`).
  // Anything still pending is unconsumed user work and is kept regardless of age. The hard cap is
  // a runaway backstop, and it sheds FILED entries first — it will not throw away pending work to
  // stay under a limit.
  const MAX_AGE = 180 * 24 * 3600 * 1000;
  const HARD_CAP = 50000;
  const isDone = (v) => !!(v && v.done);
  let entries = Object.entries(store).filter(([, v]) => v && (!isDone(v) || (now - (v.ts || 0)) < MAX_AGE));
  if (entries.length > HARD_CAP) {
    // Oldest FILED entries go first; pending work is only touched if it alone blows the cap.
    entries.sort((a, b) => (isDone(a[1]) === isDone(b[1]))
      ? (b[1].ts || 0) - (a[1].ts || 0)
      : (isDone(a[1]) ? 1 : -1));
    entries = entries.slice(0, HARD_CAP);
  }
  config.finalMeta = Object.fromEntries(entries);
  saveStore('finalMeta');
  return true;
});

// Mark clips as FILED, so their metadata becomes evictable by the prune above. Called by
// finalize:run once a clip has actually been organized — until then its metadata is pending
// work and the store must hold on to it however long that takes.
function markFinalMetaDone(names) {
  const store = currentFinalMeta();
  let changed = false;
  for (const n of (Array.isArray(names) ? names : [])) {
    const k = String(n || '').toLowerCase();
    if (store[k] && !store[k].done) { store[k].done = true; changed = true; }
  }
  if (changed) { config.finalMeta = store; saveStore('finalMeta'); }
}

// The inverse: a clip that was UN-filed is pending work again, so its metadata must stop being
// evictable. organize:undo restored the files, reversed the ledger and cleared lastOrganize, but
// never cleared this flag — leaving the clip unfiled while still flagged filed. `done` is the sole
// gate on the finalMeta prune AND what makes an entry shed first under the hard cap, so an undone
// clip became age-evictable at 180 days; once evicted, finalize:run filters it out (`it.meta`
// required) and it can never be organized again. That is the same "the AI's work silently gone"
// outcome the skipMove guard above exists to prevent, re-created from the other side.
//
// Only the clips the undo actually restored are cleared — a move that failed is still filed
// somewhere, and reopening its metadata would be a different kind of wrong.
function clearFinalMetaDone(names) {
  const store = currentFinalMeta();
  let changed = false;
  for (const n of (Array.isArray(names) ? names : [])) {
    const k = String(n || '').toLowerCase();
    if (store[k] && store[k].done) { store[k].done = false; changed = true; }
  }
  if (changed) { config.finalMeta = store; saveStore('finalMeta'); }
}

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
  // #44 (the AI-leak half): clipObs holds the per-clip OBSERVATION text — plain prose with no
  // people array — which is fed back into the naming loop and can be re-embedded. If we don't swap
  // the name here too, a renamed person keeps leaking their OLD name into future AI context and
  // re-embeds long after the retag. (Only on a rename; a removal leaves the prose alone.) NOTE:
  // versions.json snapshots are deliberately NOT rewritten — a restore point is a point-in-time
  // record, and editing old snapshots would corrupt that guarantee (restoring one legitimately
  // brings back that moment's state).
  if (to) {
    const obsStore = clipObsStore();
    let obsFixed = 0;
    for (const k of Object.keys(obsStore)) {
      const rec = obsStore[k];
      if (rec && typeof rec.obs === 'string') { const nx = fixText(rec.obs); if (nx !== rec.obs) { rec.obs = nx; obsFixed += 1; } }
    }
    if (obsFixed) saveStore('ai.clipObs');
  }
  // These are sidecar stores — persist them directly. (A plain saveConfig() would STRIP
  // finalMeta/renameDrafts from config.json and never write the sidecars → retag lost.)
  saveStore('finalMeta');
  saveStore('renameDrafts');
  return { ok: true, changed };
});

// Tag specific clips with a person BY KEY (audit #26/#27).
//
// The renderer's `tagClips()` resolves a cluster's clipKeys through a map built from
// `state.scannedFiles`, so it can only ever tag clips currently in memory. A cluster restored from
// faces-pending.json legitimately references clips from EARLIER sessions — already renamed, already
// filed — and those keys just miss the lookup, so confirming a persisted face tagged none of them.
// The renderer cannot fix that alone: the clips aren't in memory to fix. This reaches the persisted
// records directly.
//
// Deliberately ADD-ONLY: it never removes a person and never creates a record for an unknown key
// (a cluster can reference a clip whose record was pruned, and resurrecting a stub carrying nothing
// but a person would be worse than the missing tag).
// Do two clip keys refer to the same clip, across the #8 migration boundary?
//
// A face cluster's `clipKeys` are sent here to tag people onto drafts/finalMeta. Drafts are now
// keyed `name__size__mtime`, but a cluster saved before that carries the legacy `name__size` — and
// an EXACT string match meant such a cluster tagged NOTHING while still reporting ok, because
// `tagged` is not surfaced anywhere the user looks.
//
// The legacy key is a prefix of the new one, so stem-matching would "work" — and would re-introduce
// the exact collision the migration removes, letting a name confirmed on one card land on an
// identically-named clip from another. So: when BOTH keys carry an mtime, require exact equality;
// fall back to the stem only when one of them genuinely lacks it, where no better information
// exists and stem-matching is already today's behaviour.
function clipKeyStem(k) {
  const s = String(k || '');
  const i = s.indexOf('__');
  if (i < 0) return '';
  const j = s.indexOf('__', i + 2);
  return j < 0 ? s : s.slice(0, j);
}
function clipKeyHasMtime(k) { return clipKeyStem(k) !== '' && String(k || '') !== clipKeyStem(k); }
function clipKeyMatches(a, b) {
  const x = String(a || ''); const y = String(b || '');
  if (!x || !y) return false;
  if (x === y) return true;
  // Both fully qualified and not equal → genuinely different clips. Never fall through to the stem.
  if (clipKeyHasMtime(x) && clipKeyHasMtime(y)) return false;
  const sx = clipKeyStem(x); const sy = clipKeyStem(y);
  return !!sx && sx === sy;
}

ipcMain.handle('clips:tagPerson', (_evt, payload) => {
  const name = String((payload && payload.name) || '').trim();
  const keys = Array.isArray(payload && payload.keys) ? payload.keys.map((k) => String(k || '')).filter(Boolean) : [];
  if (!name || !keys.length) return { ok: false, tagged: 0 };
  let tagged = 0;
  const apply = (store) => {
    for (const k of Object.keys(store)) {
      // #8: match across key forms, not by exact string — see clipKeyMatches.
      if (!keys.some((w) => clipKeyMatches(w, k))) continue;
      const rec = store[k]; if (!rec) continue;
      const cur = Array.isArray(rec.people) ? rec.people : [];
      if (cur.includes(name)) continue;         // idempotent: re-confirming must not duplicate
      rec.people = [...new Set([...cur, name])];
      tagged += 1;
    }
  };
  apply(currentFinalMeta());
  apply(currentDrafts());
  // Sidecar stores — persist directly. A plain saveConfig() would STRIP finalMeta/renameDrafts from
  // config.json and never write the sidecars, losing the tag (same trap as clips:retagPerson).
  if (tagged) { saveStore('finalMeta'); saveStore('renameDrafts'); }
  return { ok: true, tagged };
});

// The reverse of clips:tagPerson — used by "Undo" in the face review.
//
// Adding the write side (#26) without the reverse side left Undo half-working: it reset the card but
// the person stayed tagged on every clip, now PERSISTED as well. A write-through needs its inverse
// or "undo" quietly means "undo the part you can see".
//
// Remove-only, mirroring its sibling: it never adds a person, never creates a record for an unknown
// key, and reports how many records it actually changed so a repeat is visibly a no-op.
ipcMain.handle('clips:untagPerson', (_evt, payload) => {
  const name = String((payload && payload.name) || '').trim();
  const keys = Array.isArray(payload && payload.keys) ? payload.keys.map((k) => String(k || '')).filter(Boolean) : [];
  if (!name || !keys.length) return { ok: false, untagged: 0 };
  let untagged = 0;
  const apply = (store) => {
    for (const k of Object.keys(store)) {
      // #8: the SAME cross-form match as its sibling. Undo has to reach whatever tagPerson reached —
      // an exact-match untag against a migrated draft would leave the tag behind permanently.
      if (!keys.some((w) => clipKeyMatches(w, k))) continue;
      const rec = store[k]; if (!rec || !Array.isArray(rec.people)) continue;
      if (!rec.people.includes(name)) continue;
      rec.people = rec.people.filter((n) => n !== name);
      untagged += 1;
    }
  };
  apply(currentFinalMeta());
  apply(currentDrafts());
  // Sidecar stores — persist directly (saveConfig() would strip them; same trap as clips:tagPerson).
  if (untagged) { saveStore('finalMeta'); saveStore('renameDrafts'); }
  return { ok: true, untagged };
});

ipcMain.handle('finalMeta:get', () => currentFinalMeta());

