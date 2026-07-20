// Error-path audit findings 6-9 (2026-07-20). The theme: things that went wrong and were not counted,
// not reported, or not cleaned up.
//
//   7. ⚠⚠ `phone:pull` returned a LITERAL `ok: true` no matter how much it dropped, and `incomplete`
//      — the only number the UI reads — counts ONLY truncated pulls, i.e. a file that arrived SHORT
//      of its known size. A file the device declined outright, or one that could not be stat'd, fell
//      into a bare `catch` and incremented nothing. So a pull that got 40 of 60 photos reported a
//      clean transfer and said nothing.
//
//      ⚠ CORRECTION TO THE AUDIT: it claimed "the phone-clear step downstream reads that as clean".
//      There is no phone-clear step — nothing in this app deletes from a phone (`clearPhoneBackupFolder`
//      only clears a config SETTING). So this is a false "all done", not lost footage. Still worth
//      fixing: it is the message he would act on when deciding whether to clear the phone by hand.
//
//   6. `finalize:run` assigned `sidecar` BEFORE writing it, so on the failure path it stayed truthy
//      and step 2 tried to move a file that was never created — turning one failure into two errors,
//      one of them describing a nonexistent file.
//
//   8. The `phonevid_<ts>` staging dir was never removed. One per pull, each holding full-size video
//      for every clip whose move failed, in %TEMP% forever. Its sibling in `phone:distribute` IS
//      cleaned — the usual one-path-fixed-its-twin-missed.
//
//   9. `compress:run` had no re-entrancy guard while `copy:start` does. Two concurrent runs share
//      `compressProc`/`compressAborted`, and the handler ends with an unconditional
//      `rm(join(out, '.partial'))` — so run A's sweep would delete run B's in-flight staged encode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

const read = (...p) => readFileSync(join(process.cwd(), ...p), 'utf8');
const phone = read('main-mod', '05-windows-phone.js').replace(/\/\/.*$/gm, '');
const ipc = read('main-mod', '09-ipc-boot.js').replace(/\/\/.*$/gm, '');
const fin = read('src', 'mod', '09-phone-finalize.js').replace(/\/\/.*$/gm, '');

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

test('⚠⚠ every way a pull can drop a file is counted', () => {
  // Three ways it can go wrong, and only ONE of them used to increment anything.
  assert.match(phone, /let missed = 0;/, 'there is a counter for the untracked cases');
  const bare = phone.match(/\} catch \{ \/\* skip \*\/ \}|\} catch \{ \/\* couldn't verify — skip \*\/ \}/g) || [];
  assert.deepEqual(bare, [], `⚠ a silent skip means a dropped file nobody counts — found ${bare.length}`);
  const counted = (phone.match(/catch \{ missed \+= 1; \}/g) || []).length;
  assert.equal(counted, 2, `both the sim and the real skip paths count — found ${counted}`);
});

test('⚠⚠ phone:pull no longer claims success as a literal', () => {
  const at = phone.indexOf('const shortfall = incomplete + missed;');
  assert.ok(at > -1, 'the shortfall is computed');
  const body = phone.slice(at, phone.indexOf('\n});', at));
  assert.match(body, /ok: shortfall === 0 \|\| staged\.length > 0/, 'ok reflects what happened');
  assert.match(body, /complete: shortfall === 0/, 'and "complete" is distinguishable from "partial"');
  assert.doesNotMatch(body, /return \{ ok: true, copied/, 'the literal is gone');
});

test('⚠ the UI reads the FULL shortfall, not just the truncated ones', () => {
  // Fixing main without this leaves the fix invisible: the renderer would still read `incomplete`.
  assert.match(fin, /const missed = \(typeof res\.shortfall === 'number'\) \? res\.shortfall : \(res\.incomplete \|\| 0\);/,
    '⚠ it uses shortfall, falling back to incomplete for an older main');
  assert.match(fin, /didn’t transfer off the phone/, 'and still tells him to pull again');
});

test('⚠ the sidecar path is only recorded once the file exists', () => {
  const at = ipc.indexOf('const sidePath = `${curPath}.xmp`;');
  assert.ok(at > -1, 'the write target is a local first');
  const body = ipc.slice(at, at + 260);
  const writeAt = body.indexOf("await et.write(sidePath");
  const assignAt = body.indexOf('sidecar = sidePath;');
  assert.ok(writeAt > -1 && assignAt > writeAt,
    '⚠ assign AFTER the write — assigning first made a failed write look like a movable file');
  assert.doesNotMatch(ipc, /sidecar = `\$\{curPath\}\.xmp`;\s*\n\s*await et\.write/,
    'the premature assignment is gone');
});

test('⚠ the phone video staging dir is cleaned up', () => {
  const at = phone.indexOf('const tmp = path.join(app.getPath(\'temp\'), `phonevid_');
  assert.ok(at > -1, 'found the staging dir');
  const body = phone.slice(at, phone.indexOf('\n  }', at));
  assert.match(body, /fsp\.rm\(tmp, \{ recursive: true, force: true \}\)/,
    '⚠ one per pull, holding full-size video, was accumulating in %TEMP% forever');
});

test('the cleanup can never fail a transfer that already succeeded', () => {
  // It runs after the footage has moved, so a locked temp file must not turn a good run into a bad
  // one — and `force` means an already-empty or already-gone dir is not an error.
  const at = phone.indexOf('const tmp = path.join(app.getPath(\'temp\'), `phonevid_');
  const body = phone.slice(at, phone.indexOf('\n  }', at));
  assert.match(body, /try \{ await fsp\.rm\(tmp[^;]*; \} catch \{[^}]*\}/, 'best-effort');
  assert.match(body, /force: true/, 'and tolerant of an empty or missing dir');
});

test('⚠ compress:run cannot run twice at once', async () => {
  // It shares compressProc/compressAborted globals and ends with an unconditional rm of the .partial
  // staging dir, so a second concurrent run would have its in-flight encode deleted by the first.
  assert.match(ipc, /let compressRunning = false;/, 'there is a guard flag');
  assert.match(ipc, /if \(compressRunning\) return \{ ok: false, error: 'A compression run is already going' \};/,
    '⚠ the second call is refused, as copy:start already does');
  assert.match(ipc, /\} finally \{ compressRunning = false; \}/,
    'and released in a finally — leaking it would disable compression until restart');
  // Functional: the guard must not fire on a first, legitimate call.
  const r = app.plain(await app.invoke('compress:run', { files: [] }));
  assert.equal(r.ok, false, 'an empty list is still rejected on its own merits');
  assert.notEqual(r.error, 'A compression run is already going', '⚠ and NOT because the guard is stuck on');
});

test('the guard is claimed only after the validation early-returns', () => {
  // Claiming it first would mean a rejected call (no files, no output folder) left the slot taken
  // and disabled compression for the session.
  const at = ipc.indexOf("ipcMain.handle('compress:run'");
  const body = ipc.slice(at, ipc.indexOf('const results = [];', at));
  const guardSet = body.indexOf('compressRunning = true;');
  const lastEarlyReturn = body.lastIndexOf('return { ok: false');
  assert.ok(guardSet > -1 && lastEarlyReturn > -1 && guardSet > lastEarlyReturn,
    '⚠ the flag is set after every early return, or a rejected call wedges compression off');
});
