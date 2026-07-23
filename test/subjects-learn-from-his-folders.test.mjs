// ⚠⚠ THE VOCABULARY WAS BUILT FROM THE PROBLEM — FEATURES.md item 29.
//
// `subjectVocabulary()` was assembled from exactly three sources: `config.subjects`, the rename
// drafts, and finalMeta. All three are what the app (and mostly the AI) has written. Measured on his
// real store: 4,594 clips, 331 named, **112 distinct subjects across 206 named clips**, 46% of them
// describing the SHOT rather than the job. So the canonicaliser could only ever snap one
// AI-generated fragment onto another AI-generated fragment. It was learning his vocabulary from the
// one place his vocabulary does not exist.
//
// His REAL vocabulary is on disk, and has been for years: the project folders he made by hand.
// `02 - Projects/2026/dennis-lawn` is a subject he authored, committed to, and filed 40 clips into.
// The ledger already reads those folders (`ai:backfillLedger` → `backfillLedgerFromTree`) and the
// placement tool already uses them — but they never reached the vocabulary, so the one name in the
// system that he definitely chose himself was the one name snapping could not reach.
//
// Probed before the fix, with two hand-made folders holding 62 clips between them:
//     canonical: dennis-lawn-mowing | matched: false | known: 0
//
// ⚠ IT STILL ONLY PROPOSES. Nothing here rewrites a subject. The vocabulary gains entries; whether
// to apply one is still the caller's decision, and for something HE typed it still asks him
// (`offerCanonicalSubject`). Learning his folder names must not become a licence to rename his work.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const src = (f) => readFileSync(join(process.cwd(), 'src', 'mod', f), 'utf8').replace(/\/\/.*$/gm, '');
const core = src('01-core.js');
const menus = src('06-menus.js');
const learnBody = (() => {
  const at = core.indexOf('async function learnFromProjectsTree');
  return at > -1 ? core.slice(at, core.indexOf('\nlet versionsCache', at)) : '';
})();

const canon = async (s) => app.plain(await app.invoke('subjects:canonicalize', s));

// A ledger record as `backfillLedgerFromTree` actually writes one: `rel` is the path under the
// projects root, `name` is the leaf folder, and `subjects` is empty for a hand-filed library
// because those filenames predate this app's naming scheme and `parseNamedClip` returns nothing.
const project = (rel, clips, subjects = []) => ({
  id: rel, rel, name: rel.split('/').pop(), category: rel.split('/')[0],
  clips, subjects, dates: [], people: [], samples: [], backfilled: true,
});

// Start from a store with NOTHING the app has named — his real situation for filed work, where the
// library is on disk and the in-app naming has produced nothing that groups.
const seedLedger = (projects) => {
  const cfg = app.get('config');
  cfg.subjects = [];
  cfg.renameDrafts = {};
  cfg.finalMeta = {};
  cfg.projectLedger = projects;
};

beforeEach(() => { seedLedger([]); });

test('⚠⚠ a folder he made by hand IS his vocabulary', async () => {
  // The headline case. He has filed 40 clips into a folder he named `dennis-lawn`. The AI proposes
  // `dennis-lawn-mowing` for a new clip of the same job. Before the fix that became spelling #2 and
  // the two never grouped, so neither reached a threshold worth filing.
  seedLedger([project('2026/dennis-lawn', 40)]);
  const r = await canon('dennis-lawn-mowing');
  assert.equal(r.ok, true);
  assert.equal(r.canonical, 'dennis-lawn', `⚠ should snap onto his own folder name — got ${r.canonical}`);
  assert.equal(r.matched, true);
});

test('⚠ the count he is shown is the number of clips really filed there', async () => {
  // `offerCanonicalSubject` puts this number in front of him — "you have already used it on N
  // clips" — and that is the fact that makes the choice obvious. It has to be true: the ledger
  // records how many clips are actually in that folder, so that is what it must report.
  seedLedger([project('2026/gourgess-promo', 22)]);
  const r = await canon('gourgess-promo-shoot');
  assert.equal(r.canonical, 'gourgess-promo');
  assert.equal(r.knownCounts['gourgess-promo'], 22, '⚠ the count must be the real filed-clip count');
});

