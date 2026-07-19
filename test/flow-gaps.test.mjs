// The "hundreds of little things" round: work that was quietly lost, failures you couldn't see,
// and dead ends. Each test names the concrete thing that used to go wrong.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = (f) => readFileSync(join(ROOT, 'src', 'mod', f), 'utf8');

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

// --- the draft guard is now a DENYLIST -------------------------------------------------

test('a stale save cannot blank a CUSTOM organize field', async () => {
  // The guard named its protected fields explicitly, so anything not on that list fell straight
  // through `{...prev, ...incoming}`. Custom organize fields are USER-DEFINED — an allowlist can
  // never cover them by construction, so they were unprotected forever.
  const mergeDraft = app.get('mergeDraft');
  const prev = { subject: 'snow', clientName: 'acme-corp', shootRef: 'JOB-812' };
  const merged = mergeDraft(prev, { subject: 'snow', clientName: '', shootRef: '' });
  assert.equal(merged.clientName, 'acme-corp', 'a blank incoming value never wipes a saved one');
  assert.equal(merged.shootRef, 'JOB-812');
});

test('a stale save cannot flip facesScanned back to false', async () => {
  // If it did, the whole card would be re-face-scanned from scratch — the exact "it forgot" shape.
  const mergeDraft = app.get('mergeDraft');
  const merged = mergeDraft({ subject: 's', facesScanned: true }, { subject: 's', facesScanned: false });
  assert.equal(merged.facesScanned, true);
});

test('a stale save cannot drop the confirmed same-shoot project', async () => {
  const mergeDraft = app.get('mergeDraft');
  const merged = mergeDraft({ subject: 's', ledgerRel: 'Client/Alps-2026' }, { subject: 's', ledgerRel: '' });
  assert.equal(merged.ledgerRel, 'Client/Alps-2026');
});

test('but UNTICKING a clip still persists — `selected` is deliberately clearable', async () => {
  // The denylist has to have exceptions, or the user could never untick anything. This is the one
  // field where an empty incoming value is a real instruction, not a stale write.
  const mergeDraft = app.get('mergeDraft');
  const merged = mergeDraft({ subject: 's', selected: true }, { subject: 's', selected: false });
  assert.equal(merged.selected, false, 'unticking a clip is honoured');
});

// --- the AI review queue survives a restart --------------------------------------------

test('the question queue round-trips, keyed by clipKey and never by array index', async () => {
  // Questions carry a clipIndex — a POSITION in state.scannedFiles. Persisting that would
  // re-attach "is this a new category?" to a completely different clip after a rescan.
  await app.invoke('aiq:save', [
    { type: 'category', clipKey: 'GX010023.MP4__12345', field: 'category', suggested: 'skiing' },
    { type: 'confirm', clipKey: 'GX010024.MP4__999' },
    { type: 'rule', rule: 'file skiing under Personal' },
  ]);
  const got = await app.invoke('aiq:get');
  assert.equal(got.length, 3, 'the review pass survives quitting before you got to it');
  assert.equal(got[0].clipKey, 'GX010023.MP4__12345');
  assert.equal(got[0].suggested, 'skiing');
  assert.equal(got[2].rule, 'file skiing under Personal', 'a rule question has no clip and still persists');
  assert.equal('clipIndex' in got[0], false, 'an array index is NEVER what we store');
});

test('the renderer saves the queue on every change and rehydrates by clipKey', () => {
  const ai = mod('04-tasks-ai.js');
  const add = ai.slice(ai.indexOf('function addAiQuestion('));
  assert.match(add.slice(0, add.indexOf('\n}')), /saveAiQuestions\(\)/, 'adding a question persists it');
  const res = ai.slice(ai.indexOf('function resolveAiQuestion('));
  assert.match(res.slice(0, res.indexOf('\n}')), /saveAiQuestions\(\)/, 'answering one persists that too');

  const restore = ai.slice(ai.indexOf('async function restoreAiQuestions('));
  const body = restore.slice(0, restore.indexOf('\n}\n'));
  assert.match(body, /byKey\.set\(clipKey\(c\), i\)/, 'clipKey → current index');
  assert.match(body, /if \(q\.clipKey && !byKey\.has\(q\.clipKey\)\) continue/, 'a question whose clip is gone is DROPPED, not misattached');
});

// --- per-file AI failure + retry ---------------------------------------------------------

