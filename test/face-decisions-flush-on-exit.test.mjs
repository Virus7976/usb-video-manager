// The app-exit safety net saved drafts and forgot faces.
//
// Face decisions are debounced — 700 ms normally, 8 SECONDS during a scan — and `wireDraftSafetyFlush`
// in 01-core flushes on `beforeunload`, `pagehide`, `visibilitychange`→hidden and `blur`. Its own
// comment explains why that net exists: *"the app HIDES to the tray when you close its window, so a
// debounced save could still be pending."*
//
// It only ever called `flushDraftSave()`. A "✓ Yes" given in the last moment before he closes the
// window was simply dropped — and during a scan the exposure is **eight seconds** of decisions.
//
// This lands on the biggest pile of unfinished work in the app: **458 pending face clusters**, with
// **226 "✓ Yes" and 41 "✗ No" confirmations** already in his click log. Face review is also the one
// feature he singled out as good ("I love the popup for when it asks me who is who in faces"), and
// the governing principle for it is that walking away must never cost him anything — because he
// always walks away.
//
// Losing the last decision of every session is precisely the "it forgets to remember things"
// complaint, in the place it stings most.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const strip = (s) => s.replace(/\/\/.*$/gm, '');
const core = strip(readFileSync(join(process.cwd(), 'src', 'mod', '01-core.js'), 'utf8'));
const people = strip(readFileSync(join(process.cwd(), 'src', 'mod', '08-people.js'), 'utf8'));

const netStart = core.indexOf('function wireDraftSafetyFlush');
const net = (() => {
  assert.ok(netStart > -1, 'found the safety net');
  return core.slice(netStart, core.indexOf('\n})();', netStart));
})();

test('⚠ the exit flush now saves face decisions, not just drafts', () => {
  assert.match(net, /flushDraftSave\(\)/, 'drafts still flush');
  assert.match(net, /flushPendingFacesSave\(\)/, 'and so do pending face decisions');
});

test('it is wired to every exit signal the net already covered', () => {
  // The net exists because closing the window HIDES to tray rather than quitting. Half-covering the
  // signals would leave the same hole on a different exit route.
  for (const ev of ['beforeunload', 'pagehide', 'visibilitychange', 'blur']) {
    assert.ok(net.includes(ev), `${ev} triggers the flush`);
  }
});

test('⚠ neither flush can throw on the way out', () => {
  // An exception in an unload handler can abort the rest of it — so a face-save failure must not
  // take the draft save with it, and vice versa. They are separately guarded.
  const guards = net.match(/try \{/g) || [];
  assert.ok(guards.length >= 2, `each flush is independently wrapped — found ${guards.length} try blocks`);
});

test('the flusher exists and writes SYNCHRONOUSLY, not on another timer', () => {
  const fn = people.slice(people.indexOf('function flushPendingFacesSave'), people.indexOf('\n}', people.indexOf('function flushPendingFacesSave')));
  assert.ok(fn.length > 20, 'found flushPendingFacesSave');
  assert.match(fn, /savePendingNow\(/, 'it writes now — re-scheduling would lose the race it exists to win');
  assert.doesNotMatch(fn, /schedulePendingSave/, 'and never re-debounces');
});

test('⚠ it only writes when a save is genuinely outstanding', () => {
  // On every blur, with no review open, this must do nothing. Serializing hundreds of clusters on
  // each window blur is real main-thread work — the same cost that made an earlier version of this
  // store slow enough to complain about.
  const fn = people.slice(people.indexOf('function flushPendingFacesSave'), people.indexOf('\n}', people.indexOf('function flushPendingFacesSave')));
  assert.match(fn, /if \(!_pendingInFlight\) return;/, 'nothing pending → nothing written');
});

test('the outstanding-work marker is set when a save is debounced', () => {
  const fn = people.slice(people.indexOf('function schedulePendingSave'), people.indexOf('\n}', people.indexOf('function schedulePendingSave')));
  assert.ok(fn.length > 20, 'found schedulePendingSave');
  assert.match(fn, /_pendingInFlight = clusters;/, 'the debounced clusters are remembered');
});

test('⚠ and CLEARED once written, so an exit cannot double-write stale clusters', () => {
  // savePendingNow REPLACES the whole store. Flushing a stale snapshot after a newer synchronous save
  // would resurrect decisions he had already undone.
  const fn = people.slice(people.indexOf('function savePendingNow'), people.indexOf('\n}', people.indexOf('function savePendingNow')));
  assert.ok(fn.length > 20, 'found savePendingNow');
  assert.match(fn, /_pendingInFlight = null;/, 'the marker is cleared on a synchronous write');
});

test('a failed pending LOAD still blocks the write', () => {
  // The existing latch: if the store could not be read this launch, writing it would destroy the face
  // DB. The new exit path must not become a way around that.
  const fn = people.slice(people.indexOf('function savePendingNow'), people.indexOf('\n}', people.indexOf('function savePendingNow')));
  assert.match(fn, /if \(_pendingLoadFailed\) return Promise\.resolve\(\);/, 'unchanged');
});
