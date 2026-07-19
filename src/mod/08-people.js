// ---------------------------------------------------------------------------
// Face recognition (fully local, opt-in). Detection runs HERE via face-api.js
// (WebGL, no native modules); main persists/matches descriptors. Named people are
// auto-tagged onto clips → flow into XMP PersonInImage + keywords at Finalize.
// Degrades gracefully when the face-api library / weights aren't installed yet.
// ---------------------------------------------------------------------------
let _faceReady = null;
let faceScanAborted = false;
// True only while a face scan is running. Used to coalesce the faces-pending saves far harder
// during a scan — see PENDING_SAVE_MS (audit #67).
let faceScanActive = false;
function faceDist(a, b) { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i += 1) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }

// --- RECOGNITION DISTANCES (euclidean, face-api 128-d descriptors) ----------------------------
// These are MEASURED values, not preferences — see usb-app-tool-strings-are-input. They were bare
// literals repeated across five call sites, which is how thresholds that interact silently drift
// apart (audit #91). One name per decision, so a retune is one edit and shows up in review.
//
// Measured 2026-07-18 on the face fixture (three genuinely different people, real face-api run):
// the closest DISTINCT pair was 0.6028 (others 0.6511, 0.7116). So 0.5 has ~0.10 of margin on that
// sample — it does NOT fuse those three.
//
// KNOWN WEAKNESS (audit #13, deliberately NOT changed blind): clustering at 0.50 is LOOSER than the
// auto-tag threshold of 0.46 — the app is more willing to fuse two UNKNOWN faces than to tag a known
// one, which is backwards, because the two errors are not symmetric:
//   • a bad MERGE is expensive — confirming the fused card tags BOTH people and poisons the
//     person's training set (only confirmed faces vote, so the damage compounds);
//   • a bad SPLIT is cheap — you just see two cards for one person and name both.
// Close relatives (Jake shoots siblings) are exactly where 0.50 is suspect, and the fixture has no
// sibling pair to prove it with. Retuning needs a measurement against real footage FIRST — pick
// clips with two similar-looking family members, print faceDist for the pairs, and only then move
// this number. Do not "tighten it to be safe": that fragments one person into many cards.
const FACE_CLUSTER_DIST = 0.5;        // merge two unknown faces into ONE review card
const FACE_FRAME_DEDUPE_DIST = 0.45;  // the same face recurring across frames of ONE clip

// face-api.min.js is 1.3 MB and bundles TensorFlow.js. It used to sit in index.html as a
// blocking <script> ahead of renderer.js, so EVERY launch paid to read, parse and execute
// it — including the many sessions that never open face recognition. Inject it on first
// use instead. The promise is cached, so N concurrent callers share ONE <script> insert;
// on failure the cache is cleared so a later attempt can retry.
let _faceLibPromise = null;
function loadFaceApiLib() {
  if (window.faceapi && window.faceapi.nets) return Promise.resolve(window.faceapi);
  if (_faceLibPromise) return _faceLibPromise;
  _faceLibPromise = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'face-api.min.js';
    s.onload = () => resolve(window.faceapi || null);
    s.onerror = () => { _faceLibPromise = null; resolve(null); };   // not vendored in / unreadable
    document.head.appendChild(s);
  });
  return _faceLibPromise;
}

async function ensureFaceModels() {
  if (_faceReady) return _faceReady;
  _faceReady = (async () => {
    // Pulls the library in on demand — this is the first point any face path reaches.
    const fa = await loadFaceApiLib();
    // The library + the model weights are BUNDLED with the app (no manual setup) —
    // a failure here is the engine not starting, not missing files.
    if (!fa || !fa.nets) { _faceReady = null; return { ok: false, error: 'the face-recognition engine couldn’t start (the local library didn’t load).', kind: 'lib' }; }
    try {
      const url = 'face-models';   // bundled weights, served next to index.html
      await fa.nets.ssdMobilenetv1.loadFromUri(url);
      await fa.nets.faceLandmark68Net.loadFromUri(url);
      await fa.nets.faceRecognitionNet.loadFromUri(url);
      return { ok: true, fa };
    } catch (e) { _faceReady = null; logIssue('Face recognition', `models failed to load: ${(e && e.message) || 'unknown'}`); return { ok: false, error: `the models couldn’t load (${(e && e.message) ? String(e.message).slice(0, 120) : 'unknown'}).`, kind: 'load' }; }
  })();
  return _faceReady;
}
// Cap the longest edge we ever hand to face-api (WebGL). Video frames arrive already
// downscaled (~1100px), but a PHOTO frame is the full-resolution file — a 40–50MP phone
// photo fed straight into the SSD-MobileNet WebGL graph exhausts GPU memory and CRASHES
// the renderer/GPU process. Detecting at 1600px is plenty for face quality (video frames
// prove 1100px works) and keeps memory bounded.
const FACE_MAX_EDGE = 1600;
// Build the element we run detection AND cropping on. If the decoded frame is bigger than
// FACE_MAX_EDGE, draw it down onto a canvas once; both detection boxes and crops then live
// in the SAME (scaled) pixel space, so no coordinate remapping is needed.
function faceSource(img) {
  const w = img.naturalWidth || img.width || 0;
  const h = img.naturalHeight || img.height || 0;
  const long = Math.max(w, h);
  if (!long || long <= FACE_MAX_EDGE) return { el: img, w, h };
  const scale = FACE_MAX_EDGE / long;
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  c.getContext('2d').drawImage(img, 0, 0, cw, ch);
  return { el: c, w: cw, h: ch };
}
// Crop a face box out of a detection source ({el,w,h} from faceSource). Draws directly
// (no re-decode) so it's synchronous and sharp. Output is 144×144 with 25% padding.
function cropFace(src, box) {
  try {
    const pad = Math.round(Math.max(box.width, box.height) * 0.25);
    const sx = Math.max(0, box.x - pad);
    const sy = Math.max(0, box.y - pad);
    const sw = Math.min(src.w - sx, box.width + pad * 2);
    const sh = Math.min(src.h - sy, box.height + pad * 2);
    const S = 144; const c = document.createElement('canvas'); c.width = S; c.height = S;
    c.getContext('2d').drawImage(src.el, sx, sy, sw, sh, 0, 0, S, S);
    return c.toDataURL('image/jpeg', 0.9);
  } catch { return ''; }
}
async function detectFacesForClip(clip, onFrame) {
  const ready = await ensureFaceModels();
  if (!ready.ok) return { ready: false, error: ready.error, faces: [], scene: null };
  const fa = ready.fa;
  // faces:frames samples the WHOLE clip (1 frame every faceInterval seconds). We run
  // detection on each frame and merge faces that recur across frames (so one person
  // seen in many frames becomes ONE entry, keeping the biggest/clearest crop).
  const r = await window.api.facesFrames({ sourcePath: clip.sourcePath });
  const frames = (r && r.ok && Array.isArray(r.frames)) ? r.frames : [];
  if (!frames.length) return { ready: true, faces: [], scene: null };
  const collected = [];   // {descriptor, thumb, area}
  let detectErrors = 0;   // frames where detectAllFaces THREW (GPU/WebGL hiccup) — not the same as "no faces"
  // THE GROUP SHOT. detectAllFaces already finds everyone in a frame — but all we ever kept was a
  // 144px crop per person, so a frame with three people became three disembodied heads and the shot
  // they came from was thrown away. Keep the best one: the frame showing the MOST faces at once
  // (ties broken by how big they are, i.e. how nameable). One frame per clip — a whole clip's worth
  // of frames is far too much to hold or persist.
  let scene = null;
  for (let fi = 0; fi < frames.length; fi += 1) {
    if (faceScanAborted) break;
    if (onFrame) onFrame(fi + 1, frames.length);
    const img = new Image(); img.src = frames[fi];
    // eslint-disable-next-line no-await-in-loop
    try { await img.decode(); } catch { continue; }
    // Detect AND crop against the same (possibly down-scaled) source, so the
    // detection boxes line up with cropFace's coordinate space. Detecting/cropping
    // on the raw img left cropFace with no .el/.w/.h → every crop threw and came
    // back '', which showed the 🙂 placeholder for every face.
    const src = faceSource(img);
    let dets = [];
    // eslint-disable-next-line no-await-in-loop
    try { dets = await fa.detectAllFaces(src.el, new fa.SsdMobilenetv1Options({ minConfidence: 0.4 })).withFaceLandmarks().withFaceDescriptors(); } catch { dets = []; detectErrors += 1; }
    const inFrame = [];   // everyone visible in THIS frame, together
    for (const d of dets) {
      const box = d.detection.box; const area = box.width * box.height;
      // A face has to be big and confident enough that its descriptor is worth learning from — too
      // small or too unsure and it just pollutes a person's training set. But the OLD floors (64px /
      // 5.5% / score 0.55) were tuned for solo clips and quietly dropped the back-row and side faces
      // in a group shot, so a table of nine showed as three. Relaxed so more real faces are offered to
      // NAME (the user's confirmation is the real quality gate); still filters true noise. TUNABLE.
      const minSide = Math.max(44, src.w * 0.04);
      if (box.width < minSide || box.height < minSide) continue;
      if ((d.detection.score || 0) < 0.42) continue;
      const desc = Array.from(d.descriptor);
      const thumb = cropFace(src, box);
      inFrame.push({ descriptor: desc, thumb, area, box: { x: box.x, y: box.y, width: box.width, height: box.height } });
      const existing = collected.find((c) => faceDist(c.descriptor, desc) < FACE_FRAME_DEDUPE_DIST);
      if (existing) { if (area > existing.area) { existing.thumb = thumb; existing.area = area; existing.descriptor = desc; } }
      else collected.push({ descriptor: desc, thumb, area });
    }
    // Boxes are in `src` space, so the image we keep must be too — that is the whole reason faceSource
    // exists. When nothing was scaled, src.el IS the <img> and the original frame already matches; only
    // an over-large PHOTO gets re-encoded off the scaled canvas.
    if (inFrame.length >= 2) {
      const score = inFrame.length * 1e9 + inFrame.reduce((s, f) => s + f.area, 0);
      if (!scene || score > scene.score) {
        let sceneImg = frames[fi];
        if (src.el !== img) { try { sceneImg = src.el.toDataURL('image/jpeg', 0.82); } catch { sceneImg = ''; } }
        if (sceneImg) {
          scene = { score, img: sceneImg, w: src.w, h: src.h, faces: inFrame.map((f) => ({ descriptor: f.descriptor, box: f.box })) };
        }
      }
    }
  }
  return {
    ready: true,
    faces: collected.map((c) => ({ descriptor: c.descriptor, thumb: c.thumb })),
    scene: scene ? { img: scene.img, w: scene.w, h: scene.h, faces: scene.faces } : null,
    // Detection actually failed on a frame AND we ended up with nothing — the "no faces" result is
    // untrustworthy (likely a transient GPU/WebGL error), so callers must not mark the clip scanned.
    detectError: detectErrors > 0 && !collected.length,
  };
}

// --- THE GROUP SHOTS ------------------------------------------------------------------------
//
// Owner: "if there are more than one unconfirmed it should have a thumbnail with that section of the
// video and I should be able to click each face and name them."
//
// Held module-level rather than threaded through four call sites (scanFacesForClips, collectClipFaces
// ×2, and the reopen-a-saved-review path). Cumulative and persisted exactly like the pending clusters
// are: a scan MERGES into what is already waiting instead of replacing it.
let faceScenes = [];
let _scenesLoaded = false;
// A load that FAILED is not the same as "there are no group shots". This mirrors main's
// `storeReadFailed` latch (see AGENTS.md 2026-07-09): run on empty defaults so the UI still works,
// but REFUSE to write, because saving now would replace every real group shot with this session's
// empty list — and the old code latched `_scenesLoaded = true` on the failure path, so it never
// even retried the read.
let _scenesLoadFailed = false;
async function ensureFaceScenes() {
  if (_scenesLoaded) return faceScenes;
  try {
    faceScenes = (await window.api.getFaceScenes()) || [];
    _scenesLoaded = true; _scenesLoadFailed = false;
  } catch {
    // Deliberately do NOT set _scenesLoaded: leaving it false means a later call retries the read
    // instead of running the rest of the session on a phantom empty store.
    faceScenes = []; _scenesLoadFailed = true;
  }
  return faceScenes;
}
// One scene per clip — a second scan of the same clip replaces its old group shot rather than
// stacking another copy of the same faces next to it.
async function noteFaceScene(clip, scene) {
  if (!scene || !Array.isArray(scene.faces) || scene.faces.length < 2) return;
  await ensureFaceScenes();
  const key = clipKey(clip);
  const rec = { clipKey: key, name: clip.name || '', img: scene.img, w: scene.w, h: scene.h, faces: scene.faces };
  const at = faceScenes.findIndex((s) => s && s.clipKey === key);
  if (at >= 0) faceScenes[at] = rec; else faceScenes.push(rec);
}
function saveFaceScenesNow() {
  // Never write a list we never successfully read. faces:saveScenes REPLACES the whole store, so
  // saving an empty/partial session over a healthy one is a silent wipe of every saved group shot.
  if (_scenesLoadFailed || !_scenesLoaded) return Promise.resolve();
  try { return window.api.saveFaceScenes(faceScenes); } catch { return Promise.resolve(); }
}

// Detect faces in one clip and accumulate them into `clusters` (the shape
// showFaceReviewGrid expects). NOTHING is auto-tagged or auto-confirmed: a recognized
// face becomes a SUGGESTION (and is saved to that person's profile as UNCONFIRMED) so
// you confirm it yourself in Review faces / on the person's profile. Returns 0 (no
// faces are applied to clips until you confirm).
async function collectClipFaces(clip, clusters, keys) {
  const r = clip._ref || clip;
  // Which clips a confirmed face should tag. Normally just this clip; in Quick mode we
  // scan one clip per subject and pass the whole group's keys so confirming tags them all.
  // clipKey() — the stable name__size fingerprint, NOT the absolute path. Scanned clips have no
  // `.key` field (main-mod/02-media.js never emits one), so this used to always fall through to
  // sourcePath: `E:\DCIM\GX010023.MP4`. Replug the card and it comes back as `F:` — the face
  // review still showed the faces, but confirming them tagged ZERO clips, silently. Every other
  // store in the app (drafts, observations) is keyed by clipKey for exactly this reason.
  const attach = (Array.isArray(keys) && keys.length) ? keys : [clipKey(clip)];
  let fr = null;
  pushActivity(`Scanning ${clip.name} for faces…`, 'face');
  try { fr = await detectFacesForClip({ sourcePath: clip.sourcePath }, (fi, ft) => { if (fi === 1 || fi === ft) pushActivity(`Sampling frames (${fi}/${ft})`, 'frame'); }); } catch { return 0; }
  try { await noteFaceScene(clip, fr && fr.scene); } catch { /* the group shot is a bonus, never a blocker */ }
  const nFaces = (fr && fr.faces || []).length;
  pushActivity(nFaces ? `Detected ${nFaces} face${nFaces !== 1 ? 's' : ''} in ${clip.name}` : `No faces in ${clip.name}`, 'face');
  // One IPC for the whole clip's faces instead of one per face (audit #75). The backend builds the
  // enrolled set once for the batch; the verdict per descriptor is unchanged (see
  // people-match-batch.test.mjs). Falls back to the single-shot call so an older main process — or a
  // rejected batch — still names faces rather than silently matching nothing.
  const _faces = (fr && fr.faces) || [];
  let _matches = [];
  try {
    const br = await window.api.matchPeopleBatch({ descriptors: _faces.map((f) => f.descriptor), threshold: FACE_SUGGEST_DIST });
    _matches = (br && br.results) || [];
  } catch { _matches = []; }
  for (let _i = 0; _i < _faces.length; _i += 1) {
    const f = _faces[_i];
    let m = _matches[_i] || null;
    if (!m) { try { m = await window.api.matchPerson({ descriptor: f.descriptor, threshold: FACE_SUGGEST_DIST }); } catch { /* offline ok */ } }
    const dist = m && typeof m.dist === 'number' ? m.dist : Infinity;
    const matched = !!(m && m.match);   // backend already applied the strict gate
    // Cluster the face (recognized or not) for the Review grid — never auto-apply.
    let c = clusters.find((u) => faceDist(u.descriptor, f.descriptor) < FACE_CLUSTER_DIST);
    if (!c) {
      c = { thumb: f.thumb, descriptor: f.descriptor, descriptors: [], clipKeys: new Set(), suggest: null };
      clusters.push(c);
      pushActivity(matched ? `Looks like ${m.match.name} — needs your confirmation` : 'New face — will ask you to name it', 'face', f.thumb);
    }
    c.descriptors.push(f.descriptor); for (const k of attach) c.clipKeys.add(k);
    if (matched) {
      if (!c.suggest || dist < c.suggest.dist) c.suggest = { id: m.match.id, name: m.match.name, dist };
      notePerson(m.match.name, f.thumb);
      // Surface it on the person's profile as UNCONFIRMED so it shows up there for review.
      try { await window.api.savePerson({ name: m.match.name, descriptors: [f.descriptor], thumb: f.thumb, confirmed: false }); } catch { /* non-fatal */ }
    }
  }
  r._facesScanned = true;
  persistScannedFlag(r);
  return 0;
}

