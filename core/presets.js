// PRESETS — a portable description of a WORKFLOW, safe to hand to someone else.
//
// Sixth module in `core/` (see core/clip-key.js for the three rules: packaging allowlist, `./core/`
// not `../core/`, STATELESS).
//
// Jake, 2026-07-22: *"you should build it as if it was an application that worked without all the
// compression folders and stuff and just worked and then can be mega customized to the point where I
// have it… I should also be able to have presets, and save my setups as a preset and then share it."*
//
// **Sharing is the requirement that shapes everything here.** A preset that never left the machine
// could just be a copy of config.json. One that is handed to someone else must carry no absolute
// paths (they name his disks and his username) and no personal data (his people, his faces, his
// subjects, his library) — and on the way back IN it is a file from outside this app, so it is
// untrusted and must never be able to touch footage.
//
// ⚠⚠ THE EXPORT IS AN ALLOWLIST, AND THAT IS THE WHOLE SAFETY ARGUMENT.
//
// A denylist ("everything except people/faces/ledger") is the obvious shape and it is wrong in the
// one way that matters: it is correct only until someone adds a config key. The next personal field
// added anywhere in this app would be exported to strangers by default, silently, and nothing would
// fail. An allowlist fails the other way — a new setting is simply missing from presets until
// someone deliberately adds it, which is a bug report rather than a leak.
//
// The same argument applies on import: only allowlisted keys are read out of the incoming file, so a
// hand-edited preset cannot set `projectsRoot`, `intakeFolder`, or anything else that points at a
// disk.
'use strict';

const PRESET_VERSION = 1;

// Settings that describe HOW he works. Every one of these is portable: it means the same thing on
// someone else's machine, and none of them names a disk, a person, or a piece of his footage.
//
// Dotted paths address into nested config (`ai.frames`). Order is irrelevant.
const ALLOWED = [
  // — how clips get named —
  'organizeFields',       // his custom taxonomy fields ({id,label}) — the SHAPE, not the values
  'folderLevels',         // which fields become folder levels, in order
  'copyDateMode',
  'enterFlow',
  'videoExtensions',
  'imageExtensions',

  // — filing —
  'ai.routes',            // standing filing rules. dests are RELATIVE to the projects root (see below)
  'nasBackup.enabled',    // the FLAG travels; the path never does

  // — the AI, as configuration rather than as learned content —
  'ai.enabled',
  'ai.model',
  'ai.textModel',
  'ai.suggestCategory',
  'ai.frames',
  'ai.detectShot',
  'ai.updateSubject',
  'ai.shotTypes',
  'ai.askAfterRun',
  'ai.temperature',
  'ai.numCtxMax',
  'ai.numCtx',
  'ai.prompt',            // his custom guidance text — his words, but about METHOD, not about people
  'ai.multiPass',
  'ai.learnFromEdits',
  'ai.faceInterval',
  'ai.faceMaxFrames',

  // — behaviour —
  'autoPoll',
  'pollIntervalMs',
  'defaultSpeed',
  'previewWidth',
  'hotkeys',
  'textMacros',
];

// ⚠ NEVER EXPORTABLE, and listed explicitly so the intent survives a refactor. This list is NOT what
// makes the export safe — the allowlist above is — but a reader who adds a key deserves to see why
// these are missing. Two kinds:
//   PERSONAL   — his people, his faces, his vocabulary, his library, his typing.
//   MACHINE    — absolute paths naming his disks and his Windows username.
const NEVER_EXPORT = [
  // personal
  'ai.people', 'ai.facesPending', 'ai.faceScenes', 'ai.clipObs', 'ai.memories', 'ai.feedbackLog',
  'ai.shootMemory', 'subjects', 'fieldHistory', 'renameDrafts', 'finalMeta', 'projectLedger',
  'renameVersions', 'copiedLog', 'lastLedger', 'imports', 'session',
  // machine-specific paths
  'projectsRoot', 'intakeFolder', 'compressedFolder', 'organizeDest', 'finalizeSource',
  'nasBackup.path', 'phoneBackupFolder', 'ffmpegPath', 'ffprobePath', 'ai.endpoint',
];

function getPath(obj, dotted) {
  let cur = obj;
  for (const seg of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}
function setPath(obj, dotted, value) {
  const segs = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const k = segs[i];
    if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[segs[segs.length - 1]] = value;
}

// Deep clone through JSON so nothing in an exported preset can alias live config — and so a value
// that cannot survive a round trip (a function, a Date, undefined) is dropped here rather than
// producing a preset that behaves differently from the file it writes.
function plain(v) {
  if (v === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(v)); } catch { return undefined; }
}

