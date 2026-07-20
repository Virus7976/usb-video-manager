// READ-ONLY access to the app's JSON stores, shared by the desktop app and the HTTP backend.
//
// This is the second module in `core/` (see core/clip-key.js for why core/ exists and the three
// rules that govern it — packaging allowlist, `./core/` not `../core/`, and STATELESS).
//
// ⚠⚠ READ-ONLY, DELIBERATELY, AND THAT IS THE WHOLE POINT OF THIS SLICE.
//
// The desktop app owns every write. It has atomic writes, a read-failure quarantine that blocks
// writing a store it could not read, debounced saves, caps, prunes and an undo record — all of which
// took a long time to get right and several of which were fixed today. A second process writing the
// same files would race every one of those.
//
// So the backend starts able to SHOW him his work and nothing else. Confirming a face from the phone
// will not write these files directly; it will hand the desktop app an instruction. That is a
// deliberate ordering decision, not an unfinished one.
//
// No dependencies, no state, no caching — every call re-reads. Callers that need caching own it.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// The store directory the desktop app uses. Mirrors main-mod/01-core.js:
//   STORE_DIR = <appData>/USB SD Auto-Action
// where appData is Electron's `app.getPath('appData')` — on Windows that is %APPDATA% (Roaming).
// Overridable so the backend can be pointed at a copy, and so tests never touch his real store.
function storeDir(override) {
  if (override) return override;
  if (process.env.UVD_STORE_DIR) return process.env.UVD_STORE_DIR;
  const appData = process.platform === 'win32'
    ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : path.join(os.homedir(), '.config');
  return path.join(appData, 'USB SD Auto-Action');
}

// Filenames as the desktop app writes them. ⚠ `renameDrafts` lives in `drafts.json`, NOT
// `rename-drafts.json` — there is a 2-byte orphan of that name in his store dir from an older
// naming, and reading it would report zero drafts on a store holding 4,594.
const FILES = {
  config: 'config.json',
  drafts: 'drafts.json',
  finalMeta: 'final-meta.json',
  people: 'people.json',
  facesPending: 'faces-pending.json',
  faceScenes: 'face-scenes.json',
  clipObs: 'clip-observations.json',
  projectLedger: 'project-ledger.json',
  copiedLog: 'copied-log.json',
  aiQuestions: 'ai-questions.json',
  versions: 'versions.json',
};

// Read one store. Returns `fallback` when the file is absent, and THROWS when it exists but cannot
// be parsed — the caller must be able to tell "he has none" from "the file is broken", because
// treating a corrupt store as empty is precisely how this app has lost work before.
function readStore(name, { dir, fallback = null } = {}) {
  const file = FILES[name];
  if (!file) throw new Error(`unknown store: ${name}`);
  const full = path.join(storeDir(dir), file);
  let raw;
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const e = new Error(`${file} exists but could not be parsed: ${err.message}`);
    e.code = 'ESTORECORRUPT';
    e.store = name;
    throw e;
  }
}

// Which stores are present and readable. Used by /health so the phone can say something honest
// before he has plugged anything in, rather than showing an empty review that looks like data loss.
function storeHealth({ dir } = {}) {
  const out = {};
  for (const name of Object.keys(FILES)) {
    const full = path.join(storeDir(dir), FILES[name]);
    try {
      const st = fs.statSync(full);
      try {
        JSON.parse(fs.readFileSync(full, 'utf8'));
        out[name] = { present: true, ok: true, bytes: st.size };
      } catch {
        out[name] = { present: true, ok: false, bytes: st.size };
      }
    } catch {
      out[name] = { present: false, ok: true, bytes: 0 };
    }
  }
  return out;
}