test('a failed clip carries its own failure, so you can see which and why', () => {
  const ai = mod('04-tasks-ai.js');
  assert.match(ai, /clip\._aiFailed = true; clip\._aiError = why/, 'the clip is marked');
  assert.match(ai, /function markClipFailed\(/, 'and the card shows it');
  assert.match(ai, /function aiFailedClips\(\)/, 'and they can be enumerated');
});

test('the retry re-runs ONLY the failed clips, and puts the selection back', () => {
  // Silently changing what's ticked is how a "helpful" retry loses someone's work.
  const ai = mod('04-tasks-ai.js');
  const fn = ai.slice(ai.indexOf('async function offerRetryFailed('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /const prevSelected = state\.scannedFiles\.map/, 'the current selection is captured');
  assert.match(body, /finally \{/, 'and restored on every path');
  assert.match(body, /state\.scannedFiles\.forEach\(\(c, i\) => \{ c\.selected = prevSelected\[i\]; \}\)/);
  assert.match(body, /aiAnalyzeSelected\(\{ mode: 'all' \}\)/, 'a preset run — the user is not re-asked what they just answered');
});

test('a retry that fails again does NOT re-offer forever', () => {
  // offerRetryFailed → aiAnalyzeSelected → offerRetryFailed would recurse without this guard.
  const ai = mod('04-tasks-ai.js');
  assert.match(ai, /if \(failCount && !aiAborted && !preset\) await offerRetryFailed\(\)/, 'a preset run never re-offers');
});

// --- card removal ------------------------------------------------------------------------

test('a yanked card is diagnosed once and correctly, not sixty times as fake timeouts', async () => {
  // Fail-SAFE: a source we can't reason about is never claimed to be gone, because reporting a
  // phantom removal would abort a perfectly good run and tell the user a lie.
  assert.equal(await app.invoke('drive:present', '__phone__'), true, 'a phone is never "a removed card"');
  assert.equal(await app.invoke('drive:present', ''), true, 'an unknown source is never claimed gone');
  assert.equal(await app.invoke('drive:present', '/definitely/not/mounted'), false, 'a missing mount IS gone');

  const ai = mod('04-tasks-ai.js');
  assert.match(ai, /async function cardIsGone\(\)/);
  assert.match(ai, /function reportCardGone\(\)/);
  assert.match(ai, /if \(cardGoneReported\) return;/, 'reported ONCE, not per clip');
  assert.match(ai, /if \(!\(r && r\.ok\) && await cardIsGone\(\)\) \{ reportCardGone\(\); break; \}/, 'and the run STOPS');
});

// --- photos are footage too --------------------------------------------------------------

test('photos get a finalMeta record and become deletable from the card', () => {
  // Photos were a side-effect: never in state.copied (so the delete step didn't know they existed)
  // and never in finalMeta (so everything the AI worked out about them died when they left the card).
  const flow = mod('09-phone-finalize.js');
  const fn = flow.slice(flow.indexOf('async function distributeFlowPhotos('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /state\.copied\.push\(/, 'photos enter the delete list');
  assert.match(body, /window\.api\.recordCopied\(/, 'and the durable copied log');
  assert.match(body, /saveFlowFinalMeta\(safePhotos\)/, 'and carry their metadata to Organize');
  // …and ONLY the ones that actually verified.
  assert.match(body, /const safePhotos = photos\.filter\(\(p\) => landed\.has\(p\.sourcePath\)\)/,
    'a photo whose copy FAILED is never offered for deletion');
});

test('phone:distribute returns per-job results, which is what makes that possible', () => {
  const src = readFileSync(join(ROOT, 'main-mod', '05-windows-phone.js'), 'utf8');
  const h = src.slice(src.indexOf("ipcMain.handle('phone:distribute'"));
  const body = h.slice(0, h.indexOf('\n});'));
  // Assert the PROPERTY — a per-job record carrying src, dest and the outcome — not the exact
  // literal. Card photos are now staged off the card before embedding, so the reported src became
  // `j.origSrc || j.src` (the ORIGINAL path, which the renderer matches on) and an exact-shape
  // assertion failed on a correct change.
  assert.match(body, /results\.push\(\{ src: [^,]+, dest: j\.dest, ok, error \}\)/, 'a per-job record');
  assert.match(body, /j\.origSrc \|\| j\.src/, 'reporting the original source, not a staging path');
  assert.match(body, /results,/, 'and they are returned');
});

// --- dead ends -----------------------------------------------------------------------------

test('a step pill that refuses to open SAYS WHY', () => {
  // They failed completely silently: click, nothing happens, no way to tell whether the app is
  // broken or you missed a prerequisite.
  const flow = mod('09-phone-finalize.js');
  assert.match(flow, /Nothing has been copied off this card yet/, 'the Delete pill explains itself');
  assert.match(flow, /Nothing scanned yet — pick a drive first\./);
});

test('Cancel leaves the flow properly — it does not resume you back into the card you just left', () => {
  const core = mod('01-core.js');
  const h = core.slice(core.indexOf("$('cancelFlowBtn').addEventListener"));
  const body = h.slice(0, h.indexOf('\n});'));
  assert.match(body, /saveSession\(\{ view: 'home' \}\)/, 'the resume session is cleared');
  assert.match(body, /state\.copied = \[\]/, 'and the delete session ends, as it does in goHome');
});

test('Apply confirms before moving, and offers the undo that already existed', () => {
  const map = mod('07-organize-map.js');
  const h = map.slice(map.indexOf("q('.dmap-apply').addEventListener"));
  const body = h.slice(0, h.indexOf('\n    });'));
  assert.match(body, /await confirmDialog\(/, 'it asks before moving every clip on the map');
  // Audit #40: the call-out used to hardcode "misc" AND count only clips with no placement at all —
  // which recomputeAuto never produces, so it was dead. It now counts the _Unsorted placements too
  // (unplacedCounts) and names whichever destination actually applies. The intent this pins is
  // unchanged: the dialog must call out the clips with no real home.
  assert.match(body, /unplacedCounts\(clips, placement\)/, 'it counts what will really happen');
  assert.match(body, /no real home on the map/, 'and calls out the clips with no real home');
  assert.match(body, /showToastAction\(.*'Undo', \(\) => undoLastOrganize\(\)/s,
    'the undo is offered at the moment you would want it, not buried in a menu');
});

test('both destination-map call sites carry the confirmed same-shoot project', () => {
  // Two call sites; one had the bug. Opening the map from the "Visualize destinations" entry point
  // silently lost the decision and dropped those clips into _Unsorted.
  const map = mod('07-organize-map.js');
  const flow = mod('09-phone-finalize.js');
  const sites = [...map.matchAll(/showDestinationMap\(sel\.map/g), ...flow.matchAll(/showDestinationMap\(sel\.map/g)];
  assert.ok(sites.length >= 2, 'there really are two call sites');
  for (const src of [map, flow]) {
    for (const m of src.matchAll(/showDestinationMap\(sel\.map\(\(f\) => \(\{([^)]*)\}\)\)/g)) {
      assert.match(m[1], /_ledgerRel:/, 'every call site carries _ledgerRel');
    }
  }
});