// Persist "this clip's faces have been scanned" for a clip that did NOT come from the rename screen.
//
// flushDraftSave() -> buildDraftMap() walks ONLY state.scannedFiles, and bails when it is empty. A
// scan started from the Organize/Finalize screen works on finScan.files, already RENAMED — so
// clipKey (`name__size`) no longer matches the source-scan key, the lookup misses, and the flag is
// written to nothing. Next session the whole card re-scans; at 4594 clips that is hours of GPU time.
//
// finalMeta is the right carrier: keyed by FILE NAME (which is what survives the rename), it already
// spans the long copy -> Tdarr -> organize gap, and finalMeta:save MERGES, so adding a flag cannot
// clobber the description/people the analyze pass just wrote. currentSelectedClips() has always READ
// `f.meta.facesScanned` — nothing ever wrote it, so that read was dead until now.
function persistScannedFlag(r) {
  if (!r || !r.meta || !r.name) return;   // rename-screen clips are covered by the draft save
  if (r.meta.facesScanned) return;        // already recorded — don't re-write the whole record
  r.meta.facesScanned = true;
  try { window.api.saveFinalMeta({ [r.name]: { ...r.meta } }); } catch { /* non-fatal; the draft path may still catch it */ }
}

// SILENT auto face-tag (Auto mode): detect faces and, for any that MATCH someone you've
// already named, tag that person onto the clip as an UNCONFIRMED guess (also tracked in
// clip.peopleAuto) — no review modal, no naming of strangers. Unconfirmed people still
// feed the AI descriptions + metadata; a later person rename/merge offers to re-tag the
// affected clips. Never blocks or deletes. Returns how many clips got a tag.
async function scanFacesAuto(clipList) {
  // Its OWN flag, deliberately not `_facesScanned`. This pass auto-tags but never clusters and never
  // persists anything, so marking clips with the shared flag made the REAL review scan skip them:
  // "Scan faces" then found nothing to scan and no saved review, and reported "No saved face review
  // found" while quietly forcing a full re-detect. Auto-tagging and reviewing are different jobs and
  // now track separately.
  const toScan = (clipList || []).filter((c) => c && c.sourcePath && !c._facesAutoScanned);
  if (!toScan.length) return { ok: true, tagged: 0 };
  const probe = await ensureFaceModels();
  if (!probe.ok) return { ok: false, tagged: 0 };   // face recognition not set up — skip silently
  faceScanAborted = false;
  let tagged = 0; let done = 0;
  showToast(`⚡ Auto mode — scanning ${toScan.length} clip${toScan.length !== 1 ? 's' : ''} for known faces…`, 3500);
  for (const clip of toScan) {
    if (faceScanAborted || !autoMode()) break;
    done += 1;
    setTask('faces', 'Scanning faces', done, toScan.length, 'scanning', clip.name);
    let fr = null;
    try { fr = await detectFacesForClip({ sourcePath: clip.sourcePath }, () => {}); } catch { fr = null; }
    const names = new Set();
    const _af = (fr && fr.faces) || [];
    let _am = [];
    try {
      const br = await window.api.matchPeopleBatch({ descriptors: _af.map((f) => f.descriptor), threshold: FACE_SUGGEST_DIST });
      _am = (br && br.results) || [];
    } catch { _am = []; }
    for (let _j = 0; _j < _af.length; _j += 1) {
      const f = _af[_j];
      let m = _am[_j] || null;
      if (!m) { try { m = await window.api.matchPerson({ descriptor: f.descriptor, threshold: FACE_SUGGEST_DIST }); } catch { /* offline ok */ } }
      // Auto mode tags SILENTLY, so only act on CONFIDENT matches (close + unambiguous +
      // vote-backed). A mere suggestion is left for the Review grid, never auto-applied.
      if (m && m.match && m.confident && m.match.name) {
        names.add(m.match.name);
        // Save this face onto that person as UNCONFIRMED (a guess), so it shows on their
        // profile for review and improves future matching — never auto-confirmed.
        try { await window.api.savePerson({ name: m.match.name, descriptors: [f.descriptor], thumb: f.thumb, confirmed: false }); } catch { /* non-fatal */ }
      }
    }
    const r = clip._ref || clip;
    if (names.size) {
      clip.people = [...new Set([...(clip.people || []), ...names])];
      clip.peopleAuto = [...new Set([...(clip.peopleAuto || []), ...names])];
      if (r !== clip) { r.people = clip.people; r.peopleAuto = clip.peopleAuto; }
      tagged += 1;
    }
    clip._facesAutoScanned = true; r._facesAutoScanned = true;
  }
  clearTask('faces');
  try { scheduleDraftSave(); } catch { /* ignore */ }
  if (tagged) showToast(`Auto-tagged people on ${tagged} clip${tagged !== 1 ? 's' : ''} — unconfirmed guesses you can fix on a person's profile ✓`, 4500);
  return { ok: true, tagged };
}

// Auto-mode background enrichment after a copy: silently face-tag (unconfirmed) FIRST so
// the vision pass can weave those people into the descriptions — then analyze. No popups.
async function autoBackgroundEnrich(clips) {
  try { if (autoMode() && uiPrefs.autoFaceScan !== false) await scanFacesAuto(clips); } catch { /* non-fatal */ }
  try { if (aiReady() && uiPrefs.autoAnalyzeAfterCopy !== false) await autoAnalyzeAfterCopyRun(clips); } catch { /* non-fatal */ }
}

// Reusable "scanning" animation — a framing-bracket icon with a sweeping accent
// line. Used in the face grid header and the live task panel to feel premium while
// work runs. currentColor for the brackets; the line uses the accent.
const SCAN_ANIM = `<svg class="scan-anim" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M4 8.5V5.5A1.5 1.5 0 0 1 5.5 4H8.5"/><path d="M20 8.5V5.5A1.5 1.5 0 0 0 18.5 4H15.5"/>
  <path d="M4 15.5V18.5A1.5 1.5 0 0 0 5.5 20H8.5"/><path d="M20 15.5V18.5A1.5 1.5 0 0 1 18.5 20H15.5"/>
  <line x1="6.5" x2="17.5" y1="12" y2="12" stroke="var(--accent)" stroke-width="1.8" opacity="0.9">
    <animate attributeName="y1" values="7;17;7" dur="1.9s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.2 1;0.4 0 0.2 1" keyTimes="0;0.5;1"/>
    <animate attributeName="y2" values="7;17;7" dur="1.9s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.2 1;0.4 0 0.2 1" keyTimes="0;0.5;1"/>
  </line>
</svg>`;

// Purpose-built animated file-explorer icons (white outline, inherit currentColor).
// FOLDER: a document rises out of the folder and tucks back in (a live "filing"
// motion). DATE: a calendar with a pulsing "today" cell. BOX: an archive box whose
// lid gently lifts. Used for the destination-map tree rows so the file explorer feels
// alive while you organise. SMIL animation = no JS, GPU-cheap even with many rows.
const IC_FOLDER = `<svg class="anim-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
  <g>
    <rect x="9" y="8" width="6" height="7.5" rx="1"/><line x1="10.6" y1="10.4" x2="13.4" y2="10.4"/><line x1="10.6" y1="12.4" x2="13.4" y2="12.4"/>
    <animateTransform attributeName="transform" type="translate" values="0 4.5;0 -3.5;0 4.5" dur="2.7s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.2 1;0.45 0 0.2 1" keyTimes="0;0.5;1"/>
    <animate attributeName="opacity" values="0;1;1;0" dur="2.7s" repeatCount="indefinite" keyTimes="0;0.22;0.78;1"/>
  </g>
  <path d="M3 7.6a1 1 0 0 1 1-1h4.5a1 1 0 0 1 .8.4l1.1 1.5a1 1 0 0 0 .8.4H20a1 1 0 0 1 1 1v7.7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/>
</svg>`;
const IC_DATE = `<svg class="anim-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
  <rect x="3.5" y="5" width="17" height="15" rx="2"/><line x1="3.5" y1="9.2" x2="20.5" y2="9.2"/><line x1="8" y1="3.4" x2="8" y2="6.4"/><line x1="16" y1="3.4" x2="16" y2="6.4"/>
  <rect x="10.4" y="12" width="3.2" height="3.2" rx="0.6" fill="currentColor" stroke="none">
    <animate attributeName="opacity" values="0.2;1;0.2" dur="1.8s" repeatCount="indefinite" calcMode="ease-in-out"/>
  </rect>
</svg>`;
const IC_BOX = `<svg class="anim-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
  <path d="M4.5 9.5h15v8a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1Z"/><line x1="10" y1="13" x2="14" y2="13"/>
  <path d="M3 6.5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v3H3Z">
    <animateTransform attributeName="transform" type="translate" values="0 0;0 -1.8;0 0" dur="2.8s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.2 1;0.4 0 0.2 1" keyTimes="0;0.5;1"/>
  </path>
</svg>`;
// Native COLOURFUL emoji for the file-explorer tree (user wants the yellow folders).
// Wrapped in .keep-emoji so the white-outline replacer leaves them as real emoji.
function dmapFolderIcon(dated, depth) { return dated ? '📅' : (depth === 0 ? '🗂️' : '📁'); }

// Scan selected clips: detect faces, AUTO-tag confident matches, and cluster the
// rest into SUGGESTED (tentative match to a known person) + NEW (unknown) groups
// for the digiKam-style confirm grid. Confirming there grows each person so
// recognition gets better the more you review (learns as it grows).
// ⚠ MIRRORS main-mod/08-finalize-feedback.js (FACE_CONFIRM_T / FACE_SUGGEST_T). Main and renderer
// are separate concatenated bundles with no shared module, so these values are duplicated by
// necessity — `face-thresholds-parity.test.mjs` fails if the two sides drift apart. Change both.
const FACE_CONFIRM_DIST = 0.46;   // <= this: auto-tag, very confident
const FACE_SUGGEST_DIST = 0.54;   // ceiling passed to people:match; the backend applies
                                  // the strict digiKam-style vote/margin gate (see people:match)
// --- persist the review across restarts (crops + descriptors + state) --------
// Only the UNRESOLVED clusters are stored (confirmed faces already live in
// people.json; skipped ones are dismissed). clipKeys is a Set → stored as array.
// #45: a done/skipped cluster whose face appears in a saved group SHOT has to persist too. It used to
// be filtered out here — so on reopen clusterOf() couldn't resolve it, a partly-named shot fell below
// liveScenes' "≥2 resolvable" bar and VANISHED, stranding the still-unnamed people in it (Jake: "why
// isn't it remembering face scanning across sessions!!!"). We keep ONLY scene-referenced resolved
// clusters — a solo named face already lives in people.json — so faces-pending.json stays bounded, and
// because every kept resolved cluster is on a scene, render()'s onScene filter keeps them out of the
// flat grid (no "just confirmed" clutter on reopen).
function _clusterInAnyScene(c) {
  if (!c || !c.descriptor) return false;
  for (const s of (faceScenes || [])) {
    for (const f of (s.faces || [])) {
      if (f && f.descriptor && faceDist(c.descriptor, f.descriptor) < FACE_CLUSTER_DIST) return true;
    }
  }
  return false;
}
function _serializePending(clusters) {
  return (clusters || [])
    .filter((c) => c && c.descriptor && (!(c.done || c.skipped) || _clusterInAnyScene(c)))
    .map((c) => ({
      thumb: c.thumb || '',
      descriptor: c.descriptor,
      descriptors: c.descriptors || [],
      clipKeys: [...(c.clipKeys || [])],
      suggest: c.suggest || null,
      rejected: !!c.rejected,
      done: !!c.done,
      skipped: !!c.skipped,
      assignedName: c.assignedName || '',
    }));
}
// How long to coalesce faces-pending writes.
//
// 700 ms is right for interactive edits in the review grid. DURING A SCAN it is wrong: a save fires
// after every clip, and each one blocks the MAIN process — writeJsonAtomic uses writeSync + fsyncSync
// (main-mod/01-core.js), so previews and copy progress stall with it. Measured 2026-07-18: a realistic
// post-#66 store of 250 clusters serialises to 3.1 MB and ~13 ms BEFORE the synchronous write, and a
// 250-clip scan fires that after every clip.
//
// Safe to trade durability for responsiveness HERE specifically because faces-pending is DERIVED
// data: the worst case after a crash is re-scanning some clips, not lost footage and not lost names.
// Drafts keep their tight debounce precisely because they are NOT derived. The scan's `finally`
// always flushes, so ending a scan never leaves work unsaved.
const PENDING_SAVE_MS = () => (faceScanActive ? 8000 : 700);
let _pendingSaveTimer = null;
// See loadPendingFaces: true once a read has failed, which makes the in-memory list a phantom.
// faces:savePending REPLACES the whole store, so writing while this is set wipes the faces waiting
// to be reviewed from every other card.
let _pendingLoadFailed = false;
function schedulePendingSave(clusters) {
  clearTimeout(_pendingSaveTimer);
  if (_pendingLoadFailed) return;
  _pendingSaveTimer = setTimeout(() => { try { window.api.savePendingFaces(_serializePending(clusters)); } catch { /* ignore */ } }, PENDING_SAVE_MS());
}
function savePendingNow(clusters) {
  clearTimeout(_pendingSaveTimer);
  if (_pendingLoadFailed) return Promise.resolve();
  try { return window.api.savePendingFaces(_serializePending(clusters)); } catch { return Promise.resolve(); }
}
async function loadPendingFaces() {
  let list = [];
  // Same fail-open as the scenes store: `catch { list = [] }` made a rejected IPC indistinguishable
  // from "no unreviewed faces", and the next save then replaced every other card's pending faces
  // with this session's empty list. Record the failure so the savers can refuse.
  try { list = await window.api.getPendingFaces(); _pendingLoadFailed = false; }
  catch { list = []; _pendingLoadFailed = true; }
  return (list || []).filter((c) => c && Array.isArray(c.descriptor)).map((c) => ({
    thumb: c.thumb || '',
    descriptor: c.descriptor,
    descriptors: c.descriptors || [],
    clipKeys: new Set(c.clipKeys || []),
    suggest: c.suggest || null,
    rejected: !!c.rejected,
    // Restore resolved state (was hardcoded false) — the other half of #45: a named face in a saved
    // group shot must come back NAMED, so the scene resolves it instead of stranding it as unnamed.
    done: !!c.done,
    skipped: !!c.skipped,
    assignedName: c.assignedName || '',
  }));
}