// ⚠ A FILING RULE'S `dest` IS RELATIVE TO THE PROJECTS ROOT — and this app has already been bitten
// once by a dest that outlived the root it was written against (see `stripStaleRootPrefix`). A
// preset crossing machines is exactly that situation by construction, so an absolute-looking dest
// must never travel: it would name his drive letter and his username to whoever he sends it to.
function sanitizeRoutes(routes) {
  const out = [];
  for (const r of (Array.isArray(routes) ? routes : [])) {
    if (!r || typeof r !== 'object') continue;
    const copy = plain(r);
    if (!copy) continue;
    if (typeof copy.dest === 'string') {
      const d = copy.dest.replace(/\\/g, '/');
      // Windows drive (`C:/…`), UNC (`//server/…`) or POSIX absolute (`/mnt/…`) — all machine-specific.
      if (/^[a-z]:\//i.test(d) || d.startsWith('//') || d.startsWith('/')) continue;   // drop the rule, not just the path
      copy.dest = d.replace(/^\/+|\/+$/g, '');
    }
    out.push(copy);
  }
  return out;
}

// Build a shareable preset from a live config.
function buildPreset(config, { name = 'My setup', note = '' } = {}) {
  const settings = {};
  for (const key of ALLOWED) {
    let v = plain(getPath(config, key));
    if (v === undefined) continue;
    if (key === 'ai.routes') {
      v = sanitizeRoutes(v);
      if (!v.length) continue;
    }
    setPath(settings, key, v);
  }
  return {
    kind: 'usb-auto-action-preset',
    version: PRESET_VERSION,
    name: String(name || '').slice(0, 80) || 'My setup',
    note: String(note || '').slice(0, 500),
    settings,
  };
}

// Is this file plausibly one of ours, and is it a version we understand?
function validatePreset(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: 'That file is not a preset.' };
  }
  if (obj.kind !== 'usb-auto-action-preset') {
    return { ok: false, error: 'That file is not a Project preset — it may be a different app’s settings.' };
  }
  const v = Number(obj.version);
  if (!Number.isFinite(v) || v < 1) return { ok: false, error: 'That preset is missing a version.' };
  if (v > PRESET_VERSION) {
    return { ok: false, error: `That preset was made by a newer version of the app (preset v${v}, this build reads v${PRESET_VERSION}). Update, then import it.` };
  }
  if (!obj.settings || typeof obj.settings !== 'object' || Array.isArray(obj.settings)) {
    return { ok: false, error: 'That preset has no settings in it.' };
  }
  return { ok: true, version: v };
}

// What WOULD change, without changing anything. The import UI shows this first: a preset rewrites how
// his app behaves, and "apply and find out" is not an acceptable shape for that.
function diffPreset(config, preset) {
  const check = validatePreset(preset);
  if (!check.ok) return check;
  const changes = [];
  const ignored = [];
  for (const key of Object.keys(flatten(preset.settings))) {
    if (!ALLOWED.includes(key)) { ignored.push(key); continue; }
    const next = plain(getPath(preset.settings, key));
    const cur = plain(getPath(config, key));
    if (JSON.stringify(cur) !== JSON.stringify(next)) changes.push({ key, from: cur, to: next });
  }
  return { ok: true, changes, ignored };
}

// Flatten to the dotted leaf keys the allowlist speaks in. An object-valued allowlist entry
// (`hotkeys`, `nasBackup.enabled`) stops the recursion, so it is compared as a whole.
function flatten(obj, prefix = '', out = {}) {
  for (const k of Object.keys(obj || {})) {
    const dotted = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (ALLOWED.includes(dotted) || v === null || typeof v !== 'object' || Array.isArray(v)) out[dotted] = v;
    else flatten(v, dotted, out);
  }
  return out;
}

// Apply a preset onto a config object, in place. Returns what it did.
//
// ⚠ ONLY ALLOWLISTED KEYS ARE READ. A hand-edited preset carrying `projectsRoot` or `ai.people` is
// not rejected — it is simply not listened to, and the extra keys come back in `ignored` so the UI
// can say so rather than pretending the file was clean.
function applyPreset(config, preset) {
  const check = validatePreset(preset);
  if (!check.ok) return check;
  const applied = [];
  const ignored = [];
  for (const key of Object.keys(flatten(preset.settings))) {
    if (!ALLOWED.includes(key)) { ignored.push(key); continue; }
    let v = plain(getPath(preset.settings, key));
    if (v === undefined) continue;
    if (key === 'ai.routes') v = sanitizeRoutes(v);
    setPath(config, key, v);
    applied.push(key);
  }
  return { ok: true, applied, ignored };
}

module.exports = {
  PRESET_VERSION, ALLOWED, NEVER_EXPORT,
  buildPreset, validatePreset, diffPreset, applyPreset, sanitizeRoutes,
};