// The face review, shaped for a phone screen.
//
// Deliberately DROPS the descriptor arrays. They are ~1.2 KB each even at the 5dp precision the app
// now stores, and his faces-pending.json is 12 MB of them — sending that to a phone over a LAN for a
// UI that only needs a thumbnail and a name would be absurd. The phone never computes distances;
// matching stays where the models are.
// The stored `thumb` is a `file:///C:/Users/.../faces/xxxx.jpg` URL — the crops live on disk and the
// desktop renderer loads them directly. A PHONE cannot resolve that, so handing it out unchanged
// produces a review grid of broken images. Found by actually RUNNING the server against a copy of his
// store, not by reading the shape: the field is a non-empty string either way.
//
// So the crop's bare filename is exposed instead and the server streams the bytes. "Bare filename,
// no path" is also what makes the serving route boundable.
function cropNameFromThumb(thumb) {
  const s = String(thumb || '');
  if (!s) return '';
  const m = s.match(/([^/\\]+\.(?:jpg|jpeg|png|webp))$/i);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

function pendingFaces({ dir } = {}) {
  const raw = readStore('facesPending', { dir, fallback: [] }) || [];
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((c) => c && !c.done && !c.rejected && !c.skipped)
    .filter((c) => cropNameFromThumb(c.thumb))   // no crop → not identifiable and not showable
    .map((c) => ({
      // ⚠ THE ID MUST BE STABLE ACROSS RESCANS. This was the array index, which is only meaningful
      // for the exact list that produced it: the desktop merges new clusters into this store on every
      // scan, so index 7 this evening is a different face tomorrow morning. A phone answer queued
      // against an index would silently confirm the WRONG person — the same "tagged the wrong clip"
      // shape already fixed twice in the desktop app.
      //
      // The crop filename is generated per cluster, unique, and never rewritten in place, so it
      // identifies the same face for as long as that face exists.
      id: cropNameFromThumb(c.thumb),
      crop: cropNameFromThumb(c.thumb),
      suggest: c.suggest ? { name: c.suggest.name || '', dist: Number(c.suggest.dist) || 0 } : null,
      clips: Array.isArray(c.clipKeys) ? c.clipKeys.length : 0,
      samples: Array.isArray(c.descriptors) ? c.descriptors.length : 0,
    }));
}

// Enrolled people, for the "who is this?" chips. `people:get` on the desktop side returns
// {id,name,thumb,count,confirmed,unconfirmed} and never sends the faces array; matched here so the
// two clients show the same thing.
function people({ dir } = {}) {
  const raw = readStore('people', { dir, fallback: [] }) || [];
  const list = Array.isArray(raw) ? raw : [];
  return list.map((p) => {
    const faces = Array.isArray(p.faces) ? p.faces : [];
    const confirmed = faces.filter((f) => f && f.confirmed).length;
    return {
      id: p.id || '',
      name: p.name || '',
      crop: cropNameFromThumb(p.thumb),
      count: faces.length,
      confirmed,
      unconfirmed: faces.length - confirmed,
    };
  }).filter((p) => p.name);
}

// Questions the AI still wants answered. Empty is the normal case.
function questions({ dir } = {}) {
  const raw = readStore('aiQuestions', { dir, fallback: [] }) || [];
  return Array.isArray(raw) ? raw : [];
}

// Where the face crops live, and the ONLY way this module hands back a path to one.
//
// PATH-TRAVERSAL BOUNDED. The name arrives from an HTTP query string, so `../../../etc/passwd` and
// absolute paths are expected input, not hypothetical. The name is rejected if it contains any
// separator BEFORE joining, and the resolved path is re-checked to still be inside the faces
// directory afterwards — so neither an encoding trick nor a symlink games the join. This app already
// learned this once (#95: three handlers took a renderer-supplied path and read the disk with it).
function facesDir(dir) { return path.join(storeDir(dir), 'faces'); }

function faceCropPath(name, { dir } = {}) {
  const n = String(name || '');
  if (!n || n.includes('/') || n.includes('\\') || n.includes('\u0000') || n.startsWith('.')) return '';
  if (!/^[\w.-]+\.(?:jpg|jpeg|png|webp)$/i.test(n)) return '';
  const base = path.resolve(facesDir(dir));
  const full = path.resolve(path.join(base, n));
  if (!full.startsWith(base + path.sep)) return '';
  try { if (!fs.statSync(full).isFile()) return ''; } catch { return ''; }
  return full;
}

module.exports = {
  storeDir, FILES, readStore, storeHealth, pendingFaces, people, questions,
  cropNameFromThumb, facesDir, faceCropPath,
};