// ⚠ THE REJECTION TESTS BELOW ASSERT ON `known` — THE SIZE OF THE VOCABULARY — NOT ON `matched`.
//
// Asserting `matched === false` for these would pass vacuously and prove nothing: `2026` and
// `lawn-mowing` score ~0 on similarity, so the proposal fails to match whether or not the junk was
// learned. `known` is the number of entries the vocabulary actually built, so it goes to 1 the
// instant a filter is removed. Every one of these was verified by deleting its filter and watching
// this exact assertion fail — see §8c, "a structural assertion must name the thing that would go
// missing".

test('⚠⚠ a year folder is not a subject', async () => {
  // `02 - Projects/2026` holds clips directly in some trees, so it earns a ledger record. Learning
  // `2026` as a subject would be worse than learning nothing: every shoot of that year is "similar"
  // to it, and filing by it groups his entire year into one folder.
  seedLedger([project('2026', 300), project('2026/2026-05-31', 12)]);
  const r = await canon('lawn-mowing');
  assert.equal(r.known, 0, '⚠ a bare year/date must never enter the vocabulary');
  assert.equal(r.matched, false);
});

test('⚠ `_unsorted` is a dumping ground, not a subject', async () => {
  // The destination ladder writes `<date>/_unsorted` when it cannot decide (FEATURES.md item 9).
  // That folder fills up precisely BECAUSE nothing grouped, so learning it as a subject would take
  // the app's own failure and teach it back to him as his own vocabulary.
  seedLedger([project('2026/_unsorted', 180)]);
  const r = await canon('unsorted-clips');
  assert.equal(r.known, 0, '⚠ never learn the app’s own fallback folder as a subject');
});

test('⚠⚠ a weak folder name never becomes something real shoots snap onto', async () => {
  // The trap `isMeaningfulCanonical` exists for, arriving by a new route. A folder literally called
  // `vlog` is entirely plausible in a real tree — and if it enters the vocabulary, `bedtime-vlog`,
  // `kitchen-vlog` and every other vlog he has ever shot collapse into it. Running the merge planner
  // against his real store once proposed exactly this shape, collapsing shoots into **`snow`** and
  // **`playing`**: names worse than the fragmentation they replace.
  seedLedger([project('2026/vlog', 60), project('2026/misc', 25)]);
  const r = await canon('bedtime-vlog');
  assert.equal(r.known, 0, '⚠ a weak/shot-word folder must not enter the vocabulary');
  assert.equal(r.matched, false, '⚠ and a real shoot must not be swallowed by it');
});

test('⚠⚠ a genuinely new shoot is still not forced onto a folder name', async () => {
  // The failure that would make this hated, and the reason the threshold is not lowered: the first
  // clip of a new job filed into last year's client folder. Unfiled clips are recoverable; a
  // personal vlog filed into a client job is the failure this repo already had and reverted.
  //
  // `known === 2` is load-bearing here: it proves the vocabulary really was populated and STILL
  // declined the match, rather than the assertion passing because nothing was learned at all.
  seedLedger([project('2026/dennis-lawn', 40), project('2026/gourgess-promo', 22)]);
  const r = await canon('wedding-fieldhouse');
  assert.equal(r.known, 2, 'setup: both folders must really be in the vocabulary');
  assert.equal(r.matched, false, '⚠ a new shoot stays new');
  assert.equal(r.canonical, 'wedding-fieldhouse');
});

test('⚠⚠ backfilling the ledger mid-session is visible to the very next clip', async () => {
  // The cache trap this file's neighbour already hit once: the vocabulary is cached on a SIGNATURE,
  // and the signature counted drafts, subjects and finalMeta only. Adding a source without adding it
  // to the signature means the reading of his whole library lands in a store that nothing re-reads —
  // he runs the backfill, and the next clip he names is canonicalised against the empty vocabulary
  // that was cached a second earlier. That is invisible in every test that seeds before it asks.
  seedLedger([]);
  const before = await canon('dennis-lawn-mowing');
  assert.equal(before.matched, false, 'setup: nothing known yet');

  const cfg = app.get('config');
  cfg.projectLedger = [project('2026/dennis-lawn', 40)];   // as a backfill run would leave it

  const after = await canon('dennis-lawn-mowing');
  assert.equal(after.canonical, 'dennis-lawn', '⚠ the cache must invalidate when the ledger changes');
  assert.equal(after.matched, true);
});

