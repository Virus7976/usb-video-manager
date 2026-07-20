// Concurrency audit findings 2-4 — the last things touching footage before the backend work starts.
//
//   2. ⚠ "Follow AI ↓" did `aiFollow = true; aiAborted = false;`. The second half has no business in
//      a scroll button and silently RESUMED a cancelled run. That button is visible only DURING a run
//      and only once he has scrolled away — exactly the state someone is in when they cancel. Press
//      Cancel, the loop is still inside a vision call for up to 180s, click the still-visible button
//      to see what it is doing, and the next `if (aiAborted) break` passes and the run carries on,
//      overwriting the names he cancelled to protect. It also un-did `reportCardGone()`, so one click
//      resumed analysis against a card that had been pulled out.
//
//   3. ⚠⚠ `copy:start`'s re-entrancy guard was REAL BUT CLAIMED TOO LATE. (The audit said there was
//      no guard at all — wrong; there is one, and this is the more interesting bug.) `copyTask` is
//      not assigned until ~70 lines after the check, and between them are FOUR awaits: two ensureDir,
//      one for the NAS root, and an `fsp.statfs` per destination. Two calls could both pass the
//      check, both grind through the preflight, and both reach the assignment — where the second
//      overwrites the first's task. Run A then reads B's abort flag, cancel cancels only B, both emit
//      on one channel, and whichever finishes first sets `copyTask = null` so the other throws
//      mid-copy and shows "Copy failed" over a partly-imported card.
//      No millisecond window needed: auto-mode fires a 800ms timer while the RENDERER's own latch is
//      still unset (it waits on its own free-space IPCs), so an impatient click at ~790ms gets both.
//
//   4. ⚠⚠ `finalize:run` had no guard, and `config.lastOrganize` is a SINGLE slot holding THE undo
//      record. Two runs both relocate footage and both stamp it; last write wins, so one run's clips
//      have no undo path — the same outcome the incremental-undo fix was written to prevent, reached
//      by another route. Reachable with no timing trick: `fileOneClipNow` calls the same handler with
//      no disable, and it is deliberately the low-friction "file this one, now" action.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

const read = (...p) => readFileSync(join(process.cwd(), ...p), 'utf8');
const strip = (s) => s.replace(/\/\/.*$/gm, '');
const tasks = strip(read('src', 'mod', '04-tasks-ai.js'));
const copy = strip(read('main-mod', '06-copy-transfer.js'));
const ipc = strip(read('main-mod', '09-ipc-boot.js'));

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

test('⚠⚠ the scroll-follow button cannot un-cancel a run', () => {
  const at = tasks.indexOf("aiFollowBtn.addEventListener('click'");
  assert.ok(at > -1, 'found the handler');
  const body = tasks.slice(at, tasks.indexOf('});', at));
  assert.match(body, /aiFollow = true; showFollowBtn\(false\);/, 'it only follows');
  assert.doesNotMatch(body, /aiAborted/,
    '⚠ touching the abort flag here resumes a run he cancelled, and un-does reportCardGone()');
});

test('cancelling is still what sets the abort flag', () => {
  // The bound: removing the assignment must not have removed the ability to cancel.
  assert.match(tasks, /aiAborted = true/, 'something still aborts a run');
});

test('⚠⚠ copy:start claims the slot SYNCHRONOUSLY, before any await', () => {
  const at = copy.indexOf("ipcMain.handle('copy:start'");
  assert.ok(at > -1, 'found the handler');
  const head = copy.slice(at, copy.indexOf('const { files, intakeFolder } = payload;', at));
  assert.match(head, /if \(\(copyTask && copyTask\.active\) \|\| copyStarting\) return/,
    'the check covers the in-flight preflight too');
  const claim = head.indexOf('copyStarting = true;');
  assert.ok(claim > -1, 'and the claim is taken');
  // The whole point: nothing may await between the check and the claim.
  const between = head.slice(head.indexOf('copyStarting) return'), claim);
  assert.doesNotMatch(between, /await/, '⚠ an await here re-opens the exact window this closes');
});

test('⚠ copy:start releases the claim on every exit', () => {
  // There are two early returns before the copy even begins ("cannot create intake folder", "not
  // enough room"). Leaking the claim on either would refuse all copying until the app restarts.
  assert.match(copy, /\} finally \{ copyStarting = false; \}/, 'released in a finally');
  const at = copy.indexOf("ipcMain.handle('copy:start'");
  const body = copy.slice(at, copy.indexOf('\n});', at));
  const earlyReturns = (body.match(/return \{ ok: false, error: `Cannot create intake folder|return \{ ok: false, error: `Not enough room/g) || []).length;
  assert.equal(earlyReturns, 2, `both preflight failures are inside the try — found ${earlyReturns}`);
});

test('⚠⚠ finalize:run refuses a second concurrent run', async () => {
  assert.match(ipc, /if \(finalizeRunning\) return \{ ok: false, error: 'A filing run is already going'/,
    '⚠ two runs both stamp the single undo slot, so one run loses its undo path entirely');
  assert.match(ipc, /\} finally \{ finalizeRunning = false; \}/, 'and it is released in a finally');
  // Functional: the guard must not be stuck on for a first, legitimate call.
  const r = app.plain(await app.invoke('finalize:run', { items: [], options: {}, dir: '' }));
  assert.notEqual(r && r.error, 'A filing run is already going',
    '⚠ a first call must not be refused — that would mean the flag leaked');
});

test('the refusal is reported in a shape the renderer already handles', () => {
  // finalize:run's caller reads summary.errors; a bare {ok:false} would show an empty failure.
  const at = ipc.indexOf('if (finalizeRunning) return');
  const line = ipc.slice(at, ipc.indexOf('\n', at));
  assert.match(line, /errors: \['A filing run is already going'\]/, 'errors[] is populated too');
});

test('⚠ every footage-moving handler now has a run guard', () => {
  // The sweep that would have caught all three at once. These four move or delete his files; each
  // must refuse a concurrent invocation.
  const guards = [
    [copy, /if \(\(copyTask && copyTask\.active\) \|\| copyStarting\)/, 'copy:start'],
    [ipc, /if \(finalizeRunning\)/, 'finalize:run'],
    [ipc, /if \(compressRunning\)/, 'compress:run'],
  ];
  for (const [src, re, name] of guards) assert.match(src, re, `${name} guards re-entry`);
});
