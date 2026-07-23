// ⚠⚠ A MEASURED FAILURE, PINNED SO IT IS NOT REPEATED — plus the part of it that was worth keeping.
//
// THE IDEA. `subjectVocabulary()` builds the canonicaliser's vocabulary from three stores:
// `config.subjects`, the rename drafts, and `finalMeta`. All three are what the APP wrote, and mostly
// what the AI wrote — 112 distinct subjects across 206 named clips, 46% of them describing the shot.
// So snapping could only ever map one machine-generated fragment onto another. His hand-made project
// folders looked like the one subject vocabulary he had authored himself, and the ledger already read
// them for placement. Adding them as a fourth source was implemented, tested, and measured.
//
// THE MEASUREMENT, against his real tree (51 records, 764 clips) and his real stores:
//
//     drafts (112 subjects)  ->  91 groups empty ledger  ->  91 groups populated.  No change.
//     backlog (8 subjects)   ->   8 groups empty ledger  ->   8 groups populated.  No change.
//     subjects whose canonical CHANGED: 2, and BOTH were wrong —
//         vlog-footage -> 2026-06-11-vlog-footage-from-gopros-v1   (a folder named after a CLIP)
//         timelapse    -> 05-timelapse                             (numbered scaffolding)
//
// Zero benefit, two regressions. Because a real Projects tree is WORKFLOW SCAFFOLDING, not a subject
// list: his folders include `V5`, `Final Videos`, `In Progress`, `Hook`, `Day 1`..`Day 5`, `B-Roll`,
// `raw footage`, `tdarr-workDir2-B73eb1-hG`. Filtering years, dates, `_unsorted` and `vlog` was
// nowhere near enough, and each further rule is a guess about a folder habit that is his to change.
//
// And it could never have helped: canonicalisation runs only at AI-name time and on-type. Nothing in
// `destinationParts`, `finalize:run` or `projects:move` calls it, so his already-named backlog — the
// footage that would actually be filed — never passes through it.
//
// WHAT WAS KEPT: reading the tree into the ledger, and the permanent route to do it. That feeds
// PLACEMENT (`ledgerMatch`, same-shoot recall), which is real, measured, and was previously reachable
// only through a health-check prompt that fired while the ledger was completely empty.
import { test, before, after } from 'node:test';
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

// --- THE PIN: the ledger must NOT reach the vocabulary ------------------------------------------

test('⚠⚠ his project FOLDERS are not a subject vocabulary — the two real regressions stay fixed', async () => {
  // These are the exact folder names measured on his disk, and the exact two subjects that were
  // canonicalised wrongly. If someone re-adds the ledger as a vocabulary source, both come back.
  const cfg = app.get('config');
  cfg.subjects = ['vlog-footage', 'timelapse', 'lawn-mowing'];
  cfg.renameDrafts = {}; cfg.finalMeta = {};
  cfg.projectLedger = [
    'V5', 'Final Videos', 'In Progress', 'Finished', 'Hook', 'Day 1', 'B-Roll', 'raw footage',
    '01 - Uncompressed', 'tdarr-workDir2-B73eb1-hG', '2026-06-11-vlog-footage-from-gopros-v1',
    '05-timelapse', 'Gourgess Lawns',
  ].map((n, i) => ({ id: `p${i}`, rel: `2026/${n}`, name: n, clips: 10, subjects: [] }));

  assert.equal((await canon('vlog-footage')).canonical, 'vlog-footage',
    '⚠⚠ a folder named after a CLIP must never become his subject');
  assert.equal((await canon('timelapse')).canonical, 'timelapse',
    '⚠⚠ numbered scaffolding must never become his subject');

  assert.equal((await canon('x')).known, 3,
    '⚠⚠ the vocabulary is built from HIS SUBJECTS only — a ledger entry must not enlarge it');
});

test('⚠ the subjects he really uses still canonicalise as before', async () => {
  // Guards the over-correction: the revert must not have broken the vocabulary that does work.
  // `lawn-mowing` matched at 1.00 without the ledger, and still must.
  const cfg = app.get('config');
  cfg.subjects = []; cfg.finalMeta = {}; cfg.projectLedger = [];
  cfg.renameDrafts = {};
  for (let i = 0; i < 12; i += 1) cfg.renameDrafts[`c${i}.mp4__1__1`] = { subject: 'lawn-mowing' };

  const r = await canon('lawn-mowing-dennis-yard');
  assert.equal(r.canonical, 'lawn-mowing', '⚠ fragment-snapping onto a subject he really uses still works');
  assert.equal(r.matched, true);
});

// --- WHAT WAS KEPT: a permanent route to read his tree into the ledger ---------------------------

test('⚠⚠ there is a PERMANENT route to re-read his Projects folder', () => {
  // The ledger feeds PLACEMENT, and `ai:backfillLedger` had exactly one caller: the AI health check,
  // gated on `!ledgerN && treeHasFiles`. Right for a nudge, wrong as the only door — one run of five
  // projects closes it forever and the folders he adds afterwards are never read.
  assert.match(menus, /Read my Projects folder…/, 'it is in the Filing & destinations menu');
  assert.match(menus, /action: learnFromProjectsTree/, 'wired to the renderer function');
  assert.ok(core.indexOf('async function learnFromProjectsTree') > -1, 'which exists');
  assert.match(learnBody, /await window\.api\.aiBackfillLedger\(/,
    '⚠ and really invokes ai:backfillLedger, rather than looking like it does');
});

test('⚠⚠ the caller is named differently from the bridge method ON PURPOSE', () => {
  // `test/ipc-reachability.test.mjs` matches `` `.${m}(` ``, so a renderer function sharing the
  // bridge method's name satisfies the guard while calling nothing (AGENTS §8h).
  assert.ok(!/function aiBackfillLedger/.test(core),
    '⚠ no renderer function shadows the bridge method name');
});

test('⚠⚠ a re-run that learned nothing new SAYS so', () => {
  // Never report success for something that did not happen. Reporting the ledger TOTAL after a
  // re-run that added nothing reads as fresh work.
  assert.match(learnBody, /r\.learned/, 'it reads what actually CHANGED, not just the total');
  assert.match(learnBody, /Already up to date/, '⚠ and says so plainly when nothing was added');
  assert.match(learnBody, /Learned \$\{added\}/, 'while a real import reports the new count');
});

test('⚠ with no Projects folder set it says that, not a failure', () => {
  assert.match(learnBody, /Set a Projects folder first/, 'it names the real cause');
  const guardAt = learnBody.indexOf('Set a Projects folder first');
  assert.ok(guardAt > -1 && guardAt < learnBody.indexOf('aiBackfillLedger'),
    '⚠ the guard precedes the call, so an unset root cannot reach main');
});

test('⚠ a rejected IPC is caught — this runs from a menu, where a throw is silent', () => {
  // IPC awaits CAN reject. An uncaught rejection in a menu action leaves a "Reading…" toast forever.
  assert.match(learnBody, /catch \(e\) \{[^}]*Could not read your Projects folder/,
    '⚠ the invoke is wrapped, and the failure is reported to him');
});
