// THE INSTRUCTION QUEUE — how the phone changes anything without racing the desktop app.
//
// Third module in `core/` (see core/clip-key.js for the rules: packaging allowlist, `./core/` not
// `../core/`, and STATELESS).
//
// ⚠⚠ THE WHOLE DESIGN, IN ONE PARAGRAPH.
//
// The phone must never write `faces-pending.json`, `people.json` or any other store. The desktop app
// owns those, and that ownership is load-bearing: atomic writes, a read-failure quarantine that
// refuses to write a store it could not read, debounced saves, caps, prunes and a single undo record.
// Two writers would race every one of them. So the phone appends an INSTRUCTION to a file nothing
// else writes, and the desktop applies it on its own terms, in its own process, through its own
// existing handlers. One writer per file, always.
//
// That also means a phone action is never lost to a conflict: the worst case is that it sits in the
// queue until the desktop next runs, which is exactly the behaviour wanted for "answer it on the
// couch, it lands when I'm back at the PC".
//
// ⚠ APPEND-ONLY, AND NEVER REWRITTEN IN PLACE. Entries are marked applied by the DESKTOP writing a
// separate `appliedAt`; the server only ever adds. That is what makes a torn write survivable — a
// half-written entry is dropped on read and everything before it is intact.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const QUEUE_FILE = 'phone-actions.jsonl';

// JSON Lines, not a JSON array. An array would have to be re-serialised whole on every append, which
// is both a read-modify-write race with itself and a torn-file risk that loses EVERY earlier action.
// One JSON object per line appends atomically enough at these sizes, and a corrupt final line costs
// exactly that one action.
function queuePath(dir) { return path.join(dir, QUEUE_FILE); }

// ⚠ WHAT THE DESKTOP CAN ACTUALLY APPLY — nothing more.
//
// This list was written aspirationally and included `question.answer`. That was a mistake, and
// exactly the one the comment on `validate` warns about: an instruction the desktop cannot apply is
// WORSE than a rejected request, because it sits in the queue looking like pending work forever while
// nothing ever consumes it. I built the thing I had just written a warning against.
//
// Why questions genuinely cannot be answered remotely yet, unlike faces: an AI question is keyed by
// `clipIndex` into `state.scannedFiles` — a position in the LIVE card session in the renderer's
// memory, not a durable record. There may be no session at all when the answer arrives, and if there
// is, the index likely refers to a different clip (the same shifting-index hazard that made cluster
// ids move to crop filenames). Faces work because a cluster is a persisted record with a stable id.
//
// Answering questions from the phone needs a durable question model first. Until that exists, the
// server REFUSES the action rather than banking something that can never land. Reading questions
// (GET /api/questions) is still fine — showing him what is waiting costs nothing and misleads nobody.
const ACTIONS = new Set([
  'face.confirm',    // { clusterId, name }   — this cluster is this person
  'face.reject',     // { clusterId }         — not a person / don't ask again
  'face.skip',       // { clusterId }         — ask me later
]);

// Validate before it ever reaches disk. An instruction the desktop cannot understand is worse than a
// rejected request: it sits in the queue looking like pending work forever.
function validate(action) {
  const a = action && typeof action === 'object' ? action : {};
  const type = String(a.type || '');
  if (!ACTIONS.has(type)) return { ok: false, error: `unknown action: ${type || '(none)'}` };
  if (type.startsWith('face.')) {
    const id = String(a.clusterId != null ? a.clusterId : '');
    if (!id) return { ok: false, error: 'clusterId is required' };
    if (type === 'face.confirm') {
      const name = String(a.name || '').trim();
      if (!name) return { ok: false, error: 'name is required to confirm a face' };
      if (name.length > 120) return { ok: false, error: 'name is too long' };
    }
  }
  return { ok: true };
}

// Append one instruction. `at` is passed in rather than read from the clock so the caller owns time
// (and so tests are deterministic) — the same reason workflow scripts here take timestamps as input.
function append(action, { dir, at, source = 'phone' } = {}) {
  const v = validate(action);
  if (!v.ok) return v;
  const rec = {
    id: `${at}-${Math.abs(hash(JSON.stringify(action)))}`,
    at,
    source,
    ...action,
  };
  const line = `${JSON.stringify(rec)}\n`;
  fs.mkdirSync(dir, { recursive: true });
  // 'a' is O_APPEND: concurrent appends of a single short line do not interleave on any filesystem
  // this runs on, and no earlier content can be lost by a writer that fails partway.
  fs.appendFileSync(queuePath(dir), line, 'utf8');
  return { ok: true, id: rec.id };
}

// ⚠⚠ MARKING SOMETHING APPLIED IS ALSO AN APPEND, NEVER A REWRITE.
//
// The first version had the desktop rewrite each record with an `appliedAt` field. That is a
// read-modify-write on the very file the SERVER appends to — the two would race, and a phone answer
// arriving mid-rewrite would be silently dropped. Exactly the class of bug this queue exists to
// avoid, reintroduced by the bookkeeping.
//
// So the desktop appends a MARKER line instead. Both sides only ever append; neither can lose the
// other's writes. `read` folds the markers in.
const APPLIED = '_applied';

function markApplied(ids, { dir, at } = {}) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  if (!list.length) return { ok: true, marked: 0 };
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(queuePath(dir), `${JSON.stringify({ type: APPLIED, ids: list, at })}\n`, 'utf8');
  return { ok: true, marked: list.length };
}

// Read the queue. A malformed line is SKIPPED rather than throwing — one torn final line must not
// make every earlier action unreadable, which is the entire reason this is JSONL.
function read({ dir, includeApplied = false } = {}) {
  let raw;
  try { raw = fs.readFileSync(queuePath(dir), 'utf8'); } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const lines = [];
  const applied = new Set();
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let rec;
    try { rec = JSON.parse(s); } catch { continue; }   // torn or truncated — costs this one action
    if (!rec || typeof rec !== 'object') continue;
    if (rec.type === APPLIED) { for (const id of (rec.ids || [])) applied.add(String(id)); continue; }
    lines.push(rec);
  }
  // Markers may appear before or after the record they refer to (the desktop could mark a batch it
  // read moments ago), so applied-ness is resolved after the whole file is seen — never positionally.
  return includeApplied ? lines : lines.filter((r) => !applied.has(String(r.id)));
}

// Tiny non-cryptographic hash, only to make ids unique within a millisecond. Not security.
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return h;
}

module.exports = { QUEUE_FILE, ACTIONS, APPLIED, queuePath, validate, append, read, markApplied };