// Standalone "just scan faces" on the ticked clips → straight into the face review. Face scanning was
// only reachable bundled inside Analyze (which also runs the vision naming) or two clicks deep in the
// People dashboard; there was no way to run ONLY a face scan. This is that entry point.
function scanFacesSelected() {
  const sel = currentSelectedClips();
  if (!sel.length) { showToast('Tick some clips first (or open a card)'); return; }
  return scanFacesForClips(sel);
}

async function scanFacesForClips(clipList, opts = {}) {
  if (!clipList || !clipList.length) { showToast('Select some clips first'); return; }
  // Skip clips already scanned in a previous (or interrupted) run — face scanning is slow and the
  // result is remembered, so never redo a clip unless explicitly forced.
  //
  // Consult the PERSISTED drafts, not only the in-memory `_facesScanned` flag. That flag was the whole
  // "it re-scans from scratch every session" bug: it isn't present on every clip representation (the
  // Organize screen builds fresh clip objects without it), and a restore can miss it — so a clip we
  // scanned last session got scanned again. The draft record (keyed by name__size) is the durable
  // truth; a clip is "already scanned" if EITHER source says so.
  let scannedKeys = new Set();
  if (!opts.force) {
    try { const drafts = (await window.api.getDrafts()) || {}; for (const k of Object.keys(drafts)) { if (drafts[k] && drafts[k].facesScanned) scannedKeys.add(k); } } catch { /* fall back to the in-memory flag alone */ }
  }
  const isScanned = (c) => !!c._facesScanned || scannedKeys.has(clipKey(c));
  const toScan = opts.force ? clipList : clipList.filter((c) => !isScanned(c));
  const skipped = clipList.length - toScan.length;
  if (!toScan.length) {
    // Everything here was scanned before → don't re-scan. Reopen the SAVED review
    // (crops + all) so you can keep confirming exactly where you left off.
    const pending = await loadPendingFaces();
    if (pending.length) { await showFaceReviewGrid(pending, state.scannedFiles, 0); return; }
    // No saved review yet (e.g. first run after this update) — offer a ONE-TIME
    // re-detect to build it. Once built it's remembered, so this won't ask again.
    const again = await confirmDialog(
      'No saved face review found.',
      'Detect faces now? This runs once, then it’s remembered — you won’t be asked again.',
      'Detect faces', 'Not now');
    if (again) return scanFacesForClips(clipList, { ...opts, force: true });
    return;
  }
  const probe = await ensureFaceModels();
  if (!probe.ok) { showFaceSetup(probe.error); return; }
  faceScanAborted = false;
  faceScanActive = true;   // coalesce faces-pending writes hard while scanning (audit #67)
  aiFollow = true; aiAborted = false; showFollowBtn(false);
  clearActivity();
  // Start from the saved review so a new scan MERGES into what's already waiting
  // (by descriptor) instead of losing it — the review is cumulative and remembered.
  let clusters = [];   // {thumb, descriptor, descriptors:[], clipKeys:Set, suggest}
  let done = 0;
  // detectFacesForClip spawns ffmpeg to pull frames, and matchPerson/savePerson hit the
  // face DB — any of them can REJECT. Without the finally, a throw left the footer "Face
  // scan" task pinned in the conveyor forever and the clip card stuck under its spinning
  // `analyzing` overlay, with no error surfaced. (scanFacesAuto and collectClipFaces already
  // guard these exact calls — this path just never got the same treatment.) Whatever we
  // clustered before the failure is kept: the review grid below is cumulative by design.
  try {
    clusters = await loadPendingFaces();
    await ensureFaceScenes();   // cumulative, exactly like the clusters — a scan merges, never replaces
    for (const clip of toScan) {
      if (faceScanAborted) break;
      const ci = state.scannedFiles.indexOf(clip);   // the live scan overlay on the card
      setTask('faces', 'Face scan', done + 1, toScan.length, 'scanning', clip.name);
      markClipAnalyzing(ci, 'face scan');
      pushActivity(`Scanning ${clip.name} for faces…`, 'face');
      // eslint-disable-next-line no-await-in-loop
      const res = await detectFacesForClip(clip, (fi, ft) => { setTask('faces', 'Face scan', done + 1, toScan.length, `frame ${fi}/${ft}`, clip.name); if (fi === 1 || fi === ft) pushActivity(`Sampling frames (${fi}/${ft})`, 'frame'); });
      markClipAnalyzing(ci, false);
      // eslint-disable-next-line no-await-in-loop
      await noteFaceScene(clip, res.scene);   // the frame that shows them TOGETHER — see noteFaceScene
      if (res.scene) pushActivity(`${res.scene.faces.length} people in one shot — you can name them on the frame`, 'face');
      // #84: a GPU/WebGL hiccup makes detectAllFaces throw, which used to look identical to "no
      // faces" — so we'd mark the clip scanned and NEVER retry it. When detection actually errored
      // and found nothing, leave the clip UNscanned so a later scan (GPU recovered) tries again.
      if (res.detectError) {
        pushActivity(`Face detection failed on ${clip.name} — will retry later`, 'face');
      } else {
        pushActivity(res.faces.length ? `Detected ${res.faces.length} face${res.faces.length !== 1 ? 's' : ''}` : 'No faces found', 'face');
        // Remember this clip was scanned (even if nothing matched) so we never re-nag,
        // and PERSIST it now so a mid-stream cutoff still remembers what's done.
        clip._facesScanned = true; if (clip._ref) clip._ref._facesScanned = true;
        const byKeyClip = state.scannedFiles.find((c) => clipKey(c) === clipKey(clip)); if (byKeyClip) byKeyClip._facesScanned = true;
        persistScannedFlag(clip._ref || clip);   // Finalize-screen clips: finalMeta, not drafts (see above)
        flushDraftSave();   // persist scanned-flag immediately — a mid-stream cutoff is remembered
      }
      for (const f of res.faces) {
        // eslint-disable-next-line no-await-in-loop
        const m = await window.api.matchPerson({ descriptor: f.descriptor, threshold: FACE_SUGGEST_DIST });
        // #46: this face is in the IGNORE bin — a statue/TV/poster/passer-by the user dismissed.
        // matchPerson already recognises it (match:null, ignored:true) but "Ignore" only ever
        // suppressed MATCHING, not CLUSTERING — so it fell through below and re-formed a "New face —
        // name it?" cluster on EVERY future scan. Drop it here: don't cluster, don't offer, don't re-ask.
        if (m && m.ignored) continue;
        const dist = m && typeof m.dist === 'number' ? m.dist : Infinity;
        const matched = !!(m && m.match);   // backend already applied the strict gate
        // NEVER auto-tag or auto-confirm. Recognized faces become SUGGESTIONS you confirm
        // in the Review grid, and are saved to the person's profile as UNCONFIRMED.
        let c = clusters.find((u) => faceDist(u.descriptor, f.descriptor) < FACE_CLUSTER_DIST);
        if (!c) { c = { thumb: f.thumb, descriptor: f.descriptor, descriptors: [], clipKeys: new Set(), suggest: null }; clusters.push(c); pushActivity(matched ? `Looks like ${m.match.name} — needs your confirmation` : 'New face — will ask you to name it', 'face', f.thumb); }
        c.descriptors.push(f.descriptor); c.clipKeys.add(clipKey(clip));   // stable across replug — see collectClipFaces
        if (matched) {
          if (!c.suggest || dist < c.suggest.dist) c.suggest = { id: m.match.id, name: m.match.name, dist };
          notePerson(m.match.name, f.thumb);
          // eslint-disable-next-line no-await-in-loop
          await window.api.savePerson({ name: m.match.name, descriptors: [f.descriptor], thumb: f.thumb, confirmed: false });
        }
      }
      done += 1;
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    logIssue('Faces', `Face scan stopped: ${msg}`);
    showToast(`Face scan stopped — ${msg}. The ${done} clip${done !== 1 ? 's' : ''} already scanned are remembered.`, 5500);
  } finally {
    clearAllAnalyzing(); clearTask('faces');
    // Leave scan mode and FLUSH: the coarse 8 s debounce above means a pending write can still be
    // in flight, and ending a scan must never leave the review unsaved (audit #67).
    faceScanActive = false;
    try { savePendingNow(clusters); } catch { /* the grid below re-saves on any edit anyway */ }
    // saveFaceScenesNow() used to be called from exactly ONE place — render(), inside the review
    // grid. So a scan whose grid was never opened (closed early, aborted, or a scan that found faces
    // but the user walked away) kept its pending clusters but silently dropped every GROUP SHOT:
    // noteFaceScene only mutates the in-memory faceScenes array. Ending a scan must persist both
    // halves of the review, for the same reason the pending flush above exists (audit #67).
    try { saveFaceScenesNow(); } catch { /* best-effort; the grid re-saves on any edit */ }
  }
  scheduleDraftSave();   // make sure the last clips' scanned-flags persist
  if (faceScanAborted) { showToast(`Face scan stopped — ${done} scanned so far are remembered (resume to do the rest).`, 4500); }
  const toReview = clusters.length;
  if (!faceScanAborted) pcNotify('Face scan complete', `${toReview} face${toReview !== 1 ? 's' : ''} to review & confirm${skipped ? ` · skipped ${skipped} already-scanned` : ''}.`);
  // Pass ALL scanned clips (not just this batch) so confirming a merged-in face
  // from an earlier scan still tags its clips.
  if (clusters.length) await showFaceReviewGrid(clusters, state.scannedFiles, 0);   // await so Analyze can name AFTER you confirm
  else { savePendingNow(clusters); saveFaceScenesNow(); if (!faceScanAborted) showToast(`No new faces found${skipped ? ` (skipped ${skipped} already scanned)` : ''}`); }
}

// digiKam-style face confirm GRID. Three sections: SUGGESTED (tentative match —
// dashed accent border + "Is this <name>?"), NEW (unknown — "Who is this?" with
// tap-chips for existing people), and CONFIRMED (solid green border). Confirming or
// naming applies immediately AND grows that person's descriptors (learns as it grows).
async function showFaceReviewGrid(clusters, clipList, autoCount) {
  let people = [];
  try { people = await window.api.getPeople(); } catch { people = []; }
  await ensureFaceScenes();   // the group shots — reopening a saved review must show them too
  return new Promise((resolveGrid) => {
  // The suggestion chips used to be `people.map(p => p.name).slice(0, 8)` — raw store order, which is
  // insertion order, which is effectively arbitrary. So the same eight names sat there forever no
  // matter who you were actually naming, and the people you use constantly could be off the end of
  // the list entirely. Rank them instead:
  //   1. whoever you've named in THIS session, most recent first — he shoots a family across
  //      hundreds of clips in one sitting, so the last person named is overwhelmingly likely next;
  //   2. then by enrolment strength (`faces.length`), which is how many confirmed faces that person
  //      has accumulated — a real "how often do I use this person" signal, not a guess;
  //   3. then name, so ties are stable and chips don't reshuffle under the cursor between renders.
  const recentNames = [];   // session order, most-recently-named LAST
  function noteNameUsed(n) {
    const s = String(n || '').trim(); if (!s) return;
    const i = recentNames.indexOf(s); if (i >= 0) recentNames.splice(i, 1);
    recentNames.push(s);
  }
  function rankedNames() {
    const strength = new Map(people.map((p) => [p.name, (p.faces && p.faces.length) || 0]));
    const all = people.map((p) => p.name);
    for (const n of recentNames) if (!all.includes(n)) all.push(n);
    return all.slice().sort((a, b) => {
      const ra = recentNames.indexOf(a); const rb = recentNames.indexOf(b);
      if (ra !== rb) return rb - ra;                                   // recent first (-1 sorts last)
      const sa = strength.get(a) || 0; const sb = strength.get(b) || 0;
      if (sa !== sb) return sb - sa;
      return String(a).localeCompare(String(b));
    });
  }
  const names = people.map((p) => p.name);
  // Resolve a cluster's clipKeys back to clips by BOTH the stable fingerprint and the absolute
  // path: clusters written before the key fix are still sitting in faces-pending.json keyed by
  // path, and a pending review is exactly the work we must never drop on the floor.
  const byKey = {};
  for (const c of clipList) { byKey[clipKey(c)] = c; if (c.sourcePath) byKey[c.sourcePath] = c; }
  clusters.forEach((c, i) => { c._i = i; });
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card face-grid-card">
    <div class="ai-hd"><span class="ai-hd-icon fg-hd-anim">${SCAN_ANIM}</span><div class="ai-hd-text"><h3>Review faces</h3><p class="muted small">Confirm or correct who these are — type a name or tap a suggestion. Each one teaches the app for next time.</p></div></div>
    <div class="face-grid-scroll"></div>
    <div class="modal-actions"><button type="button" class="btn primary fg-confirm-all">Confirm all suggestions</button><button type="button" class="btn fg-done">Done</button></div>
  </div>`;
  document.body.appendChild(ov);
  const scroll = ov.querySelector('.face-grid-scroll');
  const close = () => { savePendingNow(clusters); ov.remove(); refreshNames && refreshNames(); refreshAllClipPeople(); resolveGrid(); };
  ov.querySelector('.fg-done').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });

  // Confirming a face is REAL WORK — it's the whole point of the review grid — so it has to be
  // persisted the instant it happens. It wasn't: tagging only mutated clip.people in memory,
  // while close() ran savePendingNow(), which DROPS every confirmed cluster from
  // faces-pending.json. So confirming faces and then crashing (or being killed) lost the tags
  // from the clips AND from the pending review — the work existed nowhere. It survived only by
  // luck, if a later edit or a window blur happened to trigger a flush first.
  function tagClips(cl, name) {
    for (const k of cl.clipKeys) { const c = byKey[k]; if (c) c.people = [...new Set([...(c.people || []), name])]; }
    flushDraftSave();
    // …and the ones that are NOT in memory (audit #26/#27). `byKey` is built from state.scannedFiles,
    // so a cluster restored from faces-pending.json — which legitimately references clips from
    // earlier sessions, already renamed and filed — tagged NONE of them, silently. Send every key:
    // the backend is add-only and idempotent, so in-memory clips (whose persisted record may lag)
    // are harmless to include, and it never creates a record for a key it doesn't know.
    // Fire-and-forget: the in-memory tag above already succeeded, so a failure here must not block
    // naming — it just means the persisted half retries on the next confirm.
    try { window.api.tagPersonOnClips({ name, keys: [...cl.clipKeys] }); } catch { /* non-fatal */ }
  }
  function untagClips(cl, name) {
    for (const k of cl.clipKeys) { const c = byKey[k]; if (c && Array.isArray(c.people)) c.people = c.people.filter((n) => n !== name); }
    flushDraftSave();
    // …and reverse the PERSISTED tag too. tagClips writes through to finalMeta/drafts (#26), so
    // without this the undo only removed the name from clips that happen to be in memory — the
    // filed ones kept it forever.
    try { window.api.untagPersonOnClips({ name, keys: [...cl.clipKeys] }); } catch { /* non-fatal */ }
  }
  async function assign(cl, name) {
    name = String(name || '').trim();
    if (!name) return;
    await window.api.savePerson({ name, descriptors: cl.descriptors, thumb: cl.thumb });
    tagClips(cl, name);
    rememberSubject && rememberSubject(name);
    cl.done = true; cl.assignedName = name;
    if (!names.includes(name)) names.push(name);
    // Naming a face FINISHES it, so the popup has no reason to stay open — and leaving it open was
    // actively costly: the next click anywhere re-rendered with the popup still selected, so you
    // were dragged back to it and had to remember to dismiss it by hand every single time. Every
    // naming path (suggestion chip, typed name, Enter, confirm-all) funnels through assign(), so
    // clearing the selection here closes it once for all of them.
    noteNameUsed(name);   // ranks this person to the front of the chips for the rest of the session
    for (const s of faceScenes) s._sel = null;
    render();
  }
  // A tight crop of a SPECIFIC face out of the group photo, done in pure CSS (a background sprite) —
  // no canvas, no async decode. Used so the naming card shows the face you actually clicked, instead
  // of the cluster's canonical thumb (which is a crop from some OTHER clip and looks like a stranger).
  function faceCropHTML(img, box, iw, ih) {
    if (!img || !box || !box.width) return personThumbHTML('');
    const D = 96;                         // thumb size, px
    const s = D / box.width;              // scale so the face box fills the thumb width
    const bw = Math.round((iw || 0) * s); const bh = Math.round((ih || 0) * s);
    const px = Math.round(-box.x * s); const py = Math.round(-box.y * s);
    const style = `width:${D}px;height:${D}px;background-image:url('${escapeAttr(img)}');`
      + `background-size:${bw}px ${bh}px;background-position:${px}px ${py}px;background-repeat:no-repeat;`;
    return `<span class="person-thumb fgc-facecrop" style="${style}"></span>`;
  }
  function cardHTML(cl, opts = {}) {
    const thumb = (opts.faceImg && opts.faceBox) ? faceCropHTML(opts.faceImg, opts.faceBox, opts.iw, opts.ih) : personThumbHTML(cl.thumb);
    const seen = `${cl.clipKeys.size} clip${cl.clipKeys.size !== 1 ? 's' : ''}`;
    if (cl.done) {
      return `<div class="face-grid-card-item confirmed" data-i="${cl._i}">
        <div class="fgc-photo">${thumb}<span class="fgc-badge">✓</span></div>
        <div class="fgc-name">${escapeHtml(cl.assignedName)}</div>
        <div class="fgc-sub muted small">${seen} · tagged</div>
        <button class="fgc-undo" title="Undo">Undo</button>
      </div>`;
    }
    if (cl.suggest && !cl.rejected) {
      // Same ranking as the "who is this?" chips — this is the CORRECTION list, so when the
      // suggestion is wrong the people you actually name most need to be the ones offered.
      const others = rankedNames().filter((n) => n.toLowerCase() !== cl.suggest.name.toLowerCase()).slice(0, 8);
      const othChips = others.map((n) => `<button class="fgc-chip" data-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('');
      return `<div class="face-grid-card-item suggested" data-i="${cl._i}">
        <div class="fgc-photo">${thumb}</div>
        <div class="fgc-q">Is this <b>${escapeHtml(cl.suggest.name)}</b>?</div>
        <div class="fgc-sub muted small">${seen}</div>
        <div class="fgc-btns"><button class="fgc-yes" title="Yes — confirm">✓ Yes</button><button class="fgc-no" title="No — not them">✗ No</button></div>
        <input type="text" class="ai-input fgc-input" placeholder="or type the right name…" autocomplete="off"/>
        ${othChips ? `<div class="fgc-chips compact">${othChips}</div>` : ''}
      </div>`;
    }
    const chips = rankedNames().slice(0, 8).map((n) => `<button class="fgc-chip" data-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('');
    return `<div class="face-grid-card-item fresh" data-i="${cl._i}">
      <div class="fgc-photo">${thumb}</div>
      <div class="fgc-sub muted small">${seen}</div>
      <input type="text" class="ai-input fgc-input" placeholder="Who is this?" autocomplete="off"/>
      ${chips ? `<div class="fgc-chips compact">${chips}</div>` : ''}
      <div class="fgc-btns"><button class="fgc-save" title="Save">✓</button><button class="fgc-skip" title="Not a person / skip">✗</button></div>
    </div>`;
  }
  function section(title, list) {
    if (!list.length) return '';
    return `<div class="fg-section">${escapeHtml(title)} <span class="fg-count">${list.length}</span></div><div class="face-grid">${list.map(cardHTML).join('')}</div>`;
  }

  // --- THE GROUP SHOT ---------------------------------------------------------------------
  //
  // "if there are more than one unconfirmed it should have a thumbnail with that section of the video
  // and I should be able to click each face and name them."
  //
  // A scene face is linked back to its cluster BY DESCRIPTOR, not by a stored index: clusters are
  // rebuilt from faces-pending.json on every reopen and merged across scans, so any index we wrote
  // down would silently point at the wrong person the next time round.
  const clusterOf = (desc) => clusters.findIndex((c) => c && !c.skipped && faceDist(c.descriptor, desc) < FACE_CLUSTER_DIST);
  const unresolved = (ci) => ci >= 0 && clusters[ci] && !clusters[ci].done && !clusters[ci].skipped;

  function liveScenes() {
    return faceScenes
      .map((s) => ({ ...s, cis: (s.faces || []).map((f) => clusterOf(f.descriptor)) }))
      // Two or more faces we can still act on, at least one of them unnamed. Once they are ALL named
      // the shot has done its job and drops away, leaving the tidy grid he already likes.
      .filter((s) => s.cis.filter((ci) => ci >= 0).length >= 2 && s.cis.some(unresolved))
      // Scenes were left in the order the SCAN happened to finish them — which is async, so it looked
      // random ("all the photos are out of order"). Reviewing a shoot means moving through it in the
      // order it was shot, so sort by capture date, then by name so same-date shots keep a stable,
      // repeatable order (an unstable sort here would reshuffle the list under the cursor mid-review).
      .sort((a, b) => {
        const ca = byKey[a.clipKey]; const cb = byKey[b.clipKey];
        const da = String((ca && (ca.date || ca.capturedAt)) || '');
        const db = String((cb && (cb.date || cb.capturedAt)) || '');
        if (da !== db) return da < db ? -1 : 1;
        return String((ca && ca.name) || a.clipKey).localeCompare(String((cb && cb.name) || b.clipKey));
      });
  }

  function sceneCardHTML(s, si) {
    const boxes = s.faces.map((f, fi) => {
      const ci = s.cis[fi];
      if (ci < 0) return '';                       // that face was skipped as "not a person"
      const cl = clusters[ci];
      const L = (f.box.x / s.w) * 100; const T = (f.box.y / s.h) * 100;
      const W = (f.box.width / s.w) * 100; const H = (f.box.height / s.h) * 100;
      const named = cl.done ? cl.assignedName : '';
      const cls = ['fsc-box', named ? 'is-named' : 'is-open', s._sel === fi ? 'is-sel' : ''].filter(Boolean).join(' ');
      const label = named || (cl.suggest && !cl.rejected ? `${cl.suggest.name}?` : '?');
      return `<button class="${cls}" data-si="${si}" data-fi="${fi}"
        style="left:${L}%;top:${T}%;width:${W}%;height:${H}%"
        title="${escapeAttr(named || 'Click to name')}"><span class="fsc-tag">${escapeHtml(label)}</span></button>`;
    }).join('');

    const left = s.cis.filter(unresolved).length;
    const sel = (s._sel != null && s.cis[s._sel] >= 0) ? clusters[s.cis[s._sel]] : null;
    const selBox = (sel && s.faces[s._sel]) ? s.faces[s._sel].box : null;
    // The naming card is a POPUP centred over the photo (dim backdrop), not a card below it you had to
    // scroll to find. Its thumbnail is the face you actually clicked, cropped from THIS photo.
    const pop = sel
      ? `<div class="fsc-pop-wrap">${cardHTML(sel, { faceImg: s.img, faceBox: selBox, iw: s.w, ih: s.h })}</div>`
      : '';
    // The popup anchors to the whole .face-scene (not inside .fsc-photo, which is overflow:hidden and
    // would clip the card on a wide/short group shot). Backdrop dims the scene; card centres over it.
    return `<div class="face-scene">
      <div class="fsc-photo"${s.w && s.h ? ` style="--fsc-ar:${s.w} / ${s.h}"` : ''}><img src="${escapeAttr(s.img)}" alt=""/>${boxes}</div>
      <div class="fsc-bar muted small">${escapeHtml(s.name || 'this shot')} · ${s.cis.filter((ci) => ci >= 0).length} people · ${left ? `${left} still to name — click a face` : 'all named ✓'}</div>
      ${pop}
    </div>`;
  }

  // `persist: false` means "this render changed only what the user is LOOKING at, not what we store".
  // render() used to call schedulePendingSave() unconditionally, so opening or closing the naming
  // popup — which only toggles `s._sel`, a field `_serializePending` deliberately drops — queued a
  // full re-serialize and disk write of the entire faces store for ZERO net change. With hundreds of
  // clusters that is real work on the main thread per click, and it is part of why the owner said
  // "every click takes forever to register". Audit #67 coalesced these hard during a SCAN
  // (PENDING_SAVE_MS); this is the same problem during the REVIEW, which that fix didn't cover.
  // Anything that genuinely mutates a cluster (assign / reject / undo / skip) still saves.
  function render(opts) {
    const persist = !opts || opts.persist !== false;
    // Every click through this screen calls render(), which replaces `scroll.innerHTML` wholesale —
    // and replacing the contents of a scrolled container resets scrollTop to 0. The browser then
    // restores *something* as content reflows, which is why naming a face threw you to "a random
    // spot near the top" and why the whole screen felt like it glitched on every click. On a
    // 4500-clip review that is the difference between a usable pass and an unusable one.
    // Capture the position before the rebuild and put it back after — see the restore below.
    const keepTop = scroll.scrollTop;
    const scenes = liveScenes();
    // A face being named ON the group shot must not ALSO sit in the grid below as a loose head — one
    // person, one place to name them.
    const onScene = new Set(scenes.flatMap((s) => s.cis).filter((ci) => ci >= 0));
    const live = clusters.filter((c) => !c.skipped && !onScene.has(c._i));
    const suggested = live.filter((c) => !c.done && c.suggest && !c.rejected);
    const fresh = live.filter((c) => !c.done && (!c.suggest || c.rejected));
    // `autoMatched` was READ here and in the Undo handler but never SET anywhere, so the
    // "Recognized automatically" section below could never render and this split was always
    // (everything, nothing). The Undo half of that dead flag was a real bug — it made Undo skip
    // untagging entirely — so the flag is gone rather than left lying around to be misread again.
    // Nothing auto-confirms in this app by design (see collectClipFaces: a recognised face becomes a
    // SUGGESTION), which is why there was never anything to put in that section.
    const confirmed = live.filter((c) => c.done);

    const sceneHTML = scenes.length
      ? `<div class="fg-section">Who's in this shot? <span class="fg-count">${scenes.length}</span></div>${scenes.map(sceneCardHTML).join('')}`
      : '';
    scroll.innerHTML = sceneHTML
      + section('Suggested — confirm or correct', suggested)
      + section('New faces — who is this?', fresh)
      + section('Just confirmed', confirmed);
    if (!scenes.length && !live.length) scroll.innerHTML = '<p class="muted small" style="text-align:center;padding:24px 0">All faces handled ✓</p>';
    wire();
    wireScenes(scenes);
    // Put the viewport back exactly where it was (see keepTop above). Assigned straight after the
    // innerHTML swap and before any smooth-scroll runs, so the user never sees the intermediate
    // position — restoring it in a rAF instead would show a visible jump-then-snap.
    scroll.scrollTop = keepTop;
    if (persist) { schedulePendingSave(clusters); saveFaceScenesNow(); }   // see the note on render()
    const anySuggested = suggested.length > 0 || scenes.some((s) => s.cis.some((ci) => unresolved(ci) && clusters[ci].suggest && !clusters[ci].rejected));
    const btn = ov.querySelector('.fg-confirm-all');
    if (btn) btn.style.display = anySuggested ? '' : 'none';
  }

  // Clicking a face selects it; the SAME card he already uses (suggestion, chips, "Who is this?"
  // input) opens underneath the photo. wire() binds it automatically — it queries the whole scroll for
  // `.face-grid-card-item`, so there is not one line of duplicate naming logic here.
  function wireScenes(scenes) {
    scroll.querySelectorAll('.fsc-box').forEach((b) => {
      b.addEventListener('click', () => {
        const s = faceScenes.find((x) => x.clipKey === scenes[Number(b.dataset.si)].clipKey);
        if (!s) return;
        // Second-screen integration: mirror THIS shot's full-resolution file to the pop-out preview
        // window (if it's open) so faces are big and clear over there while you name on the main
        // screen. previewSet no-ops when the window is closed, so this is always safe to call.
        const clip = byKey[s.clipKey];
        if (clip && clip.sourcePath) { try { window.api.previewSet(clip.sourcePath, clip.name || '', { kind: 'photo' }); } catch { /* ignore */ } }
        const fi = Number(b.dataset.fi);
        s._sel = (s._sel === fi) ? null : fi;      // click the same face again to close it
        render({ persist: false });   // selection only — nothing to write (see render())
        // Bring the popup into view ONLY if it actually isn't. `block:'nearest'` already no-ops when
        // the element is visible, but `behavior:'smooth'` animated even that no-op — combined with
        // the scrollTop reset this read as being thrown to a random place on every click. Instant,
        // and only when genuinely off-screen, so a click near the top of a long list stays put.
        if (s._sel != null) requestAnimationFrame(() => {
          const pop = scroll.querySelector('.fsc-pop-wrap');
          if (!pop) return;
          const pr = pop.getBoundingClientRect();
          const sr = scroll.getBoundingClientRect();
          if (pr.top < sr.top || pr.bottom > sr.bottom) pop.scrollIntoView({ block: 'nearest' });
        });
      });
    });
    // Clicking the dim backdrop (not the card) closes the popup — a natural "dismiss".
    scroll.querySelectorAll('.fsc-pop-wrap').forEach((w) => {
      w.addEventListener('mousedown', (e) => {
        if (e.target !== w) return;   // ignore clicks that land on the card itself
        for (const s of faceScenes) s._sel = null;
        render({ persist: false });   // dismissing the popup changes nothing we store
      });
    });
  }
  // Smooth micro-tint over the face before the action lands: blue for accept,
  // red for reject. The action fires mid-flash so it feels instant but soft.
  function flash(card, kind, fn) {
    const ph = card.querySelector('.fgc-photo');
    if (ph) ph.classList.add(kind === 'ok' ? 'flash-ok' : 'flash-no');
    setTimeout(fn, 280);
  }
  function wire() {
    scroll.querySelectorAll('.face-grid-card-item').forEach((card) => {
      const cl = clusters[Number(card.dataset.i)];
      if (!cl) return;
      const yes = card.querySelector('.fgc-yes'); if (yes) yes.addEventListener('click', () => flash(card, 'ok', () => assign(cl, cl.suggest.name)));
      const no = card.querySelector('.fgc-no'); if (no) no.addEventListener('click', () => flash(card, 'no', () => { cl.rejected = true; render(); }));
      const undo = card.querySelector('.fgc-undo'); if (undo) undo.addEventListener('click', () => { if (cl.assignedName) untagClips(cl, cl.assignedName); cl.done = false; cl.assignedName = ''; cl.suggest = null; render(); });
      const save = card.querySelector('.fgc-save'); const inp = card.querySelector('.fgc-input');
      if (save && inp) save.addEventListener('click', () => { if (inp.value.trim()) flash(card, 'ok', () => assign(cl, inp.value)); });
      if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.value.trim()) { e.preventDefault(); flash(card, 'ok', () => assign(cl, inp.value)); } });
      const skip = card.querySelector('.fgc-skip'); if (skip) skip.addEventListener('click', () => flash(card, 'no', () => { cl.skipped = true; render(); }));
      card.querySelectorAll('.fgc-chip').forEach((chip) => chip.addEventListener('click', () => flash(card, 'ok', () => assign(cl, chip.dataset.name))));
    });
  }
  ov.querySelector('.fg-confirm-all').addEventListener('click', async () => {
    const pending = clusters.filter((c) => !c.done && !c.skipped && c.suggest && !c.rejected);
    // #83: this bulk-tags EVERY suggested person across all their clips in one click — borderline
    // suggestions included — with no batch undo, so a single wrong suggestion can mislabel many clips
    // at once. Drop an automatic restore point first, exactly like batch-apply (#34) and the AI ops,
    // gated to a confirm big enough to be worth it and honouring the auto-version preference.
    if (pending.length >= 5 && typeof saveVersionPoint === 'function' && uiPrefs.autoVersionOnAi !== false) {
      await saveVersionPoint(`Before confirming ${pending.length} face suggestions`, true);
    }
    for (const c of pending) { /* eslint-disable-next-line no-await-in-loop */ await assign(c, c.suggest.name); }
  });
  render();
  });
}

