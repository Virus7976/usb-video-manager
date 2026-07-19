// A face scan you didn't confirm must survive. Owner: "if I do a face scan right now but don't
// confirm faces it doesn't remember the scan."
//
// On a 4594-clip card a lost scan is hours of GPU time, so this is a data-durability bug, not a
// polish one. It turned out to be four defects, and the worst was NOT the reported symptom:
//
//   `faces:savePending` REPLACES the whole pending store (main-mod/08-finalize-feedback.js). Both
//   `collectClipFaces` callers — the Organize analyze run and the phone finalize run — started from
//   `const faceClusters = []`, un-seeded, unlike `scanFacesForClips` which loads the existing store
//   first ("a scan merges, never replaces"). So an Analyze run silently DELETED every unconfirmed
//   face from an earlier scan. The user never asked for that and nothing reported it.
//
// These assert against the live renderer's own function source. That is weaker than driving a real
// scan — a real one needs a GPU face pass over fixture media — but it pins the four structural
// invariants so they cannot be silently reverted, which is exactly how they got lost.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
let scanSrc;
let organizeSrc;
let phoneSrc;
let autoSrc;
before(async () => {
  if (!RUN) return;
  app = await launchApp({ seed: { 'config.json': { firstRun: false } } });
  scanSrc = await read(app.win, 'String(scanFacesForClips)');
  // analyzeDmapTargets is nested inside showDestinationMap's closure, so read the outer one.
  organizeSrc = await read(app.win, 'String(showDestinationMap)');
  phoneSrc = await read(app.win, 'String(finAnalyzeSelected)');
  autoSrc = await read(app.win, 'String(scanFacesAuto)');
});
after(async () => { if (app) await app.close(); });

test('ending a scan persists the GROUP SHOTS, not just the pending clusters', { skip: !RUN }, async () => {
  // saveFaceScenesNow() used to be called from exactly one place: render(), inside the review grid.
  // A scan whose grid never opened kept its clusters and dropped every group shot.
  assert.match(scanSrc, /savePendingNow\(clusters\)/, 'pending still flushed');
  assert.match(scanSrc, /saveFaceScenesNow\(\)/, 'and the scenes are flushed with them');
});

test('the Organize analyze run SEEDS from the existing store instead of replacing it', { skip: !RUN }, async () => {
  assert.equal(/const faceClusters = \[\]/.test(organizeSrc), false,
    'an un-seeded array here silently deletes an earlier unconfirmed scan');
  assert.match(organizeSrc, /faceClusters = await loadPendingFaces\(\)/, 'seeded, so a save merges');
  assert.match(organizeSrc, /ensureFaceScenes\(\)/, 'group shots are cumulative too');
});

test('the Organize analyze run persists BEFORE the review grid opens', { skip: !RUN }, async () => {
  // An analyze run that found faces and was then aborted — or whose grid the user never opened —
  // previously lost every cluster it had built while the clips stayed marked as scanned, so a
  // re-scan skipped them and the work was gone for good.
  assert.match(organizeSrc, /savePendingNow\(faceClusters\)[\s\S]{0,600}showFaceReviewGrid/,
    'saved before the grid is (or is not) shown');
});

test('the phone finalize run seeds and persists too', { skip: !RUN }, async () => {
  // Same defect, second caller. Its auto-tag branch never opens a grid at all, so without an
  // explicit save nothing would ever write those clusters to disk.
  assert.equal(/const faceClusters = \[\]/.test(phoneSrc), false, 'not un-seeded');
  assert.match(phoneSrc, /faceClusters = await loadPendingFaces\(\)/, 'seeded, so a save merges');
  assert.match(phoneSrc, /savePendingNow\(faceClusters\)/, 'persisted on both branches');
});

test('the auto-tag pass no longer marks clips as review-scanned', { skip: !RUN }, async () => {
  // scanFacesAuto auto-tags but never clusters and never persists. Marking clips with the SHARED
  // `_facesScanned` flag made the real review scan skip them, so "Scan faces" found nothing to scan
  // and no saved review — reporting "No saved face review found" and forcing a full re-detect.
  assert.equal(/clip\._facesScanned = true/.test(autoSrc), false,
    'the auto pass must not claim clips have been reviewed');
  assert.match(autoSrc, /_facesAutoScanned/, 'it tracks its own work separately');
});
