// ⚠⚠ "Send to Uncompressed" REPORTED SUCCESS FOR VIDEOS THAT NEVER MOVED.
//
// `phone:copyVideos` in main is explicit about what happened:
//
//     return { ok: failed === 0, copied: done, failed, total, okDests, cancelled, error }
//
// The renderer read none of it. It handled a THROW — that was fixed once already, and the comment
// above it says so — but a call that RESOLVES with `ok: false, failed: 3` took the success path:
// `phonePendingVideos = []`, hide the button, and a ✓ toast naming only `res.copied`.
//
// So three videos stay in `_Phone Video Temp`, nothing names them, he is told the send worked, and
// the only control that could retry is gone for the session. That is the same shape as the bug the
// comment on line 1071 says was fixed — fixed for the throw, missed for the failure report.
//
// ⚠ THE CONTROL TEST IS FIRST AND IS NOT OPTIONAL. Twice in this project a probe that exercised
// nothing was mistaken for a passing guard. So: prove the harness can drive a SUCCESSFUL send and
// observe the success behaviour, before believing anything about the failure case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSrc = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** Pull a real top-level function out of the shipping source and run it with injected deps. */
function extractFn(relFile, name, injected = []) {
  const src = readSrc(relFile);
  const start = src.indexOf(`async function ${name}(`) >= 0
    ? src.indexOf(`async function ${name}(`) : src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${relFile}`);
  let paren = 0; let bodyStart = -1;
  for (let i = src.indexOf('(', start); i < src.length; i += 1) {
    if (src[i] === '(') paren += 1;
    else if (src[i] === ')') { paren -= 1; if (paren === 0) { bodyStart = src.indexOf('{', i); break; } }
  }
  let depth = 0; let end = -1;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  // eslint-disable-next-line no-new-func
  return new Function(...injected, `${src.slice(start, end)}; return ${name};`);
}

// Build the real `sendPendingVideosToUncompressed` around a controllable world.
function build(result, { thrown = null } = {}) {
  const toasts = [];
  const issues = [];
  const jobs = [
    { src: '/tmp/p/a.mp4', dest: '/intake/a.mp4' },
    { src: '/tmp/p/b.mp4', dest: '/intake/b.mp4' },
    { src: '/tmp/p/c.mp4', dest: '/intake/c.mp4' },
  ];
  const btn = { disabled: false, textContent: 'Send to Uncompressed', _classes: new Set(),
    classList: { add(c) { btn._classes.add(c); }, remove(c) { btn._classes.delete(c); } } };
  const world = {
    phonePendingVideos: jobs.slice(),
    document: { getElementById: () => btn },
    showToast: (m) => toasts.push(String(m)),
    logIssue: (a, b) => issues.push(`${a}: ${b}`),
    setTask: () => {}, clearTask: () => {},
    window: { api: {
      copyPhoneVideos: async () => { if (thrown) throw new Error(thrown); return result; },
      onPhoneCopyProgress: () => () => {},
    } },
  };
  const fn = extractFn('src/mod/09-phone-finalize.js', 'sendPendingVideosToUncompressed', [
    'phonePendingVideos', 'document', 'showToast', 'logIssue', 'setTask', 'clearTask', 'window',
  ]);
  // `phonePendingVideos` is reassigned inside, so the run reports its own final value back.
  const run = async () => {
    const bound = fn(world.phonePendingVideos, world.document, world.showToast, world.logIssue,
      world.setTask, world.clearTask, world.window);
    await bound();
    return { toasts, issues, btn };
  };
  return { run, world, toasts, issues, btn };
}

test('⚠ CONTROL — a send that fully succeeds reports success and hides the button', async () => {
  // Without this, a "failure was reported" assertion could pass because the harness never ran.
  const { run } = build({ ok: true, copied: 3, failed: 0, total: 3, okDests: ['/intake/a.mp4'] });
  const { toasts, btn } = await run();
  assert.ok(toasts.some((t) => /3 videos/.test(t)), `⚠ the success toast fires — got ${JSON.stringify(toasts)}`);
  assert.ok(toasts.some((t) => /✓/.test(t)), 'with a tick');
  assert.ok(btn._classes.has('hidden'), 'and the button is put away when there is nothing left to send');
});

test('⚠⚠⚠ a PARTIAL failure is reported, not ticked', async () => {
  // Main said 2 copied, 3 failed. The old code said "2 videos → Uncompressed ✓".
  const { run } = build({ ok: false, copied: 2, failed: 3, total: 5, error: '3 video(s) failed to move', okDests: [] });
  const { toasts } = await run();
  const all = toasts.join(' | ');
  assert.ok(!/✓/.test(all), `⚠⚠⚠ no success tick when videos failed — got ${all}`);
  assert.match(all, /3/, '⚠⚠ the number that failed is stated');
  assert.match(all, /still|again|pending/i, '⚠⚠ and he is told they can be retried');
});

test('⚠⚠⚠ the retry route is NOT taken away when videos failed', async () => {
  // The compounding harm: the failed videos are stranded AND the only control that could move them
  // is hidden for the session.
  const { run } = build({ ok: false, copied: 2, failed: 3, total: 5, error: '3 video(s) failed to move' });
  const { btn } = await run();
  assert.ok(!btn._classes.has('hidden'), '⚠⚠⚠ the Send button stays available');
  assert.equal(btn.disabled, false, 'and usable');
});

test('⚠⚠ a failure is written to the issue log, so it survives the toast', async () => {
  const { run } = build({ ok: false, copied: 0, failed: 3, total: 3, error: '3 video(s) failed to move' });
  const { issues } = await run();
  assert.ok(issues.some((i) => /Phone/.test(i)), `⚠⚠ logged for later — got ${JSON.stringify(issues)}`);
});

test('⚠ a CANCELLED send is reported as cancelled, not as failure or success', async () => {
  // He stopped it on purpose. Calling that an error trains him to ignore errors.
  const { run } = build({ ok: false, copied: 1, failed: 0, total: 3, cancelled: true });
  const { toasts } = await run();
  assert.match(toasts.join(' | '), /stopp|cancel/i, '⚠ says it was stopped');
});

test('⚠ a thrown call still behaves as it did — that fix must not regress', async () => {
  const { run } = build(null, { thrown: 'device went away' });
  const { toasts, btn } = await run();
  assert.match(toasts.join(' | '), /Couldn’t send to Uncompressed/, 'the throw path still reports');
  assert.ok(!btn._classes.has('hidden'), 'and still leaves the button');
});

// --- AND THE OTHER HALF: "named & staged" counted videos that were never renamed -----------------
//
// `phonePendingVideos` is built from ALL the videos BEFORE the rename runs, with `src` already
// pointing at the FINAL name. A clip whose rename failed stayed in that list, was counted in
// "N videos named & staged in _Phone Video Temp", and had a `src` pointing at a file that does not
// exist — so the next Send failed on it for a reason that looked like a mystery.
//
// `okDests` is main's list of destinations that really exist after the rename, and the rename jobs'
// `dest` values are the same strings as the pending list's `src`, so this is an exact match rather
// than a heuristic.

const stagedAfterRename = extractFn('src/mod/09-phone-finalize.js', 'stagedAfterRename', [])();

const pending = () => ([
  { src: '/tmp/vtemp/2026-06-01_a_v1.mp4', dest: '/intake/2026-06-01_a_v1.mp4' },
  { src: '/tmp/vtemp/2026-06-01_b_v1.mp4', dest: '/intake/2026-06-01_b_v1.mp4' },
  { src: '/tmp/vtemp/2026-06-01_c_v1.mp4', dest: '/intake/2026-06-01_c_v1.mp4' },
]);

test('⚠ CONTROL — when every rename works, everything stays staged', () => {
  const all = pending().map((j) => j.src);
  const r = stagedAfterRename(pending(), all);
  assert.equal(r.staged.length, 3, '⚠ all three remain');
  assert.equal(r.failed, 0, 'and nothing is reported failed');
});

test('⚠⚠⚠ a video whose rename failed is NOT counted as named & staged', () => {
  const okDests = [pending()[0].src, pending()[2].src];   // the middle one failed
  const r = stagedAfterRename(pending(), okDests);
  assert.equal(r.staged.length, 2, '⚠⚠⚠ only the renamed ones are staged');
  assert.equal(r.failed, 1, '⚠⚠ and the failure is counted so it can be reported');
  assert.ok(!r.staged.some((j) => /_b_/.test(j.src)),
    '⚠⚠⚠ the clip still under its original name is not in the send list');
});

test('⚠⚠ every rename failing leaves nothing staged, and says so', () => {
  const r = stagedAfterRename(pending(), []);
  assert.equal(r.staged.length, 0);
  assert.equal(r.failed, 3, '⚠⚠ all three reported, rather than a silent empty list');
});

test('⚠⚠ NO report at all changes nothing — it must not empty his staged list', () => {
  // An older main, or a call that threw before reporting. Treating "I do not know" as "none
  // succeeded" would wipe a list of videos that are perfectly fine on disk.
  for (const noReport of [undefined, null, 'nonsense', 0]) {
    const r = stagedAfterRename(pending(), noReport);
    assert.equal(r.staged.length, 3, `⚠⚠ unchanged when okDests is ${JSON.stringify(noReport)}`);
    assert.equal(r.failed, 0, 'and nothing is claimed to have failed');
  }
});

test('⚠ the done line warns about videos that could not be renamed', () => {
  const src = readSrc('src/mod/09-phone-finalize.js').replace(/\/\/.*$/gm, '');
  assert.match(src, /couldn’t be renamed/, '⚠ the warning text exists');
  assert.match(src, /const vidWarn = vidFailed/, 'driven by the real count');
  assert.match(src, /\(nVid \|\| vidFailed\)/,
    '⚠⚠ and the line still appears when NOTHING staged but something failed — otherwise a total failure is silent');
});