function showFaceSetup(reason) {
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card modal-form" style="width:min(520px,94vw);text-align:left">
    <div class="illo mob-illo">${ILLO_PEOPLE}</div>
    <div class="ai-hd" style="margin-top:2px"><div class="ai-hd-text"><h3>Face recognition</h3><p class="muted small">It's <b>built in and fully local</b> — no cloud, no setup, no downloads. The models ship with the app.</p></div></div>
    <p class="muted small fs-reason">${reason ? `It didn’t load this time — ${escapeHtml(reason)} This is usually a temporary graphics/driver hiccup; try again.` : 'Once it loads, “Scan faces” finds people in your clips, you name each one once, and future clips auto-tag them into the metadata (PersonInImage + keywords).'}</p>
    <div class="modal-actions"><button type="button" class="btn primary fs-retry">Try again</button><button type="button" class="btn fs-ok">Close</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('.fs-ok').addEventListener('click', close);
  ov.querySelector('.fs-retry').addEventListener('click', async () => {
    const btn = ov.querySelector('.fs-retry');
    const fail = (why) => { const p = ov.querySelector('.fs-reason'); if (p) p.textContent = `Still couldn’t start — ${why || 'unknown error'} Make sure your graphics drivers are up to date.`; };
    // _faceReady is nulled to force a real retry — so if ensureFaceModels THREW, the old code
    // left the memo cleared AND the button dead on "Loading…": face recognition was
    // unrecoverable without a restart. withBusyBtn's finally always gives the button back.
    await withBusyBtn(btn, 'Loading…', async () => {
      _faceReady = null;
      const r = await ensureFaceModels();
      if (r && r.ok) { close(); showToast('Face recognition ready ✓'); }
      else fail((r && r.error) || 'unknown error');
    }, fail);
  });
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
}