test('⚠ subjects parsed out of filed filenames count too', async () => {
  // Where the library WAS named by this app, `backfillLedgerFromTree` fills `rec.subjects` from
  // `parseNamedClip`. Those are as real as the folder name and must not be dropped on the floor.
  seedLedger([project('2026/client-work', 30, ['curling-bonspiel'])]);
  const r = await canon('curling-bonspiel-final');
  assert.equal(r.canonical, 'curling-bonspiel', `⚠ ledger subjects must be learned — got ${r.canonical}`);
});

test('⚠ a ledger that is missing, empty or malformed changes nothing', async () => {
  // Defensive, and cheap: this runs inside naming, which must never throw. A store that failed to
  // read arrives as undefined, and a hand-edited one can hold anything.
  const cfg = app.get('config');
  cfg.subjects = []; cfg.renameDrafts = {}; cfg.finalMeta = {};

  for (const bad of [undefined, null, [], 'nonsense', [null, {}, { name: '' }, { name: 42 }]]) {
    cfg.projectLedger = bad;
    // eslint-disable-next-line no-await-in-loop
    const r = await canon('lawn-mowing');
    assert.equal(r.ok, true, `⚠ threw or failed on ledger = ${JSON.stringify(bad)}`);
    assert.equal(r.canonical, 'lawn-mowing');
  }
});

// --- AND THE LEDGER HAS TO BE REFRESHABLE, OR THE VOCABULARY GOES STALE -------------------------
//
// Everything above is worth nothing if the ledger is empty. `ai:backfillLedger` is what fills it,
// and it had exactly one caller: the AI health check, behind `if (!ledgerN && treeHasFiles)`. That
// gate fires only while the ledger is COMPLETELY empty — so one run of five projects closes the door
// permanently, and the fifty folders he adds over the next year are never read. A vocabulary built
// from his folders is only as current as the last time anything read them.

test('⚠⚠ there is a PERMANENT route to re-read his Projects folder', () => {
  assert.match(menus, /Read my Projects folder…/, 'it is in the Filing & destinations menu');
  assert.match(menus, /action: learnFromProjectsTree/, 'wired to the renderer function');
  assert.ok(core.indexOf('async function learnFromProjectsTree') > -1, 'which exists');
  assert.match(learnBody, /await window\.api\.aiBackfillLedger\(/,
    '⚠ and really invokes ai:backfillLedger, rather than looking like it does');
});

test('⚠⚠ the caller is named differently from the bridge method ON PURPOSE', () => {
  // `test/ipc-reachability.test.mjs` matches `` `.${m}(` ``, so a renderer function sharing the
  // bridge method's name satisfies the guard while calling nothing. That exact shape nearly shipped
  // the wireless-backup work dead (AGENTS §8h).
  assert.ok(!/function aiBackfillLedger/.test(core),
    '⚠ no renderer function shadows the bridge method name');
});

test('⚠⚠ a re-run that learned nothing new SAYS so', () => {
  // The standing invariant (§ Tier 3, item 42): never report success for something that did not
  // happen. Reporting the ledger TOTAL after a re-run that added nothing reads as work done — he
  // would believe his newly-added folders had been picked up when they had not.
  assert.match(learnBody, /r\.learned/, 'it reads what actually CHANGED, not just the total');
  assert.match(learnBody, /Already up to date/, '⚠ and says so plainly when nothing was added');
  assert.match(learnBody, /Learned \$\{added\}/, 'while a real import reports the new count');
});

test('⚠ with no Projects folder set it says that, not a failure', () => {
  // "Could not read your Projects folder" for a folder that was never configured sends him looking
  // for a broken disk. The early return has to precede the call.
  assert.match(learnBody, /Set a Projects folder first/, 'it names the real cause');
  const guardAt = learnBody.indexOf('Set a Projects folder first');
  assert.ok(guardAt > -1 && guardAt < learnBody.indexOf('aiBackfillLedger'),
    '⚠ the guard precedes the call, so an unset root cannot reach main');
});

test('⚠ a rejected IPC is caught — this runs from a menu, where a throw is silent', () => {
  // IPC awaits CAN reject (project memory: usb-app-async-cleanup-rule). An uncaught rejection in a
  // menu action leaves him with a toast that says "Reading…" forever and no error anywhere.
  assert.match(learnBody, /catch \(e\) \{[^}]*Could not read your Projects folder/,
    '⚠ the invoke is wrapped, and the failure is reported to him');
});
