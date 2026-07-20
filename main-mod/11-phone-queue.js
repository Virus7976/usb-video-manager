// APPLYING THE ANSWERS HE GAVE ON HIS PHONE.
//
// The backend never writes a store — it appends instructions to `phone-actions.jsonl`, and this is
// the other half: the desktop reads them and applies them here, in the process that owns those files.
// See core/action-queue.js for why the split exists (atomic writes, the read-failure quarantine, the
// caps, the prunes and the single undo record all live on this side; two writers would race them).
//
// ⚠ THIS FILE IS BUNDLED LAST (11-), so every helper it uses is already defined. `aiFacesPending`,
// `saveStore` and friends are function declarations in 08-, which hoist across the concatenated
// bundle — but the `const`s in those files do NOT, so nothing here may run at module-init time. It
// doesn't: everything is inside an ipcMain handler.
'use strict';

const phoneQueue = require('./core/action-queue');

// A phone answer identifies a cluster by its CROP FILENAME, not by a list index — indices shift when
// the desktop merges new clusters on the next scan, and an answer applied to a shifted index would
// confirm the wrong person. Match the same way here.
function cropNameOf(cluster) {
  const s = String((cluster && cluster.thumb) || '');
  const m = s.match(/([^/\\]+\.(?:jpg|jpeg|png|webp))$/i);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

// Apply everything waiting. Returns what actually happened, per action, so the caller can report
// honestly rather than claiming a number it did not verify.
//
// Deliberately NOT automatic-on-boot: it mutates his face data, so it runs when something asks. The
// renderer calls it after the store is loaded and tells him what landed.
ipcMain.handle('phone:applyQueue', async () => {
  let pending = [];
  try {
    pending = phoneQueue.read({ dir: STORE_DIR });
  } catch (err) {
    return { ok: false, error: `Could not read the phone queue: ${err.message}`, applied: 0, results: [] };
  }
  if (!pending.length) return { ok: true, applied: 0, results: [], nothingToDo: true };

  // ⚠ REFUSE TO TOUCH A STORE WE COULD NOT READ. Same contract the rest of the app follows: an
  // unreadable faces-pending.json leaves an empty default in memory, and applying answers against
  // that would write a store containing only what the phone happened to mention — i.e. delete the
  // review. saveStore already blocks the write, but failing here means we also do not mark the
  // actions applied, so they survive for the next launch.
  if (storeReadFailed['ai.facesPending']) {
    return { ok: false, error: 'faces-pending.json could not be read this launch — nothing applied, your answers are kept.', applied: 0, results: [] };
  }

  const clusters = aiFacesPending();
  const byCrop = new Map();
  for (const c of (Array.isArray(clusters) ? clusters : [])) {
    const n = cropNameOf(c);
    if (n && !byCrop.has(n)) byCrop.set(n, c);
  }

  const results = [];
  const appliedIds = [];
  let changed = false;

  for (const act of pending) {
    const id = String(act.id || '');
    const target = String(act.clusterId || '');
    const cluster = byCrop.get(target);

    // A cluster that no longer exists is NOT a failure to retry forever — he may have answered it at
    // the PC in the meantime, which is the commonest case. Mark it applied so it stops being offered,
    // and say so.
    if (!cluster && act.type && act.type.startsWith('face.')) {
      results.push({ id, type: act.type, ok: true, note: 'already handled at the PC' });
      appliedIds.push(id);
      continue;
    }

    try {
      if (act.type === 'face.confirm') {
        const name = String(act.name || '').trim();
        if (!name) { results.push({ id, type: act.type, ok: false, error: 'no name' }); continue; }
        // Enrol through the SAME handler the desktop review uses, so the 80-face cap, the
        // confirmed-first shedding and the crop bookkeeping all apply identically. A phone answer
        // must not be a second, subtly different enrolment path.
        // The SAME function the desktop review enrols through (extracted from the people:save
        // handler in 08-, which cannot be invoked directly). A second enrolment path would drift
        // from the first — the exact twin problem this codebase keeps producing.
        const saved = savePersonRecord({
          name,
          descriptors: Array.isArray(cluster.descriptors) ? cluster.descriptors : [],
          thumb: cluster.thumb || '',
          confirmed: true,
        });
        if (!saved || !saved.ok) {
          results.push({ id, type: act.type, ok: false, error: (saved && saved.error) || 'could not enrol' });
          continue;   // left unmarked, so it is retried rather than lost
        }
        cluster.done = true;
        cluster.assignedName = name;
        changed = true;
        results.push({ id, type: act.type, ok: true, name });
      } else if (act.type === 'face.reject') {
        cluster.rejected = true;
        changed = true;
        results.push({ id, type: act.type, ok: true });
      } else if (act.type === 'face.skip') {
        cluster.skipped = true;
        changed = true;
        results.push({ id, type: act.type, ok: true });
      } else {
        // An action this build does not understand must NOT be marked applied — a newer phone client
        // may be ahead of this desktop, and dropping it silently would lose his answer.
        results.push({ id, type: act.type || '(none)', ok: false, error: 'not supported by this version' });
        continue;
      }
      appliedIds.push(id);
    } catch (err) {
      // Left unmarked on purpose, so it is retried next time rather than lost.
      results.push({ id, type: act.type, ok: false, error: err.message });
    }
  }

  if (changed) {
    try { saveStore('ai.facesPending'); } catch (err) {
      // If the review could not be persisted, do NOT mark anything applied — otherwise his answers
      // vanish from the queue AND never reached disk.
      return { ok: false, error: `Could not save the review: ${err.message}`, applied: 0, results };
    }
  }
  // Marked only after the store write succeeded. Append-only, so this cannot race the server.
  try { phoneQueue.markApplied(appliedIds, { dir: STORE_DIR, at: Date.now() }); } catch { /* retried next run */ }

  const okN = results.filter((r) => r.ok).length;
  return { ok: true, applied: okN, failed: results.length - okN, results };
});

// How many answers are waiting, for a badge. Cheap and read-only.
ipcMain.handle('phone:queueCount', () => {
  try { return { ok: true, count: phoneQueue.read({ dir: STORE_DIR }).length }; }
  catch { return { ok: false, count: 0 }; }
});