const PEOPLE_ILLUS = `<div class="people-illus">
  <svg viewBox="0 0 140 112" xmlns="http://www.w3.org/2000/svg">
    <path d="M24 30L24 20L34 20" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M116 30L116 20L106 20" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M24 82L24 92L34 92" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M116 82L116 92L106 92" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="70" cy="48" r="26" fill="none" stroke="var(--text-3)" stroke-width="1.5" stroke-dasharray="5 3"/>
    <circle cx="61" cy="43" r="3.5" fill="var(--text-2)"/>
    <circle cx="79" cy="43" r="3.5" fill="var(--text-2)"/>
    <path d="M62 57 Q70 64 78 57" fill="none" stroke="var(--text-2)" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M18 106 Q18 80 70 80 Q122 80 122 106" fill="none" stroke="var(--text-3)" stroke-width="1.5"/>
    <line x1="30" x2="110" y1="48" y2="48" stroke="var(--accent)" stroke-width="1.5" opacity="0.85">
      <animate attributeName="y1" values="22;74;22" dur="2.6s" repeatCount="indefinite" calcMode="ease-in-out"/>
      <animate attributeName="y2" values="22;74;22" dur="2.6s" repeatCount="indefinite" calcMode="ease-in-out"/>
      <animate attributeName="opacity" values="0.15;0.9;0.15" dur="2.6s" repeatCount="indefinite" calcMode="ease-in-out"/>
    </line>
  </svg>
</div>`;

