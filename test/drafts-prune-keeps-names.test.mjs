// The exemption that protects every name he has ever typed had no behavioural test.
//
// `writeDrafts` prunes on EVERY save — drop entries older than 60 days, then cap at 10000 — and both
// steps are gated by `draftIsNamed`, which appears in **zero** test files by name. The existing
// drafts-cap tests are structural: they check the constant is declared once and referenced in both
// places. Nothing exercised what actually gets evicted.
//
// The bug the exemption fixed is recorded in the code, and it is nasty precisely because it is
// invisible:
//
//   "a card named but left uncopied for two months lost those names — and because this prune runs on
//    EVERY writeDrafts call, editing one clip today deleted another clip's older name."
//
// So the failure is silent, delayed, and triggered by unrelated work. He would never connect "I
// renamed a clip on Tuesday" to "the names I typed in May are gone".
//
// On his real store: 4594 drafts, 206 with a typed subject. Drafts are the ONLY place a name lives
// until the footage is copied, so an evicted named draft is typing that has to be redone from
// scratch — and he has 354 typed field entries in his click log.
//
// Two rules, both tested here as behaviour rather than shape:
//   1. AGE — a named draft is never dropped for being old; a flag-only one is.
//   2. CAP — when over the cap, named drafts are kept in preference to flag-only ones.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const DAY = 24 * 3600 * 1000;
const old = () => Date.now() - 200 * DAY;      // well past the 60-day age filter
const recent = () => Date.now() - 1 * DAY;

beforeEach(() => {
  app.get('config').renameDrafts = {};
  app.get('storeReadFailed')['renameDrafts'] = false;
});

const save = (map) => app.invoke('drafts:save', map);
const stored = () => app.plain(app.get('config').renameDrafts) || {};

// `writeDrafts` stamps every INCOMING draft with `ts: now` (line 1019), so a draft cannot be old on
// the same call that saves it — entries age between saves. Reaching the age filter therefore means
// seeding the store directly and then triggering a prune with an unrelated save.
//
// That is not a workaround; it is precisely the reported scenario: *"because this prune runs on EVERY
// writeDrafts call, editing one clip today deleted another clip's older name."* My first version
// passed the old timestamps in through `save()` and they came back stamped to now, so the age filter
// never ran and the test failed for that reason rather than the one under test.
const seed = (map) => { app.get('config').renameDrafts = app.get('JSON').parse(JSON.stringify(map)); };
const touchOne = () => save({ 'unrelated.mp4__7__7': { subject: 'today', ts: Date.now() } });

test('⚠ an OLD draft with a typed subject survives the age filter', async () => {
  // Seeded old, then a normal edit elsewhere triggers the prune — the exact reported sequence.
  seed({ 'named.mp4__1__1': { subject: 'lawn-mowing', description: '', ts: old() } });
  await touchOne();
  assert.ok(stored()['named.mp4__1__1'], `his typed name survives — got ${JSON.stringify(stored())}`);
});

test('a typed DESCRIPTION or LOCATION counts as work too', async () => {
  // draftIsNamed checks subject OR description OR location. Testing only `subject` would leave two
  // thirds of the guard unexercised — and a description is the field he types most.
  seed({
    'desc.mp4__1__1': { subject: '', description: 'b-roll-corgi-puppies', ts: old() },
    'loc.mp4__2__2': { subject: '', description: '', location: 'bristol', ts: old() },
  });
  await touchOne();
  const s = stored();
  assert.ok(s['desc.mp4__1__1'], 'a typed description is work');
  assert.ok(s['loc.mp4__2__2'], 'so is a location');
});

test('an old FLAG-ONLY draft is still shed — the filter must not become a no-op', async () => {
  // The other direction. These carry no user work, and keeping them forever is what the age filter
  // is for; a guard that exempts everything is the same as no guard.
  seed({
    'flag.mp4__9__9': { subject: '', description: '', selected: true, ts: old() },
    'keep.mp4__1__1': { subject: 'vlog', ts: old() },
  });
  await touchOne();
  const s = stored();
  assert.equal(s['flag.mp4__9__9'], undefined, `the flag-only record is dropped — got ${JSON.stringify(s)}`);
  assert.ok(s['keep.mp4__1__1'], 'while the named one stays');
});

test('a RECENT flag-only draft is kept — it is still in play', async () => {
  seed({ 'fresh.mp4__3__3': { subject: '', selected: true, ts: recent() } });
  await touchOne();
  assert.ok(stored()['fresh.mp4__3__3'], 'recent work in progress is not swept');
});

test('⚠⚠ over the cap, named drafts are kept and flag-only ones give way', async () => {
  // The eviction rule. Build a store that exceeds DRAFTS_CAP with mostly flag-only records and a
  // handful of named ones, and prove the names survive the squeeze.
  const CAP = app.get('DRAFTS_CAP');
  const map = {};
  for (let i = 0; i < CAP + 500; i += 1) {
    map[`flag${i}.mp4__${i}__${i}`] = { subject: '', description: '', selected: true, ts: recent() };
  }
  const NAMED = ['liam', 'karis', 'josiah', 'mariah'];
  NAMED.forEach((n, i) => {
    map[`named${i}.mp4__${i}__${i}`] = { subject: n, description: 'a real typed name', ts: recent() };
  });
  await save(map);

  const s = stored();
  assert.ok(Object.keys(s).length <= CAP, `the cap is enforced — got ${Object.keys(s).length}`);
  for (let i = 0; i < NAMED.length; i += 1) {
    assert.ok(s[`named${i}.mp4__${i}__${i}`], `⚠ his typed name "${NAMED[i]}" survived the cap`);
  }
});

test('under the cap with no old entries, nothing is evicted at all', async () => {
  // Guard the everyday case: a normal save must not quietly lose anything.
  const map = {};
  for (let i = 0; i < 50; i += 1) map[`c${i}.mp4__${i}__${i}`] = { subject: `s${i}`, ts: recent() };
  await save(map);
  assert.equal(Object.keys(stored()).length, 50, 'all 50 kept');
});

test('a draft with no ts at all is not silently aged out if it is named', async () => {
  // A missing `ts` reads as 0, i.e. 1970 — older than any cutoff. Legacy entries and hand-edited
  // stores both look like this, and they are exactly the ones most likely to hold old typed work.
  seed({ 'legacy.mp4__1__1': { subject: 'old-project' } });
  await touchOne();
  assert.ok(stored()['legacy.mp4__1__1'], `a named draft with no timestamp is kept — got ${JSON.stringify(stored())}`);
});
