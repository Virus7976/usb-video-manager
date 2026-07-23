// ⚠⚠⚠ A MENU ITEM ADVERTISED AS "READS ONLY" DESTROYED THE PROJECT MEMORY IT CLAIMED TO BUILD.
//
// The project ledger has two writers, and they disagreed about every single field.
//
//   field      | recordLedgerEntries (03-ai-ollama.js:113-137)  | backfillLedgerFromTree (10:729-732)
//   -----------|-----------------------------------------------|-------------------------------------
//   subjects   | ledgerMerge(…, 200)  → slice(-200), newest     | slice(0, 24)   → keeps the OLDEST
//   dates      | ledgerMerge(…, 400)  → slice(-400)             | .sort().slice(-24)
//   samples    | array of OBJECTS, slice(-60)                   | merged filename STRINGS, slice(0, 8)
//
// So a project the app had really filed into — the ones that know the most — lost the most:
//
//     BEFORE  subjects: 40 dates: 60 samples: 60 sample[0] type: object
//     AFTER   subjects: 24 dates: 24 samples: 8
//     LOST    subjects: 16 dates: 36 samples: 52
//
// This is PROMPT.md §5 item 4 exactly — "when you find a cap on a store, grep for a second one on the
// same store before trusting either" — and it is the same shape as the `renameDrafts` bug that had
// two caps with opposite rules and silently deleted hand-typed names on every launch.
//
// ⚠ WHY IT MATTERED MORE ON 2026-07-22 THAN THE DAY IT WAS WRITTEN. Two things landed that day:
// the ledger became a source for the SUBJECT VOCABULARY (`subjectVocabulary` reads `rec.subjects`),
// and the backfill got a permanent menu route — Edit → Filing & destinations → "Read my Projects
// folder…", whose own description reads *"Reads only; nothing is moved or renamed."* True of his
// TREE, false of his ledger. The feature built to learn his vocabulary was eating it.
//
// The three casualties, in order of what they cost him:
//   · `dates` 400 → 24 kills SAME-SHOOT RECALL — `ledger:matchDates` is the app's strongest placement
//     signal, because he shoots in batches and the date predicts the subject ~88% of the time. A
//     re-import from any shoot older than the 24 most recent days matched no project at all.
//   · `samples` 60 → 8, type-corrupted, is the ONLY input to `ledger:summarize`. Filenames have no
//     `.subject`, so the summary prompt emitted blank numbered lines.
//   · `subjects` 200 → 24 keeping the OLDEST means a project already holding 24 subjects can never
//     learn another from disk.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let root;

before(() => {
  app = loadMain();
  root = mkdtempSync(join(tmpdir(), 'uvd-ledger-'));
  const dir = join(root, '2026', 'dennis-lawn');
  mkdirSync(dir, { recursive: true });
  // App-named clips, so `parseNamedClip` yields real subjects and dates rather than nothing.
  for (const f of ['2026-06-01_hedge-trimming_back-fence_v1.mp4', '2026-06-02_leaf-blowing_drive_v1.mp4']) {
    writeFileSync(join(dir, f), '');
  }
});
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

// A record shaped exactly as `recordLedgerEntries` leaves one after real use — this is the state the
// backfill has to enrich without damaging.
const seedRichRecord = () => {
  const cfg = app.get('config');
  cfg.projectsRoot = root;
  cfg.projectLedger = [{
    id: 'p1', rel: '2026/dennis-lawn', name: 'dennis-lawn', category: '2026',
    clips: 60, clipNames: [],
    subjects: Array.from({ length: 40 }, (_, i) => `subject-${i}`),
    dates: Array.from({ length: 60 }, (_, i) => `2025-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`),
    locations: [], people: [],
    samples: Array.from({ length: 60 }, (_, i) => ({
      subject: `s${i}`, description: `d${i}`, observation: `obs${i}`, people: [], date: '2025-05-01',
    })),
    summary: '', summaryClips: 0,
  }];
  return cfg.projectLedger[0];
};
const recNow = () => app.get('config').projectLedger.find((p) => p.rel === '2026/dennis-lawn');

beforeEach(() => { seedRichRecord(); });

test('⚠⚠⚠ backfilling does not throw away what the app already knew', async () => {
  // The headline. Nothing the ledger held may shrink — it is called "ENRICH, never clobber" in its
  // own comment, and it clobbered.
  const before0 = seedRichRecord();
  const n = { subjects: before0.subjects.length, dates: before0.dates.length, samples: before0.samples.length };

  const r = app.plain(await app.invoke('ai:backfillLedger', root));
  assert.equal(r.ok, true);

  const after = recNow();
  assert.ok(after.subjects.length >= n.subjects, `⚠ subjects shrank ${n.subjects} → ${after.subjects.length}`);
  assert.ok(after.dates.length >= n.dates, `⚠⚠ dates shrank ${n.dates} → ${after.dates.length} — this is same-shoot recall`);
  assert.ok(after.samples.length >= n.samples, `⚠⚠ samples shrank ${n.samples} → ${after.samples.length} — this is the summary input`);
});