// People dashboard (digiKam-style): a sidebar of every known person + a main panel
// showing all of that person's face crops. Rename, merge duplicates, remove a wrong
// face, set a cover, delete, or scan more clips.
const PD_IGNORED = '__ignored__';
async function showPeopleManager() {
  let people = [];
  let ignoredN = 0;
  try { people = await window.api.getPeople(); } catch { people = []; }
  try { ignoredN = await window.api.ignoredCount(); } catch { ignoredN = 0; }
  let selId = people.length ? people[0].id : (ignoredN ? PD_IGNORED : null);
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card pd-card">
    <div class="pd-hd">
      <span class="pd-hd-icon">${typeof SCAN_ANIM !== 'undefined' ? SCAN_ANIM : '🫥'}</span>
      <div class="pd-hd-tx"><h3>People &amp; faces</h3><p class="muted small pd-hd-sub">Confirm who's who, merge duplicates, ignore non-people, or scan more clips.</p></div>
      <button type="button" class="btn primary pd-scan">Scan clips</button>
    </div>
    <div class="pd-body"><div class="pd-side"></div><div class="pd-main"></div></div>
    <div class="modal-actions"><button type="button" class="btn pd-done">Done</button></div>
  </div>`;
  document.body.appendChild(ov);
  const q = (s) => ov.querySelector(s);
  const close = () => ov.remove();
  q('.pd-done').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  q('.pd-scan').addEventListener('click', () => {
    const sel = currentSelectedClips();
    if (!sel.length) { showToast('Tick some clips first (or open a card)'); return; }
    close(); scanFacesForClips(sel);
  });

  async function reloadPeople(keepSel) {
    try { people = await window.api.getPeople(); } catch { people = []; }
    try { ignoredN = await window.api.ignoredCount(); } catch { ignoredN = 0; }
    const stillValid = selId === PD_IGNORED ? ignoredN > 0 : people.some((p) => p.id === selId);
    if (!keepSel || !stillValid) selId = people.length ? people[0].id : (ignoredN ? PD_IGNORED : null);
    renderSide(); renderMain();
  }
  function renderSide() {
    const side = q('.pd-side');
    if (!people.length && !ignoredN) { side.style.display = 'none'; return; }
    side.style.display = '';
    const personRows = people.map((p) => `<button type="button" class="pd-person${p.id === selId ? ' active' : ''}" data-id="${p.id}">
      <span class="pd-person-thumb">${personThumbHTML(p.thumb)}</span>
      <span class="pd-person-tx"><span class="pd-person-name">${escapeHtml(p.name)}</span><span class="pd-person-count muted small">${p.count} face${p.count !== 1 ? 's' : ''}</span></span>
      ${p.unconfirmed ? `<span class="pd-badge" title="${p.unconfirmed} to confirm">${p.unconfirmed}</span>` : ''}
    </button>`).join('');
    const ignoredRow = ignoredN ? `<button type="button" class="pd-person pd-ignored-row${selId === PD_IGNORED ? ' active' : ''}" data-id="${PD_IGNORED}">
      <span class="pd-person-thumb pd-ignored-thumb">⊘</span>
      <span class="pd-person-tx"><span class="pd-person-name">Ignored</span><span class="pd-person-count muted small">${ignoredN} face${ignoredN !== 1 ? 's' : ''}</span></span>
    </button>` : '';
    side.innerHTML = personRows + (ignoredRow ? `<div class="pd-side-sep"></div>${ignoredRow}` : '');
    side.querySelectorAll('.pd-person').forEach((b) => {
      b.addEventListener('click', () => { selId = b.dataset.id; renderSide(); renderMain(); });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = b.dataset.id;
        selId = id; renderSide(); renderMain();
        if (id === PD_IGNORED) { showContextMenu(e.clientX, e.clientY, [{ label: 'Restore all ignored', action: async () => { let list = []; try { list = await window.api.listIgnoredFaces(); } catch { /* */ } for (let k = list.length - 1; k >= 0; k -= 1) { /* eslint-disable-next-line no-await-in-loop */ await window.api.unignoreFace(k); } await reloadPeople(false); } }]); return; }
        const p = people.find((x) => x.id === id);
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Rename', action: () => { const inp = q('.pd-name'); if (inp) { inp.focus(); inp.select(); } } },
          { label: 'Merge…', action: async () => { const d = await window.api.personDetail(id); if (d && d.ok) openMerge(d); } },
          { sep: true },
          { label: 'Delete person', danger: true, action: async () => { if (p) removeClipPersonName(p.name); await window.api.deletePerson(id); await reloadPeople(false); } }
        ]);
      });
    });
  }
  function faceCard(f, kind, n) {
    const delay = `style="animation-delay:${Math.min(n * 26, 380)}ms"`;
    const img = personThumbHTML(f.t);
    let acts = '';
    const reassign = `<button type="button" class="pd-fa" data-act="reassign" title="This is someone else…">⇄</button>`;
    if (kind === 'ignored') acts = `<button type="button" class="pd-fa" data-act="restore" title="Not ignored — restore">↩</button>`;
    else if (kind === 'unconf') acts = `<button type="button" class="pd-fa ok" data-act="confirm" title="Yes, this is them">✓</button>${reassign}<button type="button" class="pd-fa" data-act="ignore" title="Ignore">⊘</button><button type="button" class="pd-fa" data-act="remove" title="Remove">✕</button>`;
    else acts = `${reassign}<button type="button" class="pd-fa" data-act="ignore" title="Ignore">⊘</button><button type="button" class="pd-fa" data-act="remove" title="Remove">✕</button>`;
    const cover = kind === 'conf' && f.cover ? '<span class="pd-cover-tag">cover</span>' : '';
    return `<div class="pd-face${f.cover ? ' cover' : ''}${kind === 'unconf' ? ' unconf' : ''}" data-idx="${f.i}" ${delay}>${img}${cover}<div class="pd-face-acts">${acts}</div></div>`;
  }
  async function renderMain() {
    const main = q('.pd-main');
    if (!people.length && !ignoredN) {
      main.innerHTML = `${PEOPLE_ILLUS}<p class="muted small" style="text-align:center;max-width:360px;margin:0 auto">No people yet. Tick some clips and tap <b>Scan clips</b> — name each face once and it auto-tags from now on.</p>`;
      return;
    }
    if (selId === PD_IGNORED) {
      let list = [];
      try { list = await window.api.listIgnoredFaces(); } catch { list = []; }
      main.innerHTML = `<div class="pd-main-hd"><h3 class="pd-title">Ignored faces</h3></div>
        <div class="pd-faces-hd muted small">Faces you told the app to skip — they won't be suggested as people. ↩ to restore one.</div>
        <div class="pd-faces">${list.map((f, n) => faceCard(f, 'ignored', n)).join('') || '<p class="muted small">Nothing ignored.</p>'}</div>`;
      const fc = main.querySelector('.pd-faces');
      fc && fc.addEventListener('click', async (e) => {
        const card = e.target.closest('.pd-face'); if (!card) return;
        const act = (e.target.closest('[data-act]') || {}).dataset; if (!act) return;
        if (act.act === 'restore') { await window.api.unignoreFace(Number(card.dataset.idx)); await reloadPeople(true); }
      });
      fc && fc.addEventListener('contextmenu', (e) => {
        const card = e.target.closest('.pd-face'); if (!card) return;
        e.preventDefault(); e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, [{ label: 'Restore (not ignored)', action: async () => { await window.api.unignoreFace(Number(card.dataset.idx)); await reloadPeople(true); } }]);
      });
      return;
    }
    let d = null;
    try { d = await window.api.personDetail(selId); } catch { d = null; }
    if (!d || !d.ok) { main.innerHTML = '<p class="muted small">Could not load this person.</p>'; return; }
    const faces = (d.faces || []).map((f) => ({ ...f, cover: f.t && f.t === d.cover }));
    const unconf = faces.filter((f) => !f.confirmed);
    const conf = faces.filter((f) => f.confirmed);
    const sec = (title, list, kind) => list.length ? `<div class="pd-sec-hd">${escapeHtml(title)} <span class="fg-count">${list.length}</span></div><div class="pd-faces">${list.map((f, n) => faceCard(f, kind, n)).join('')}</div>` : '';
    main.innerHTML = `<div class="pd-main-hd">
        <input type="text" class="ai-input pd-name" value="${escapeHtml(d.name)}" spellcheck="false" />
        <div class="pd-acts"><button type="button" class="btn subtle pd-merge">Merge…</button><button type="button" class="btn subtle danger pd-del">Delete</button></div>
      </div>
      <div class="pd-faces-hd muted small">${conf.length} confirmed${unconf.length ? ` · ${unconf.length} to confirm` : ''} · click a confirmed face to make it the cover</div>
      ${sec('Unconfirmed — is this them?', unconf, 'unconf')}
      ${sec('Confirmed', conf, 'conf')}
      ${!faces.length ? '<p class="muted small">No face crops stored yet.</p>' : ''}`;
    const nameInp = main.querySelector('.pd-name');
    const commitName = async () => { const nm = nameInp.value.trim(); if (nm && nm !== d.name) { const old = d.name; await window.api.renamePerson({ id: selId, name: nm }); updateClipPeopleName(old, nm); showToast(`Renamed to "${nm}"`); await reloadPeople(true); offerRetagAffectedClips(old, nm); } };
    nameInp.addEventListener('blur', commitName);
    nameInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameInp.blur(); } });
    main.querySelector('.pd-del').addEventListener('click', async () => { removeClipPersonName(d.name); await window.api.deletePerson(selId); await reloadPeople(false); });
    main.querySelector('.pd-merge').addEventListener('click', () => openMerge(d));
    main.querySelectorAll('.pd-faces').forEach((fc) => {
      fc.addEventListener('click', async (e) => {
        const card = e.target.closest('.pd-face'); if (!card) return;
        const idx = Number(card.dataset.idx);
        const actBtn = e.target.closest('[data-act]');
        const act = actBtn ? actBtn.dataset.act : (e.target.closest('img') && card.classList.contains('cover') === false && !card.classList.contains('unconf') ? 'cover' : null);
        if (act === 'reassign') { showReassignFacePicker(selId, idx, () => reloadPeople(true)); return; }
        if (act === 'confirm') await window.api.confirmFace({ id: selId, index: idx });
        else if (act === 'ignore') await window.api.ignoreFace({ id: selId, index: idx });
        else if (act === 'remove') await window.api.removePersonFace({ id: selId, index: idx });
        else if (act === 'cover') await window.api.setPersonCover({ id: selId, thumb: card.querySelector('img').getAttribute('src') });
        else return;
        await reloadPeople(true);
      });
      fc.addEventListener('contextmenu', (e) => {
        const card = e.target.closest('.pd-face'); if (!card) return;
        e.preventDefault(); e.stopPropagation();
        const idx = Number(card.dataset.idx);
        const isUnconf = card.classList.contains('unconf');
        const isCover = card.classList.contains('cover');
        const reload = () => reloadPeople(true);
        const items = [];
        if (isUnconf) items.push({ label: 'Confirm — this is them', action: async () => { await window.api.confirmFace({ id: selId, index: idx }); reload(); } });
        items.push({ label: 'This is someone else…', action: () => showReassignFacePicker(selId, idx, reload) });
        if (!isCover) items.push({ label: 'Set as cover', action: async () => { const img = card.querySelector('img'); if (img) { await window.api.setPersonCover({ id: selId, thumb: img.getAttribute('src') }); reload(); } } });
        items.push({ label: 'Ignore this face', action: async () => { await window.api.ignoreFace({ id: selId, index: idx }); reload(); } });
        items.push({ sep: true });
        items.push({ label: 'Remove this face', danger: true, action: async () => { await window.api.removePersonFace({ id: selId, index: idx }); reload(); } });
        showContextMenu(e.clientX, e.clientY, items);
      });
    });
  }
  function openMerge(d) {
    const others = people.filter((p) => p.id !== selId);
    if (!others.length) { showToast('No other people to merge'); return; }
    const pop = document.createElement('div'); pop.className = 'modal-overlay';
    pop.innerHTML = `<div class="modal-card modal-form" style="width:min(420px,92vw);text-align:left">
      <div class="ai-hd"><span class="ai-hd-icon">🔗</span><div class="ai-hd-text"><h3>Merge into ${escapeHtml(d.name)}</h3><p class="muted small">Pick a duplicate — its faces move into ${escapeHtml(d.name)} and it's removed.</p></div></div>
      <div class="pd-merge-list">${others.map((p) => `<button type="button" class="pd-merge-opt" data-id="${p.id}"><span class="people-thumb">${personThumbHTML(p.thumb)}</span><span class="people-name">${escapeHtml(p.name)}</span><span class="muted small">${p.count}</span></button>`).join('')}</div>
      <div class="modal-actions"><button type="button" class="btn pd-merge-cancel">Cancel</button></div>
    </div>`;
    document.body.appendChild(pop);
    pop.addEventListener('mousedown', (e) => { if (e.target === pop) pop.remove(); });
    pop.querySelector('.pd-merge-cancel').addEventListener('click', () => pop.remove());
    pop.querySelectorAll('.pd-merge-opt').forEach((b) => b.addEventListener('click', async () => {
      const from = others.find((p) => p.id === b.dataset.id);
      await window.api.mergePerson({ intoId: selId, fromId: b.dataset.id });
      if (from) { updateClipPeopleName(from.name, d.name); offerRetagAffectedClips(from.name, d.name); }
      pop.remove(); showToast('Merged ✓'); await reloadPeople(true);
    }));
  }
  renderSide(); renderMain();
}
// Keep clip people-tags consistent when a person is renamed / merged / deleted in
// the dashboard, so the metadata written at Finalize matches the dashboard.
function updateClipPeopleName(oldName, newName) {
  const fix = (arr) => (Array.isArray(arr) ? [...new Set(arr.map((n) => (n === oldName ? newName : n)))] : arr);
  (state.scannedFiles || []).forEach((c) => { if (Array.isArray(c.people)) c.people = fix(c.people); if (Array.isArray(c.peopleAuto)) c.peopleAuto = fix(c.peopleAuto); });
  if (typeof finScan !== 'undefined' && finScan && Array.isArray(finScan.files)) finScan.files.forEach((f) => { if (f.meta && Array.isArray(f.meta.people)) f.meta.people = fix(f.meta.people); if (f.meta && Array.isArray(f.meta.peopleAuto)) f.meta.peopleAuto = fix(f.meta.peopleAuto); });
  refreshNames && refreshNames();
}
// After a person is renamed/merged/reassigned, offer to re-tag (and re-name) every STORED
// clip tagged with the old name — organized footage + saved drafts, across sessions — so
// descriptions and people metadata stay correct. Always asks; never changes silently.
async function offerRetagAffectedClips(oldName, newName) {
  const from = String(oldName || '').trim(); const to = String(newName || '').trim();
  if (!from || from === to) return;
  let hit = null;
  try { hit = await window.api.findClipsWithPerson(from); } catch { return; }
  if (!hit || !hit.total) return;
  const ok = await confirmDialog('Re-tag affected clips?',
    `${hit.total} saved clip${hit.total !== 1 ? 's are' : ' is'} tagged with "${from}". Re-tag ${hit.total !== 1 ? 'them' : 'it'} as "${to}" and update ${hit.total !== 1 ? 'their names' : 'its name'}/descriptions to match?`,
    `Re-tag ${hit.total}`, 'Leave as is');
  if (!ok) return;
  try { const r = await window.api.retagPerson({ from, to }); showToast(`Re-tagged ${(r && r.changed) || 0} clip${((r && r.changed) !== 1) ? 's' : ''} → "${to}" ✓`, 4000); }
  catch { showToast('Couldn’t re-tag the clips', 3000); }
}
function removeClipPersonName(name) {
  (state.scannedFiles || []).forEach((c) => { if (Array.isArray(c.people)) c.people = c.people.filter((n) => n !== name); });
  if (typeof finScan !== 'undefined' && finScan && Array.isArray(finScan.files)) finScan.files.forEach((f) => { if (f.meta && Array.isArray(f.meta.people)) f.meta.people = f.meta.people.filter((n) => n !== name); });
}
// The clips currently in play to scan (rename grid selection, else all scanned).
function currentSelectedClips() {
  const fin = document.getElementById('finalize');
  if (fin && !fin.classList.contains('hidden') && finScan && finScan.files) {
    // Carry `size` so clipKey(name__size) matches the drafts/scan record — without it a face scan from
    // the Organize screen couldn't tell an already-scanned clip and re-did everything from scratch.
    return (finSelected().length ? finSelected() : finMatched()).map((f) => ({ key: f.name, name: f.name, size: f.size, sourcePath: f.sourcePath, people: (f.meta && f.meta.people) || [], _facesScanned: !!(f.meta && f.meta.facesScanned), _ref: f }));
  }
  const sel = (state.scannedFiles || []).filter((c) => c.selected);
  return (sel.length ? sel : (state.scannedFiles || []));
}

// Model store popout (Engine → Browse models…). Browse/download/remove local
// models — vision (look at clips) + reasoning (text). Self-contained; callbacks
// let the AI settings update its dropdowns. opts: {onUseVision,onUseReasoning,onChanged}
const STORE_REASONING = [
  { name: 'qwen3:8b', desc: 'Qwen3 8B — strong all-round reasoning (recommended).', rec: true },
  { name: 'qwen3:4b', desc: 'Qwen3 4B — lighter & faster.' },
  { name: 'llama3.1:8b', desc: 'Llama 3.1 8B — solid alternative.' }
];
function showModelStore(opts = {}) {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card ai-import" style="width:min(700px,94vw); max-height:88vh; display:flex; flex-direction:column">
    <div class="ai-hd"><span class="ai-hd-icon">🗄️</span><div class="ai-hd-text"><h3>Model store</h3><p class="muted small">Vision models look at your clips; reasoning (text) models do the thinking. Everything downloads locally into Ollama.</p></div></div>
    <div class="ms-status muted small"></div>
    <div class="ms-scroll" style="overflow:auto; flex:1; min-height:140px">
      <div class="ms-list"></div>
      <h4 class="ai-pane-title" style="margin:16px 0 0">Reasoning models <span class="muted small" style="font-weight:400">(text)</span></h4>
      <div class="ms-reason"></div>
    </div>
    <div class="ai-ctl-row" style="gap:8px; margin-top:12px"><input type="text" class="ai-input ms-pull-name" placeholder="Pull any model by name — e.g. qwen3:8b, minicpm-v" style="flex:1" /><button type="button" class="btn ms-pull">Pull</button></div>
    <div class="ms-pull-status muted small hidden" style="margin-top:4px"></div>
    <div class="modal-actions"><button type="button" class="btn ms-close">Close</button></div>
  </div>`;
  document.body.appendChild(ov);
  const q = (s) => ov.querySelector(s);
  let unsub = null;
  let pulling = false;
  const close = () => { if (unsub) unsub(); ov.remove(); };
  q('.ms-close').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });

  async function pull(name, statusEl) {
    if (pulling) { showToast('A download is already running — let it finish'); return false; }
    pulling = true;
    statusEl.classList.remove('hidden'); statusEl.textContent = `Downloading ${name}…`;
    if (unsub) unsub();
    unsub = window.api.onAiPullProgress((p) => {
      if (p.error) { statusEl.textContent = `Error: ${p.error}`; return; }
      statusEl.textContent = `${name}: ${p.status || 'working'}${p.percent != null ? ` · ${p.percent}%` : ''}`;
    });
    // ai:pull talks to Ollama over HTTP, so it can REJECT (daemon stopped mid-download).
    // Without the `finally`, that left `pulling` stuck true — every later download was
    // refused with "A download is already running" until the app restarted — and orphaned
    // the progress listener.
    try {
      const r = await window.api.aiPull(name);
      return !!(r && r.ok);
    } catch (e) {
      statusEl.textContent = `Error: ${(e && e.message) || 'download failed'}`;
      return false;
    } finally {
      if (unsub) { unsub(); unsub = null; }
      pulling = false;
    }
  }
  async function load() {
    q('.ms-status').textContent = 'Loading…';
    let res; try { res = await window.api.aiCatalog(); } catch { res = null; }
    if (!res || !res.ok) { q('.ms-status').innerHTML = 'Ollama isn’t running. Install it from <code>ollama.com</code> — it’s a small free app that runs in the background — then reopen this. (AI is optional; everything else works without it.)'; return; }
    const inst = res.catalog.filter((m) => m.installed).length;
    q('.ms-status').textContent = `${res.catalog.length} vision models · ${inst} installed${res.live ? '' : ' · built-in list'}`;
    renderRows(q('.ms-list'), res.catalog, 'vision');
    const installed = res.installed || [];
    const instBase = new Set(installed.map((n) => n.split(':')[0]));
    const reason = STORE_REASONING.map((m) => ({ ...m, installed: instBase.has(m.name.split(':')[0]) || installed.includes(m.name) }));
    renderRows(q('.ms-reason'), reason, 'reason');
  }
  function renderRows(listEl, items, kind) {
    listEl.innerHTML = '';
    for (const m of items) {
      const row = document.createElement('div'); row.className = 'ai-store-item' + (m.rec ? ' rec' : '');
      const meta = [m.params, m.size].filter(Boolean).join(' · ') || (kind === 'reason' ? 'text model' : 'vision model');
      const badges = `${m.rec ? '<span class="ai-store-badge">Recommended</span>' : ''}${m.live ? '<span class="ai-store-badge live">New</span>' : ''}`;
      row.innerHTML = `<div class="ai-store-info"><div class="ai-store-name">${escapeHtml(m.name)}${badges}</div><div class="ai-store-meta muted small">${escapeHtml(meta)}</div><div class="ai-store-desc muted small">${escapeHtml(m.desc || '')}</div></div><div class="ai-store-action"></div>`;
      const act = row.querySelector('.ai-store-action');
      const useFn = kind === 'reason' ? opts.onUseReasoning : opts.onUseVision;
      if (m.installed) {
        act.innerHTML = `<span class="ai-store-installed">Installed ✓</span><div class="ai-ctl-row" style="gap:6px"><button type="button" class="btn subtle ms-use">Use</button><button type="button" class="btn subtle ms-rm">Remove</button></div>`;
        act.querySelector('.ms-use').addEventListener('click', () => { if (useFn) useFn(m.name); showToast(`${kind === 'reason' ? 'Reasoning' : 'Vision'} model: ${m.name}`); });
        act.querySelector('.ms-rm').addEventListener('click', async () => {
          const ch = await keyChoiceDialog('Remove model?', `Delete ${m.name} from Ollama? Frees disk space; you’d re-download it to use it again.`, [{ label: 'Remove', value: 'rm' }, { label: 'Cancel', value: null }]);
          if (ch !== 'rm') return;
          const r = await window.api.aiDelete(m.name);
          if (r && r.ok) { if (opts.onChanged) opts.onChanged(); load(); showToast(`${m.name} removed`); }
          else showToast(`Couldn't remove: ${r ? r.error : 'please try again'}`);
        });
      } else {
        act.innerHTML = `<button type="button" class="btn ms-dl">${kind === 'reason' ? 'Download & use' : 'Download'}</button><div class="ms-dl-status muted small hidden"></div>`;
        const st = act.querySelector('.ms-dl-status');
        act.querySelector('.ms-dl').addEventListener('click', async () => {
          const ok = await pull(m.name, st);
          if (ok) { if (useFn) useFn(m.name); if (opts.onChanged) opts.onChanged(); load(); showToast(`${m.name} ready ✓`); }
          else st.textContent = 'Failed';
        });
      }
      listEl.appendChild(row);
    }
  }
  q('.ms-pull').addEventListener('click', async () => {
    const name = q('.ms-pull-name').value.trim();
    if (!name) { showToast('Type a model name'); return; }
    const ok = await pull(name, q('.ms-pull-status'));
    if (ok) { if (opts.onChanged) opts.onChanged(); load(); showToast(`${name} ready ✓`); }
  });
  load();
}

