// A meta-test: every debounced write to his data must be flushed when the app goes away.
//
// The app HIDES to the tray when you close its window, so a pending debounce is not "about to run" —
// it is discarded. `wireDraftSafetyFlush` exists for exactly that reason, and it has been wrong twice
// by omission rather than by design:
//
//   • it flushed drafts and forgot FACE DECISIONS — 700 ms normally, **8 seconds during a scan**, on
//     a pile of 458 pending clusters (2026-07-20r);
//   • it forgot the SESSION state, so closing within 250 ms of changing screen made the next launch
//     reopen the screen he left BEFORE that — the opposite of what "resume where you left off"
//     promises.
//
// Both were single missing lines in a net that already existed. Nothing detected either, because a
// missing flush produces no error, no log and no failing test — just occasional lost work that looks
// like the app forgetting. So the rule is enforced here rather than remembered: **if a renderer
// module defers a write to his data behind a timer, the exit net must flush it.**
//
// Deliberately NOT enforced for cosmetic preferences (preview zoom width, phone thumbnail size).
// Losing the last 400 ms of a zoom slider costs nothing and he will re-drag it without noticing;
// making the rule absolute would only teach people to suppress it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MOD_DIR = join(process.cwd(), 'src', 'mod');
const files = readdirSync(MOD_DIR).filter((f) => f.endsWith('.js'));
const sources = new Map(files.map((f) => [f, readFileSync(join(MOD_DIR, f), 'utf8')]));
const all = [...sources.values()].join('\n');

// The exit net — the one place that runs when the window goes away.
const net = (() => {
  const core = sources.get('01-core.js');
  const i = core.indexOf('function wireDraftSafetyFlush');
  assert.ok(i > -1, 'found the exit safety net');
  return core.slice(i, core.indexOf('\n})();', i));
})();

// Writes that are DATA (his work), not cosmetics. Named explicitly so adding a new one is a
// deliberate act rather than an accident of pattern-matching.
const DATA_WRITES = [
  { api: 'saveDrafts', what: 'typed names', flush: 'flushDraftSave' },
  { api: 'savePendingFaces', what: 'face decisions', flush: 'flushPendingFacesSave' },
  { api: 'setPrefs({ session', what: 'where he was', flush: 'flushSessionSave' },
];

test('⚠ every deferred write of his WORK is flushed when the window goes away', () => {
  const missing = DATA_WRITES.filter((w) => !net.includes(`${w.flush}(`));
  assert.deepEqual(missing.map((m) => `${m.what} (${m.flush})`), [],
    'these are written behind a timer but not flushed on exit — a close inside the debounce loses them silently');
});

test('each flusher actually exists and writes immediately', () => {
  for (const w of DATA_WRITES) {
    const i = all.indexOf(`function ${w.flush}`);
    assert.ok(i > -1, `${w.flush} is defined`);
    const fn = all.slice(i, all.indexOf('\n}', i));
    assert.match(fn, /window\.api\.|save\w+Now\(/, `${w.flush} performs the write rather than re-scheduling it`);
    assert.doesNotMatch(fn, /setTimeout\(/, `${w.flush} does not re-debounce — that loses the race it exists to win`);
  }
});

test('⚠ a flusher that is a no-op would be caught', () => {
  // The rule is about behaviour, not about a function existing with the right name.
  for (const w of DATA_WRITES) {
    const i = all.indexOf(`function ${w.flush}`);
    const fn = all.slice(i, all.indexOf('\n}', i));
    assert.ok(fn.replace(/\/\/.*$/gm, '').trim().length > 40, `${w.flush} has a real body`);
  }
});

test('the net still covers every exit signal', () => {
  // Closing to tray, minimising, switching apps and quitting are four different events. A flush wired
  // to only one of them is a flush that mostly does not happen.
  for (const ev of ['beforeunload', 'pagehide', 'visibilitychange', 'blur']) {
    assert.ok(net.includes(ev), `${ev} is covered`);
  }
});

test('each flush is independently guarded so one failure cannot skip the rest', () => {
  const tries = net.match(/try \{/g) || [];
  assert.ok(tries.length >= DATA_WRITES.length,
    `each of the ${DATA_WRITES.length} flushes is wrapped — found ${tries.length} try blocks`);
});

test('the scan cannot pass vacuously — the net is really being read', () => {
  assert.ok(net.length > 200, `the sliced net has real content — ${net.length} chars`);
  assert.match(net, /addEventListener/, 'and it is the listener-wiring block');
});