test('⚠⚠ samples stay a list of OBJECTS — never filenames', async () => {
  // `ledger:summarize` reads `s.subject` / `s.description` / `s.observation` off each sample. A
  // string has none of them, so every merged filename became a blank numbered line in the prompt.
  //
  // ⚠ SEEDED WITH A SMALL SAMPLES ARRAY ON PURPOSE. Against the 60-sample record this assertion
  // passed VACUOUSLY: `slice(0, 8)` took the first eight — all objects — and cut the appended
  // filename strings off the end. The corruption only surfaces on a project with fewer than 8
  // samples, which is every project he has filed only a handful of clips into. Verified by
  // reverting the fix and watching this exact test fail.
  const cfg = app.get('config');
  cfg.projectsRoot = root;
  cfg.projectLedger = [{
    id: 'p2', rel: '2026/dennis-lawn', name: 'dennis-lawn', category: '2026',
    clips: 2, clipNames: [], subjects: ['lawn-mowing'], dates: ['2025-05-01'],
    locations: [], people: [],
    samples: [{ subject: 'lawn-mowing', description: 'front lawn', observation: 'a man mowing', people: [], date: '2025-05-01' }],
    summary: '', summaryClips: 0,
  }];
  await app.invoke('ai:backfillLedger', root);
  const types = [...new Set(recNow().samples.map((s) => typeof s))];
  assert.deepEqual(types, ['object'], `⚠⚠ samples must stay objects — found ${types.join(', ')}`);
  assert.ok(recNow().samples.every((s) => s && typeof s.subject === 'string'),
    '⚠ and every sample must carry the fields the summary prompt reads');
});

test('⚠⚠ the OLD dates survive, so a re-import from an old shoot still finds its project', async () => {
  // The measured consequence. `ledger:matchDates` scores an incoming shoot against `rec.dates`; the
  // old code kept only the 24 most recent, so anything older matched nothing and placement fell back
  // to guessing from bare folder names.
  const before0 = seedRichRecord();
  const oldest = [...before0.dates].sort()[0];
  await app.invoke('ai:backfillLedger', root);

  assert.ok(recNow().dates.includes(oldest),
    `⚠⚠ the oldest date ${oldest} was dropped — every shoot before it stops matching`);

  const m = app.plain(await app.invoke('ledger:matchDates', { dates: [oldest] }));
  const hits = Array.isArray(m) ? m : (m.matches || m.results || []);
  assert.ok(hits.length > 0, '⚠⚠ and the round trip must still find the project — this is the real test');
});

test('⚠ a project already holding many subjects can still learn a new one from disk', async () => {
  // `slice(0, 24)` kept the OLDEST 24, so a busy project was permanently full and the folder's own
  // subjects could never get in — defeating the very feature the backfill now feeds.
  seedRichRecord();
  await app.invoke('ai:backfillLedger', root);
  const subs = recNow().subjects;
  assert.ok(subs.includes('hedge-trimming') && subs.includes('leaf-blowing'),
    `⚠ the folder's own subjects must be learned — got ${subs.length} entries`);
});

test('⚠⚠ the two writers agree on the caps — a re-run cannot exceed them either', async () => {
  // Caps still exist; the bug was that they disagreed. Running the backfill many times must not grow
  // the record without bound, which is the opposite failure and just as real.
  seedRichRecord();
  for (let i = 0; i < 5; i += 1) await app.invoke('ai:backfillLedger', root);   // eslint-disable-line no-await-in-loop
  const a = recNow();
  assert.ok(a.subjects.length <= 200, `⚠ subjects cap is 200, got ${a.subjects.length}`);
  assert.ok(a.dates.length <= 400, `⚠ dates cap is 400, got ${a.dates.length}`);
  assert.ok(a.samples.length <= 60, `⚠ samples cap is 60, got ${a.samples.length}`);
});

test('⚠⚠ repeated runs do not re-append the same samples until the real ones are evicted', async () => {
  // `recordLedgerEntries` appends once per clip FILED, so it never repeats. The backfill re-reads the
  // whole tree every time — and it now has a menu item inviting exactly that. Without dedupe, every
  // click appends the same samples again and pushes real ones out of the front of the 60-cap.
  //
  // ⚠⚠ THIS ASSERTS THE OLDEST SAMPLE SURVIVES, NOT THE LENGTH. The length version of this test
  // passed with the dedupe deleted — appending 2 and slicing to -60 leaves the count at exactly 60
  // forever, while `s0`, `s1`, `s2`… are silently evicted one run at a time. Caught by breaking the
  // dedupe and watching the length assertion stay green. Eviction is the harm; count is not.
  // ⚠ THE FIRST RUN LEGITIMATELY EVICTS. This record starts AT the 60 cap, so adding the folder's 2
  // real samples pushes `s0`/`s1` out — that is the cap doing its job, and asserting `s0` survives
  // fails against correct code. The invariant that actually distinguishes the bug is that every run
  // AFTER the first changes nothing at all.
  seedRichRecord();
  await app.invoke('ai:backfillLedger', root);
  const afterOne = JSON.stringify(recNow().samples);

  for (let i = 0; i < 4; i += 1) await app.invoke('ai:backfillLedger', root);   // eslint-disable-line no-await-in-loop

  assert.equal(JSON.stringify(recNow().samples), afterOne,
    '⚠⚠ re-running over an unchanged tree must be a no-op — without dedupe each click evicts two more real samples while the COUNT stays at 60, which is why the length version of this assertion passed with the bug in place');
  const subs = recNow().samples.map((s) => s && s.subject);
  assert.equal(subs.filter((s) => s === 'hedge-trimming').length, 1,
    '⚠ and the folder’s own sample is present exactly once, not once per run');
});

test('⚠ a brand-new project is still learned normally', async () => {
  // Guard against "fix it by doing nothing". The enrich path must still create and populate records.
  const cfg = app.get('config');
  cfg.projectsRoot = root;
  cfg.projectLedger = [];
  const r = app.plain(await app.invoke('ai:backfillLedger', root));
  assert.equal(r.ok, true);
  const rec = recNow();
  assert.ok(rec, '⚠ the project is created');
  assert.equal(rec.clips, 2, 'with its real clip count');
  assert.deepEqual([...rec.subjects].sort(), ['hedge-trimming', 'leaf-blowing'], 'and the subjects on disk');
});