function showAiSettings() {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  const c = { ...aiCfg };
  c.memories = (aiCfg.memories || []).map((m) => ({ ...m }));   // editable copy
  // Editable shot-types list — seed with the user's, or the built-in defaults.
  c.shotTypes = (Array.isArray(aiCfg.shotTypes) && aiCfg.shotTypes.length)
    ? aiCfg.shotTypes.map((s) => ({ ...s }))
    : DEFAULT_SHOT_TYPES.map((s) => ({ ...s }));
  if (!c.endpoint) c.endpoint = DEFAULT_OLLAMA_ENDPOINT;
  const tgl = (cls, on) => `<label class="tgl"><input type="checkbox" class="${cls}" ${on ? 'checked' : ''} /><span class="tgl-track"></span></label>`;
  const ICON = {
    engine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.2M12 18.8V21M21 12h-2.2M5.2 12H3M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2 5.6 5.6"/></svg>',
    analysis: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    instructions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="16" rx="1.5"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
    learn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.7 4 4 1.7-4 1.7L12 14l-1.7-3.6-4-1.7 4-1.7z"/><path d="M18 14l.9 2 2 .9-2 .9L18 20l-.9-2.2-2-.9 2-.9z"/></svg>',
    memory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h12a1 1 0 0 1 1 1v15l-7-3.2L5 20V5a1 1 0 0 1 1-1z"/></svg>',
    connection: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="9" width="10" height="6" rx="1"/><path d="M9 9V5M15 9V5M9 19v-4M15 19v-4"/></svg>',
    store: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16l-1 3.5a2 2 0 0 1-2 1.5H7a2 2 0 0 1-2-1.5L4 7z"/><path d="M5 7l1.2-2.4A1 1 0 0 1 7.1 4h9.8a1 1 0 0 1 .9.6L19 7M6 12v7h12v-7"/></svg>'
  };
  const NAV = [['engine', 'Engine'], ['analysis', 'Analysis'], ['instructions', 'Instructions'], ['memory', 'Memory']];
  const navHtml = NAV.map(([id, label], i) => `<button type="button" class="ai-nav-item${i === 0 ? ' active' : ''}" data-nav="${id}"><span class="ai-nav-ic">${ICON[id]}</span><span class="ai-nav-tx">${label}</span></button>`).join('');

  ov.innerHTML = `<div class="modal-card ai-panel ai-settings">
    <nav class="ai-nav">
      <div class="ai-nav-search">
        <svg class="ai-nav-search-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input type="text" class="ai-nav-searchbox" placeholder="Search" spellcheck="false" />
      </div>
      <div class="ai-nav-label">AI suggestions</div>
      <div class="ai-nav-group">${navHtml}</div>
    </nav>
    <div class="ai-main">
      <button type="button" class="ai-close" title="Close — your changes are already saved">✕</button>
      <div class="ai-status" id="aiStatus">Checking Ollama…</div>
      <div class="ai-panes">
        <section class="ai-pane" data-pane="engine">
          <h4 class="ai-pane-title">Engine</h4>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Enable AI suggestions</span><span class="ai-card-sub">Turns on the AI actions (right-click a description → AI)</span></div>
            ${tgl('ai-enabled', c.enabled)}
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Vision model</span><span class="ai-card-sub">The local model that looks at your clips</span></div>
            <div class="ai-ctl-row"><span class="ai-model-mount"></span><button type="button" class="btn subtle ai-refresh">Refresh</button></div>
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Reasoning model <span class="muted small">(optional)</span></span><span class="ai-card-sub">A text model for the thinking tasks — learning rules, grouping memories, refining, multi-pass naming. A strong text model does these far better than a vision model.</span></div>
            <span class="ai-text-model-mount"></span>
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Models</span><span class="ai-card-sub">Browse, download and remove local models — vision &amp; reasoning</span></div>
            <button type="button" class="btn ai-browse-models">Browse models…</button>
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Ollama address</span><span class="ai-card-sub">Default is fine unless you changed Ollama's port</span></div>
            <input type="text" class="ai-input ai-endpoint" value="${escapeAttr(c.endpoint)}" style="width:230px" />
          </div>
        </section>

        <section class="ai-pane hidden" data-pane="analysis">
          <h4 class="ai-pane-title">Analysis</h4>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Multi-pass reasoning</span><span class="ai-card-sub">Names each clip in steps — look, then name in your style, then self-check. Slower but better.</span></div>
            ${tgl('ai-multipass', c.multiPass)}
          </div>
          <div class="ai-row col">
            <div class="ai-row-head"><span class="ai-card-title">Frames analysed per clip</span><span class="ai-val ai-frames-val">${c.frames}</span></div>
            <input type="range" min="1" max="12" step="1" value="${c.frames}" class="ai-frames ai-range" />
            <span class="ai-card-sub">More frames read motion &amp; shot type better, but run slower — they're tiled into one contact-sheet grid.</span>
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Let AI change the subject</span><span class="ai-card-sub">Off = keep your subjects; AI only fills/refines the description &amp; metadata from what it sees.</span></div>
            ${tgl('ai-updsubj', c.updateSubject)}
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Ask me to confirm after each run</span><span class="ai-card-sub">After analysing, step through each clip to confirm or fix its name — every correction teaches the AI.</span></div>
            ${tgl('ai-askrun', c.askAfterRun)}
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Detect shot type</span><span class="ai-card-sub">talking-head / pov / vlog / timelapse… prefixed to the description</span></div>
            ${tgl('ai-shot', c.detectShot)}
          </div>
          <div class="ai-row col">
            <div class="ai-row-head"><div class="ai-card-text"><span class="ai-card-title">Shot types</span><span class="ai-card-sub">The shot types the AI may choose from. Give each a short description so it knows what to look for.</span></div></div>
            <div class="ai-shot-list"></div>
            <button type="button" class="btn subtle ai-shot-add" style="align-self:flex-start">＋ Add shot type</button>
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Guess a Category</span><span class="ai-card-sub">Only from categories you already use</span></div>
            ${tgl('ai-cat', c.suggestCategory)}
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Suggest tags</span><span class="ai-card-sub">Auto-fill each clip's tag row with searchable keywords (place, objects, mood…)</span></div>
            ${tgl('ai-tags', c.suggestTags !== false)}
          </div>
          <div class="ai-row col">
            <div class="ai-row-head"><span class="ai-card-title">Creativity</span><span class="ai-val ai-temp-val">${c.temperature}</span></div>
            <input type="range" min="0" max="1" step="0.05" value="${c.temperature}" class="ai-temp ai-range" />
            <span class="ai-card-sub">Lower = consistent &amp; literal · higher = more varied wording</span>
          </div>
          <h4 class="ai-pane-title" style="margin-top:20px">Face recognition</h4>
          <div class="ai-row col">
            <div class="ai-row-head"><span class="ai-card-title">Scan a frame every</span><span class="ai-val ai-faceint-val">${c.faceInterval}s</span></div>
            <input type="range" min="1" max="15" step="1" value="${c.faceInterval}" class="ai-faceint ai-range" />
            <span class="ai-card-sub">How often to sample the clip when scanning for faces. Smaller = catches people who appear only briefly, but slower.</span>
          </div>
          <div class="ai-row col">
            <div class="ai-row-head"><span class="ai-card-title">Max frames per clip</span><span class="ai-val ai-facemax-val">${c.faceMaxFrames}</span></div>
            <input type="range" min="4" max="120" step="4" value="${c.faceMaxFrames}" class="ai-facemax ai-range" />
            <span class="ai-card-sub">Upper limit so very long clips don't take forever. Frames are spread evenly across the whole clip.</span>
          </div>
        </section>

        <section class="ai-pane hidden" data-pane="instructions">
          <h4 class="ai-pane-title">Instructions to the model</h4>
          <div class="ai-row col">
            <span class="ai-card-sub">Your guidance only — the strict-JSON format &amp; field rules are added automatically.</span>
            <textarea class="ai-prompt ai-textarea" rows="6">${escapeHtml(c.prompt || AI_DEFAULT_GUIDANCE)}</textarea>
            <button type="button" class="btn subtle ai-prompt-reset" style="align-self:flex-start">Reset to default</button>
          </div>
        </section>

        <section class="ai-pane hidden" data-pane="memory">
          <h4 class="ai-pane-title">Memory</h4>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Learn from my edits</span><span class="ai-card-sub">When you change a name the AI suggested, it quietly works out the pattern and asks before remembering.</span></div>
            ${tgl('ai-learnedits', c.learnFromEdits)}
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Learn from each analysis</span><span class="ai-card-sub">After analysing, the AI looks back at what it saw and how it named clips, then folds the pattern into memory automatically.</span></div>
            ${tgl('ai-learnanalysis', c.learnFromAnalysis)}
          </div>
          <div class="ai-row col">
            <div class="ai-card-text"><span class="ai-card-title">Learn my style from a folder</span><span class="ai-card-sub">Reads the names you've already given clips, works out your style, and proposes rules to add (you confirm). Real examples are used in every suggestion.</span></div>
            <div class="ai-ctl-row" style="gap:8px; flex-wrap:wrap">
              <button type="button" class="btn subtle ai-learn-folder">Choose folder…</button>
              <span class="ai-learn-dir muted small" style="align-self:center"></span>
            </div>
            <button type="button" class="btn primary ai-learn-btn" style="align-self:flex-start">Analyse my naming style</button>
            <div class="ai-learn-status muted small hidden"></div>
          </div>
          <div class="ai-row col">
            <div class="ai-row-head"><span class="ai-card-title">Remembered preferences</span><button type="button" class="btn subtle ai-mem-tidy">Tidy &amp; group</button></div>
            <span class="ai-card-sub">What the AI follows on every suggestion — built from your feedback, style, edits and imports. Edit, delete, or add your own.</span>
            <input type="text" class="ai-input ai-mem-search" placeholder="Search memories…" spellcheck="false" />
            <div class="ai-mem-list"></div>
            <div class="ai-ctl-row" style="align-self:flex-start; gap:8px">
              <button type="button" class="btn subtle ai-mem-add">＋ Add memory</button>
              <button type="button" class="btn subtle ai-mem-import">Import notes / SOP…</button>
            </div>
          </div>
        </section>
      </div>
    </div></div>`;
  document.body.appendChild(ov);
  const $$ = (sel) => ov.querySelector(sel);
  let unsubPull = null;
  let memUnsub = null;
  let saved = false;
  // Like the Claude settings — there's no Save button; closing applies the changes.
  function saveAndClose() {
    if (saved) return; saved = true;
    if (unsubPull) unsubPull();
    if (memUnsub) memUnsub();
    document.removeEventListener('keydown', onEsc, true);
    aiCfg = {
      enabled: c.enabled, endpoint: (c.endpoint || '').trim() || DEFAULT_OLLAMA_ENDPOINT, model: (c.model || '').trim(), textModel: (c.textModel || '').trim(),
      suggestCategory: c.suggestCategory, suggestTags: c.suggestTags !== false, frames: c.frames, detectShot: c.detectShot, temperature: c.temperature,
      updateSubject: !!c.updateSubject, askAfterRun: !!c.askAfterRun,
      shotTypes: (c.shotTypes || []).map((s) => ({ name: (s.name || '').trim(), desc: (s.desc || '').trim() })).filter((s) => s.name),
      prompt: (c.prompt || '').trim(),
      multiPass: !!c.multiPass, learnFromEdits: !!c.learnFromEdits, learnFromAnalysis: !!c.learnFromAnalysis,
      faceInterval: c.faceInterval, faceMaxFrames: c.faceMaxFrames,
      memories: c.memories.map((m) => ({ id: m.id, text: (m.text || '').trim(), example: (m.example || '').trim() })).filter((m) => m.text)
    };
    window.api.setPrefs({ ai: aiCfg });
    applyAiPref();
    ov.remove();
  }
  function onEsc(e) { if (e.key === 'Escape') { e.preventDefault(); saveAndClose(); } }
  document.addEventListener('keydown', onEsc, true);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) saveAndClose(); });
  $$('.ai-close').addEventListener('click', saveAndClose);
  $$('.ai-nav-searchbox').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    ov.querySelectorAll('.ai-nav-item').forEach((b) => {
      const txt = b.querySelector('.ai-nav-tx').textContent.toLowerCase();
      b.classList.toggle('hidden', !!q && !txt.includes(q));
    });
  });
  $$('.ai-enabled').addEventListener('change', (e) => { c.enabled = e.target.checked; });
  $$('.ai-cat').addEventListener('change', (e) => { c.suggestCategory = e.target.checked; });
  $$('.ai-tags').addEventListener('change', (e) => { c.suggestTags = e.target.checked; });
  $$('.ai-shot').addEventListener('change', (e) => { c.detectShot = e.target.checked; });
  $$('.ai-updsubj').addEventListener('change', (e) => { c.updateSubject = e.target.checked; });
  $$('.ai-askrun').addEventListener('change', (e) => { c.askAfterRun = e.target.checked; });
  // Editable shot-types list (name + description for the model).
  const shotListEl = $$('.ai-shot-list');
  function renderShots() {
    shotListEl.innerHTML = '';
    c.shotTypes.forEach((s, i) => {
      const row = document.createElement('div'); row.className = 'ai-shot-row';
      const nm = document.createElement('input'); nm.type = 'text'; nm.className = 'ai-input ai-shot-name'; nm.value = s.name || ''; nm.placeholder = 'name (e.g. drone)';
      nm.addEventListener('input', () => { s.name = nm.value; });
      const ds = document.createElement('input'); ds.type = 'text'; ds.className = 'ai-input ai-shot-desc'; ds.value = s.desc || ''; ds.placeholder = 'what it looks like (helps the AI)';
      ds.addEventListener('input', () => { s.desc = ds.value; });
      const del = document.createElement('button'); del.type = 'button'; del.className = 'hk-reset'; del.title = 'Delete'; del.textContent = '✕';
      del.addEventListener('click', () => { c.shotTypes.splice(i, 1); renderShots(); });
      row.append(nm, ds, del);
      shotListEl.appendChild(row);
    });
  }
  renderShots();
  $$('.ai-shot-add').addEventListener('click', () => { c.shotTypes.push({ name: '', desc: '' }); renderShots(); setTimeout(() => { const ins = shotListEl.querySelectorAll('.ai-shot-name'); if (ins.length) ins[ins.length - 1].focus(); }, 10); });
  $$('.ai-multipass').addEventListener('change', (e) => { c.multiPass = e.target.checked; });
  $$('.ai-learnedits').addEventListener('change', (e) => { c.learnFromEdits = e.target.checked; });
  $$('.ai-learnanalysis').addEventListener('change', (e) => { c.learnFromAnalysis = e.target.checked; });
  $$('.ai-endpoint').addEventListener('input', (e) => { c.endpoint = e.target.value; });
  $$('.ai-frames').addEventListener('input', (e) => { c.frames = Number(e.target.value); $$('.ai-frames-val').textContent = c.frames; });
  $$('.ai-temp').addEventListener('input', (e) => { c.temperature = Number(e.target.value); $$('.ai-temp-val').textContent = c.temperature; });
  $$('.ai-faceint').addEventListener('input', (e) => { c.faceInterval = Number(e.target.value); $$('.ai-faceint-val').textContent = `${c.faceInterval}s`; });
  $$('.ai-facemax').addEventListener('input', (e) => { c.faceMaxFrames = Number(e.target.value); $$('.ai-facemax-val').textContent = c.faceMaxFrames; });
  $$('.ai-prompt').addEventListener('input', (e) => { c.prompt = e.target.value; });
  $$('.ai-prompt-reset').addEventListener('click', () => { c.prompt = ''; $$('.ai-prompt').value = AI_DEFAULT_GUIDANCE; });
  // Memory list editor — searchable + auto-grouped into ≤5 collapsible categories.
  const memListEl = $$('.ai-mem-list');
  const memSearch = $$('.ai-mem-search');
  const MEM_CATS = ['Subjects', 'Descriptions', 'Shot types', 'Formatting', 'Other'];
  function memCategory(text) {
    const t = (text || '').toLowerCase();
    if (/\bshot|pov|talking|vlog|angle|camera|motion|footage|b-roll|timelapse|interview|drone\b/.test(t)) return 'Shot types';
    if (/lowercase|case|hyphen|format|prefix|suffix|filename|spell|capital|word count|underscore/.test(t)) return 'Formatting';
    if (/subject|person|name|who|client|people|featured/.test(t)) return 'Subjects';
    if (/descri|keyword|detail|caption|action|what.*happen/.test(t)) return 'Descriptions';
    return 'Other';
  }
  function memRow(m) {
    const row = document.createElement('div'); row.className = 'ai-mem-row';
    const main = document.createElement('div'); main.className = 'ai-mem-main';
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'ai-input ai-mem-text'; inp.value = m.text || ''; inp.placeholder = 'A preference the AI should follow';
    inp.addEventListener('input', () => { m.text = inp.value; });
    const eg = document.createElement('input');
    eg.type = 'text'; eg.className = 'ai-mem-eg'; eg.value = m.example || ''; eg.placeholder = 'e.g. a concrete example (optional)';
    eg.addEventListener('input', () => { m.example = eg.value; });
    main.append(inp, eg);
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'hk-reset ai-mem-del'; del.title = 'Delete'; del.textContent = '✕';
    del.addEventListener('click', () => { c.memories = c.memories.filter((x) => x !== m); renderMems(); });
    row.append(main, del);
    return row;
  }
  function renderMems() {
    memListEl.innerHTML = '';
    if (!c.memories.length) {
      const empty = document.createElement('div');
      empty.className = 'dlg-empty';
      empty.innerHTML = `<span class="illo">${ILLO_MEMORY}</span><p class="dlg-empty-tx">Nothing learned yet</p><p class="muted small">Leave feedback, run “Learn my style”, or add your own — the AI remembers how you like clips named.</p>`;
      memListEl.appendChild(empty);
      return;
    }
    const q = (memSearch.value || '').trim().toLowerCase();
    const items = c.memories.filter((m) => !q || (m.text || '').toLowerCase().includes(q) || (m.example || '').toLowerCase().includes(q));
    if (!items.length) { const e = document.createElement('p'); e.className = 'muted small'; e.textContent = 'No memories match your search.'; memListEl.appendChild(e); return; }
    const groups = {};
    for (const m of items) { const cat = memCategory(m.text); (groups[cat] = groups[cat] || []).push(m); }
    for (const cat of MEM_CATS) {
      const list = groups[cat]; if (!list || !list.length) continue;
      const det = document.createElement('details'); det.className = 'ai-mem-group';
      det.open = !!q;   // collapsed by default; expanded while searching
      const sum = document.createElement('summary'); sum.innerHTML = `${escapeHtml(cat)} <span class="ai-mem-count">${list.length}</span>`;
      det.appendChild(sum);
      for (const m of list) det.appendChild(memRow(m));
      memListEl.appendChild(det);
    }
  }
  memSearch.addEventListener('input', renderMems);
  renderMems();
  // Add memory → full editor with optional "Refine with AI" + revert.
  $$('.ai-mem-add').addEventListener('click', () => {
    showMemoryEditor({ text: '', example: '' }, (saved) => { c.memories.push({ id: '', text: saved.text, example: saved.example || '' }); renderMems(); });
  });
  // Import a document (SOP / naming guide) → AI extracts rules → confirm → add.
  $$('.ai-mem-import').addEventListener('click', () => showImportDialog((items) => {
    for (const it of items) c.memories.push({ id: '', text: it.text, example: it.example || '' });
    renderMems();
  }));
  // If feedback arrives while the dialog is open, reflect the new memories.
  memUnsub = window.api.onAiMemoryUpdated((p) => { if (p && Array.isArray(p.memories)) { c.memories = p.memories.map((m) => ({ ...m })); renderMems(); } });

  // Model store is now a popout (Engine → Browse models…), so it's not a nav pane.
  $$('.ai-browse-models').addEventListener('click', () => showModelStore({
    onUseVision: (name) => { c.model = name; refreshStatus(); },
    onUseReasoning: (name) => { c.textModel = name; refreshStatus(); },
    onChanged: () => refreshStatus()
  }));

  // Sidebar navigation.
  ov.querySelectorAll('.ai-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      ov.querySelectorAll('.ai-nav-item').forEach((b) => b.classList.toggle('active', b === btn));
      const target = btn.dataset.nav;
      ov.querySelectorAll('.ai-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== target));
    });
  });

  // Learn-my-style: choose a folder of already-named clips → propose style rules
  // (you confirm before they're added). Defaults to your Compressed folder.
  let learnDir = (cfg && cfg.finalizeSource) || '';
  const learnDirEl = $$('.ai-learn-dir');
  function showLearnDir() { learnDirEl.textContent = learnDir ? learnDir : 'Compressed folder (default)'; }
  showLearnDir();
  $$('.ai-learn-folder').addEventListener('click', async () => {
    const p = await window.api.pickFolder({ title: 'Choose a folder of named clips to learn from', defaultPath: learnDir });
    if (p) { learnDir = p; showLearnDir(); }
  });
  $$('.ai-learn-btn').addEventListener('click', async () => {
    const btn = $$('.ai-learn-btn'); const st = $$('.ai-learn-status');
    st.classList.remove('hidden'); st.textContent = 'Reading your names and learning your style…';
    const r = await withBusyBtn(btn, null, () => window.api.aiLearnNames(learnDir ? { dir: learnDir } : {}),
      (msg) => { st.textContent = `Couldn't learn: ${msg}`; });
    if (!r || !r.ok) { if (r) st.textContent = `Couldn't learn: ${r.error || 'please try again'}`; return; }
    st.textContent = `Read ${r.examples} of your names.`;
    if (!(r.proposed && r.proposed.length)) { st.textContent += ' No new rules to add — your style is already captured.'; return; }
    showProposedRulesDialog('Rules learned from your style', `From ${r.examples} of your own names. Tick the ones to remember.`, r.proposed, (mems) => { c.memories = mems.map((m) => ({ ...m })); renderMems(); });
  });
  // Tidy & group: consolidate many tiny memories into fewer grouped ones (confirm).
  $$('.ai-mem-tidy').addEventListener('click', async () => {
    const btn = $$('.ai-mem-tidy');
    const r = await withBusyBtn(btn, 'Grouping…', () => window.api.aiConsolidateMemories());
    if (!r || !r.ok) { if (r) showToast(`Couldn't group: ${r.error || 'please try again'}`); return; }
    showProposedRulesDialog('Tidy & group memories', `This replaces your ${r.before} memories with these ${r.proposed.length} grouped ones. Tick to keep, then Apply.`,
      r.proposed, (mems) => { c.memories = mems.map((m) => ({ ...m })); renderMems(); }, { replace: true });
  });

  const statusEl = $$('.ai-status');
  const modelSel = createSelect({ value: c.model, placeholder: '(no models)', empty: '(no models)', style: 'min-width:200px;max-width:280px' });
  $$('.ai-model-mount').appendChild(modelSel.el);
  const textModelSel = createSelect({ value: c.textModel, placeholder: '(use vision model)', style: 'min-width:200px;max-width:280px' });
  $$('.ai-text-model-mount').appendChild(textModelSel.el);
  function fillTextModelSel(models) {
    const list = [{ value: '', label: '(use vision model)' }];
    for (const n of (models || [])) list.push({ value: n, label: n });
    if (c.textModel && !(models || []).includes(c.textModel)) list.push({ value: c.textModel, label: `${c.textModel} (saved)` });
    textModelSel.setOptions(list);
    textModelSel.value = c.textModel || '';
  }
  async function refreshStatus() {
    statusEl.textContent = 'Checking Ollama…';
    statusEl.className = 'ai-status';
    const s = await window.api.getAiStatus();
    if (!s || !s.running) {
      statusEl.innerHTML = `⚠ Ollama not reachable at <code>${escapeHtml(c.endpoint)}</code>. Install it from ollama.com, then it runs in the background.`;
      statusEl.classList.add('warn');
      modelSel.setOptions(c.model ? [{ value: c.model, label: `${c.model} (saved)` }] : []);
      modelSel.value = c.model || '';
      fillTextModelSel([]);
      return;
    }
    const vis = (s.vision && s.vision.length) ? s.vision : [];
    const list = vis.length ? vis : s.models;
    statusEl.innerHTML = vis.length
      ? `✓ Ollama running · ${vis.length} vision model${vis.length !== 1 ? 's' : ''} available`
      : '✓ Ollama running, but no vision model yet. Add one below (e.g. <code>qwen2.5vl:7b</code>).';
    statusEl.classList.add('ok');
    modelSel.setOptions(list.map((n) => ({ value: n, label: n + (vis.includes(n) ? '' : ' (may not see images)') })));
    if (!c.model && list.length) c.model = list[0];
    modelSel.value = c.model || '';
    fillTextModelSel(s.models || list);   // reasoning model can be ANY installed model
  }
  modelSel.onChange((v) => { c.model = v; });
  textModelSel.onChange((v) => { c.textModel = v; });
  $$('.ai-refresh').addEventListener('click', refreshStatus);
  refreshStatus();
}

