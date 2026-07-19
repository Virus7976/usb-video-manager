// A face scan whose SOURCE became unreadable marked every remaining clip "scanned, no faces" —
// permanently, and while reporting success.
//
// `detectFacesForClip` already distinguishes a GPU hiccup from a genuine absence of faces (#84: "a
// GPU/WebGL hiccup makes detectAllFaces throw, which used to look identical to 'no faces' — so we'd
// mark the clip scanned and NEVER retry it"). But that signal is computed AFTER the frames arrive,
// and the couldn't-read-the-source exit returns before it:
//
//     const frames = (r && r.ok && Array.isArray(r.frames)) ? r.frames : [];
//     if (!frames.length) return { ready: true, faces: [], scene: null };   // ← no error signal
//
// Main returns exactly that shape when ffmpeg cannot read the file. So an unreadable source is
// indistinguishable from "this clip genuinely has no faces in it" — the precise confusion #84 was
// written to end, arriving through a different door.
//
// The sequence: start a face scan on a card of 400 clips, pull the card 30 clips in (or rename the
// folder holding them, or have the ffmpeg binary replaced by an update). Every remaining clip now
// fails instantly, so the loop burns through 370 of them in seconds, prints "No faces found" for each
// and persists `facesScanned: true` for each. That flag is durable and exclusionary — `isScanned()`
// filters those clips out of every future scan, and `force` is only reachable from a prompt that no
// longer appears once any review exists. **Those clips can never be face-scanned again.**
//
// `collectClipFaces` is worse: it sets the flag unconditionally, never consulting the error signal
// at all.
//
// Driven through the REAL renderer because these are renderer functions the vm harness cannot reach,
// and because what matters is the persisted flag, not the shape of a return value.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app;
before(async () => { if (RUN) app = await launchApp({ seed: { 'config.json': { firstRun: false } } }); });
after(async () => { if (app) await app.close(); });

// A clip whose source does not exist — exactly what a pulled card leaves behind.
async function seedMissingClip(win) {
  await run(win, `
    state.scannedFiles = [{ name: 'GX010042.MP4', size: 4096, mtimeMs: 1700000000000,
                            sourcePath: 'E:\\\\DCIM\\\\GONE.MP4', subject: '', description: '' }];
  `);
}

test('an unreadable source reports a READ failure, not "no faces"', { skip: !RUN }, async () => {
  await seedMissingClip(app.win);
  const res = await read(app.win, `detectFacesForClip(state.scannedFiles[0])`);
  assert.deepEqual(res.faces, [], 'no faces were found, which is true');
  assert.equal(res.readError, true, 'but it says WHY — the source could not be read');
});

test('a clip whose source could not be read is NOT marked scanned', { skip: !RUN }, async () => {
  // The durable half. If this flag sticks, the clip is excluded from every future scan.
  await seedMissingClip(app.win);
  await run(app.win, `state.scannedFiles[0]._facesScanned = false;`);
  const res = await read(app.win, `detectFacesForClip(state.scannedFiles[0])`);
  assert.ok(res.readError || res.detectError, 'the failure is signalled');
  const marked = await read(app.win, `!!state.scannedFiles[0]._facesScanned`);
  assert.equal(marked, false, 'so the clip stays scannable');
});

test('the scan loop treats a read failure like a detect failure', { skip: !RUN }, async () => {
  // Both mean "we learned nothing about this clip" and must leave it retryable. Asserted on the
  // source because the loop is a long async driver, but bound to the exact condition.
  const src = await read(app.win, `String(scanFacesForClips)`);
  assert.match(src, /res\.detectError \|\| res\.readError|res\.readError \|\| res\.detectError/,
    'the loop checks both signals before marking a clip scanned');
});

test('collectClipFaces does not mark a failed clip scanned either', { skip: !RUN }, async () => {
  // It used to set the flag unconditionally — the same durable false negative, on the other path.
  const src = await read(app.win, `String(collectClipFaces)`);
  const tail = src.slice(src.indexOf('_facesScanned = true'));
  assert.ok(src.indexOf('_facesScanned = true') > 0, 'it still marks clips scanned');
  assert.match(src, /if \(!fr\.readError && !fr\.detectError\)|fr\.readError \|\| fr\.detectError/,
    'but only when the detection actually ran');
  assert.ok(tail.length > 0, 'and the flag is still reachable on the success path');
});

test('a genuinely face-free clip IS still marked scanned', { skip: !RUN }, async () => {
  // Guard the other direction, and it is the important one: if this regresses, every clip without a
  // face is re-scanned forever and a card of landscapes never stops costing GPU time.
  const src = await read(app.win, `String(scanFacesForClips)`);
  assert.match(src, /clip\._facesScanned = true/, 'the success path still sets the flag');
  assert.match(src, /persistScannedFlag\(/, 'and still persists it');
});

test('the activity line tells the truth about what happened', { skip: !RUN }, async () => {
  // "No faces found" for 370 clips the app never actually read is a false statement, not just a
  // missing flag.
  const src = await read(app.win, `String(scanFacesForClips)`);
  assert.match(src, /Couldn|could not be read|unreadable/i, 'an unreadable clip says so');
});
