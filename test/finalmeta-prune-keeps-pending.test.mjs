// The guard that stops the AI's work being deleted before he uses it. `HARD_CAP`: zero tests.
//
// `finalMeta` is the ONLY carrier of everything the AI worked out — subject, description, people,
// observation, the route that decides where a clip files — across the gap between "copy to intake"
// and "organize the compressed output". That gap is deliberately LONG: the whole workflow is to let
// Tdarr compress and come back later.
//
// The old prune dropped entries at 180 days and capped to the 5000 most recent, unconditionally. The
// code records what that cost:
//
//   "come back to a shoot seven months later, or after 5000 newer clips, and everything the AI
//    concluded was gone, with no warning. That is precisely the 'it forgets to remember things'
//    complaint."
//
// **This is not hypothetical — it already happened to him.** Measured on his real store (2026-07-19cd):
// `final-meta.json` holds **1 entry** against 310 compressed clips and 4594 drafts. The old prune ate
// the rest before the exemption existed. Everything the AI had concluded about his archive is gone,
// and the only reason his backlog is still fileable is the filename fallback.
//
// So the rule now: an entry is evictable ONLY once `finalize:run` has actually FILED that clip
// (`done: true`). Pending work is kept regardless of age, and the hard cap sheds FILED entries first
// — it will not throw away unconsumed work to stay under a limit.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const DAY = 24 * 3600 * 1000;
const ancient = () => Date.now() - 400 * DAY;   // well past the 180-day cutoff
const recent = () => Date.now() - 1 * DAY;

beforeEach(() => {
  app.get('config').finalMeta = {};
  app.get('storeReadFailed')['finalMeta'] = false;
});

// `finalMeta:save` stamps every incoming record `ts: now`, so a record cannot be old on the call
// that writes it — the same trap as the drafts prune (2026-07-20i). Seed the store directly, then
// trigger the prune with an unrelated save. That IS the real sequence: the prune runs on every save,
// so ordinary work today is what sweeps the entries he wrote months ago.
const seed = (map) => { app.get('config').finalMeta = app.get('JSON').parse(JSON.stringify(map)); };
const touchOne = () => app.invoke('finalMeta:save', { 'today.mp4': { subject: 'vlog' } });
const stored = () => app.plain(app.get('config').finalMeta) || {};

test('⚠⚠ an ANCIENT but unfiled record survives — this is the bug that emptied his store', async () => {
  // Copied in January, still not organized in July. Under the old prune this vanished.
  seed({ 'january-shoot.mp4': { subject: 'lawn-mowing', description: 'dennis', people: ['Liam'], done: false, ts: ancient() } });
  await touchOne();
  const s = stored();
  assert.ok(s['january-shoot.mp4'], `unconsumed AI work is kept — got ${JSON.stringify(Object.keys(s))}`);
  assert.equal(s['january-shoot.mp4'].description, 'dennis', 'and it is intact, not a stub');
});

test('a record with no `done` flag at all counts as pending', async () => {
  // Legacy entries predate the flag. Reading a missing `done` as "filed" would evict exactly the
  // oldest work — the entries most likely to be gone already.
  seed({ 'legacy.mp4': { subject: 'vlog', ts: ancient() } });
  await touchOne();
  assert.ok(stored()['legacy.mp4'], `no flag means not filed — got ${JSON.stringify(stored())}`);
});

test('an ancient FILED record IS shed — the exemption must not become a no-op', async () => {
  // The other direction. Once a clip is organized its metadata is embedded in the file itself, so
  // the store copy is redundant; keeping every one forever is what the age filter is for.
  seed({
    'filed.mp4': { subject: 'vlog', done: true, ts: ancient() },
    'pending.mp4': { subject: 'vlog', done: false, ts: ancient() },
  });
  await touchOne();
  const s = stored();
  assert.equal(s['filed.mp4'], undefined, `the filed one is shed — got ${JSON.stringify(Object.keys(s))}`);
  assert.ok(s['pending.mp4'], 'the pending one is kept');
});

test('a RECENT filed record is still kept', async () => {
  // Age is the trigger, not the flag. A clip filed yesterday may still be re-filed after a rename.
  seed({ 'just-filed.mp4': { subject: 'vlog', done: true, ts: recent() } });
  await touchOne();
  assert.ok(stored()['just-filed.mp4'], 'recently filed work stays');
});

test('⚠ over the HARD CAP, FILED entries go first and pending work survives', async () => {
  // The cap is a runaway backstop, not a reason to discard unconsumed work. Build a store past the
  // cap out of filed entries plus a handful of pending ones.
  const CAP = 50000;
  const map = {};
  const PENDING = ['a', 'b', 'c'];
  // Pending work gets the OLDEST timestamps, so a plain most-recent-first sort would evict it. Only
  // the done-first rule can save it. My first version stamped everything with `recent()` — which
  // calls Date.now() per entry, so the last-seeded (pending) records came out NEWEST and survived on
  // timestamp alone. Deleting the done-first sort left the test green.
  PENDING.forEach((n) => { map[`pending-${n}.mp4`] = { subject: 'lawn-mowing', description: 'real work', done: false, ts: Date.now() - 90 * DAY }; });
  for (let i = 0; i < CAP + 200; i += 1) map[`filed${i}.mp4`] = { subject: 'vlog', done: true, ts: recent() };
  seed(map);
  await touchOne();

  const s = stored();
  assert.ok(Object.keys(s).length <= CAP, `the cap is enforced — got ${Object.keys(s).length}`);
  for (const n of PENDING) {
    assert.ok(s[`pending-${n}.mp4`], `⚠ pending work "${n}" survived the cap`);
  }
});

test('under the cap with nothing ancient, nothing is evicted', async () => {
  // The everyday save must not quietly lose anything.
  const map = {};
  for (let i = 0; i < 40; i += 1) map[`c${i}.mp4`] = { subject: `s${i}`, done: i % 2 === 0, ts: recent() };
  seed(map);
  await touchOne();
  assert.equal(Object.keys(stored()).length, 41, 'all 40 kept, plus the one just saved');
});

test('markFinalMetaDone is what makes a record evictable', async () => {
  // The two halves have to line up: filing a clip is the ONLY thing that should make its metadata
  // disposable. If this stopped setting the flag, the store would grow forever; if it set it early,
  // the prune would eat work he had not used yet.
  seed({ 'clip.mp4': { subject: 'vlog', done: false, ts: ancient() } });
  app.get('markFinalMetaDone')(['clip.mp4']);
  assert.equal(stored()['clip.mp4'].done, true, 'filing marks it done');
  await touchOne();
  assert.equal(stored()['clip.mp4'], undefined, 'and only then does the prune take it');
});