// Preferences — set the compression intake folder.
function showPreferences() {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  let pending = state.intakeFolder || '';
  const hkRows = HOTKEY_ACTIONS.map((a) =>
    `<div class="hk-row" data-row="${a.id}">
       <div class="hk-info">
         <span class="hk-name">${escapeHtml(a.label)}</span>
         <span class="hk-sub">${escapeHtml(a.desc || '')}</span>
       </div>
       <button type="button" class="hk-key" data-hk="${a.id}">${keycapsHtml(hotkeys[a.id])}</button>
       <button type="button" class="hk-reset" data-hk="${a.id}" title="Reset to default">⟲</button>
     </div>`
  ).join('');
  ov.innerHTML = `<div class="modal-card modal-form pref-modal">
    <h3>Preferences</h3>
    <p class="pref-intro muted small">Where footage is copied, and the shortcuts used while renaming.</p>

    <section class="pref-section">
      <div class="pref-sec-h"><span class="pref-sec-t">Intake folder</span></div>
      <div class="pref-body">
        <div class="pref-row">
          <input type="text" class="pref-path" readonly value="${escapeAttr(pending)}" />
          <button type="button" class="btn pref-browse">Browse…</button>
        </div>
        <p class="muted small pref-hint">Footage is copied here in the Copy step.</p>
      </div>
    </section>

    <section class="pref-section">
      <div class="pref-sec-h"><span class="pref-sec-t">Keyboard shortcuts</span><span class="pref-sec-sub muted small">Rename screen</span></div>
      <div class="pref-body">
        <p class="muted small pref-hint">Click a shortcut, then press your keys.</p>
        <div class="hk-list">${hkRows}</div>
      </div>
    </section>

    <section class="pref-section">
      <div class="pref-sec-h"><span class="pref-sec-t">Text shortcuts</span></div>
      <div class="pref-body">
        <p class="muted small pref-hint">Press a shortcut while typing in a field to insert its text. Use a modifier (Ctrl/Alt) so it won't clash with normal typing.</p>
        <div class="tm-list"></div>
        <button type="button" class="btn subtle tm-add">＋ Add text shortcut</button>
      </div>
    </section>

    <div class="modal-actions">
      <button type="button" class="btn primary pref-save">Save</button>
      <button type="button" class="btn pref-cancel">Cancel</button>
    </div></div>`;
  document.body.appendChild(ov);
  const close = () => { document.removeEventListener('keydown', onPrefKeydown, true); ov.remove(); };
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('.pref-cancel').addEventListener('click', close);
  ov.querySelector('.pref-browse').addEventListener('click', async () => {
    const p = await window.api.pickIntakeFolder();
    if (p) { pending = p; ov.querySelector('.pref-path').value = p; }
  });

  // --- key-capture state shared by action hotkeys + text shortcuts ---
  const pendingHotkeys = { ...hotkeys };
  const macros = (textMacros || []).map((m) => ({ key: m.key || '', text: m.text || '' }));
  let listening = null;     // hk-key button currently capturing
  let listeningMacro = -1;  // macro row index currently capturing
  const renderKey = (btn) => { btn.innerHTML = keycapsHtml(pendingHotkeys[btn.dataset.hk]); };
  const stopListening = () => {
    if (listening) { listening.classList.remove('listening'); renderKey(listening); listening = null; }
    if (listeningMacro >= 0) { listeningMacro = -1; renderMacros(); }
  };

  // Action hotkeys
  ov.querySelectorAll('.hk-key').forEach((btn) => {
    btn.addEventListener('click', () => {
      stopListening();
      listening = btn; btn.classList.add('listening');
      btn.innerHTML = '<span class="kc-listening">Press keys…</span>';
    });
  });
  ov.querySelectorAll('.hk-reset').forEach((btn) => {
    btn.addEventListener('click', () => {
      pendingHotkeys[btn.dataset.hk] = DEFAULT_HOTKEYS[btn.dataset.hk];
      const keyBtn = ov.querySelector(`.hk-key[data-hk="${btn.dataset.hk}"]`);
      if (keyBtn) { keyBtn.classList.remove('listening'); renderKey(keyBtn); }
    });
  });

  // Text shortcuts — dynamic, unlimited rows
  const tmList = ov.querySelector('.tm-list');
  function renderMacros() {
    tmList.innerHTML = '';
    if (!macros.length) {
      const empty = document.createElement('p');
      empty.className = 'muted small'; empty.textContent = 'No text shortcuts yet.';
      tmList.appendChild(empty);
    }
    macros.forEach((m, i) => {
      const row = document.createElement('div'); row.className = 'tm-row';
      const keyBtn = document.createElement('button');
      keyBtn.type = 'button';
      keyBtn.className = 'hk-key tm-key' + (i === listeningMacro ? ' listening' : '');
      keyBtn.innerHTML = (i === listeningMacro) ? '<span class="kc-listening">Press keys…</span>' : keycapsHtml(m.key);
      keyBtn.addEventListener('click', () => { stopListening(); listeningMacro = i; renderMacros(); });
      const txt = document.createElement('input');
      txt.type = 'text'; txt.className = 'tm-text'; txt.placeholder = 'text to insert'; txt.value = m.text;
      txt.addEventListener('input', () => { m.text = txt.value; });
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'hk-reset tm-del'; del.title = 'Remove'; del.textContent = '✕';
      del.addEventListener('click', () => { macros.splice(i, 1); if (listeningMacro === i) listeningMacro = -1; renderMacros(); });
      row.append(keyBtn, txt, del);
      tmList.appendChild(row);
    });
  }
  renderMacros();
  ov.querySelector('.tm-add').addEventListener('click', () => { macros.push({ key: '', text: '' }); renderMacros(); });

  // Unified key capture (action hotkey OR text-shortcut key). Attached at the
  // DOCUMENT level so it fires no matter where focus is — rebuilding a macro row
  // moves focus to <body>, which a listener on the modal would never catch.
  function onPrefKeydown(e) {
    if (!listening && listeningMacro < 0) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { stopListening(); return; }
    const key = eventToHotkey(e);
    if (!key) return;
    if (listening) {
      pendingHotkeys[listening.dataset.hk] = key;
      listening.classList.remove('listening'); renderKey(listening); listening = null;
    } else if (listeningMacro >= 0) {
      macros[listeningMacro].key = key; listeningMacro = -1; renderMacros();
    }
  }
  document.addEventListener('keydown', onPrefKeydown, true);

  ov.querySelector('.pref-save').addEventListener('click', async () => {
    const saved = await window.api.setIntake(pending);
    state.intakeFolder = saved;
    const line = document.getElementById('intakePathLine');
    if (line) line.textContent = saved;
    hotkeys = { ...hotkeys, ...pendingHotkeys };
    textMacros = macros.filter((m) => m.key && m.text);
    await window.api.setPrefs({ hotkeys, textMacros });
    close();
  });
}

// Edit subjects — manage the reusable subject history.
function showEditSubjects() {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card modal-form">
    <h3>Subjects</h3>
    <p class="muted small">Reusable subjects shown when naming clips.</p>
    <div class="subj-add">
      <input type="text" class="f-desc subj-new" placeholder="Add a subject…" autocomplete="off" />
      <button type="button" class="btn primary subj-add-btn">Add</button>
    </div>
    <ul class="subj-list"></ul>
    <div class="modal-actions"><button type="button" class="btn primary subj-done">Done</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('.subj-done').addEventListener('click', close);

  async function renderList() {
    const subs = await window.api.getSubjects();
    const list = ov.querySelector('.subj-list');
    list.innerHTML = subs.length ? '' : '<li class="muted small subj-empty">No subjects yet.</li>';
    for (const s of subs) {
      const li = document.createElement('li');
      li.className = 'subj-item';
      li.innerHTML = `<span>${escapeHtml(s)}</span><button type="button" class="btn ghost subj-del" title="Remove">✕</button>`;
      li.querySelector('.subj-del').addEventListener('click', async () => {
        await window.api.removeSubject(s);
        await renderList();
        await refreshSubjectOptions();
      });
      list.appendChild(li);
    }
  }
  async function add() {
    const inp = ov.querySelector('.subj-new');
    if (slug(inp.value)) { await rememberSubject(inp.value); inp.value = ''; await renderList(); }
  }
  ov.querySelector('.subj-add-btn').addEventListener('click', add);
  ov.querySelector('.subj-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  renderList();
}

// ---------------------------------------------------------------------------
// Navigation: back to the start screen + clickable step pills
// ---------------------------------------------------------------------------
// While a copy runs, confirm before navigating away from the transfer view
// (the copy keeps running in the background; the header chip brings you back).
async function confirmLeaveTransfer() {
  if (!copyInProgress) return true;
  return confirmDialog('Leave the transfer view?',
    'The copy keeps running in the background — use the “Copying…” chip to come back.',
    'Leave', 'Stay');
}

async function goHome() {
  if (!(await confirmLeaveTransfer())) return;
  closePopover();
  $('flow').classList.add('hidden');
  $('finalize').classList.add('hidden');
  $('phone').classList.add('hidden');
  $('actionList').classList.remove('hidden'); $('driveList').classList.remove('hidden'); showHomeExtras();
  // (no phoneBackup flag to reset — isPhoneFlow() is derived from state.scannedDrive)
  // Leaving the flow ends the copy→verify→delete session. Anything we copied belonged to THAT
  // session; carrying it home meant a later, unrelated flow could still offer to delete it.
  // (Deleting from a card is only ever allowed as a deliberate act within the flow that copied it.)
  state.copied = [];
  if (state.drive) $('driveBanner').classList.remove('hidden');
  saveSession({ view: 'home' });   // back on Home → nothing to resume into next launch
  refreshDriveList();   // re-read removable drives when returning home
  renderPendingWork();  // refresh the "footage to deal with" banner (counts may have changed)
}

