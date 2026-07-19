// THE GROUP SHOTS.
//
// Owner: "make it so that it can recognize multiple people per frame … if there are more than one
// unconfirmed it should have a thumbnail with that section of the video and I should be able to click
// each face and name them."
//
// Detection ALREADY found everyone in a frame (`detectAllFaces`) — but all the app ever kept was a
// 144px crop per person, so a frame with three people became three disembodied heads and the shot they
// came from was thrown away. Now the best group frame per clip is kept, with a box per face.
//
// The two things that can actually LOSE data here, and so are what these tests are about:
//   1. the frame is a ~1100px JPEG — inline it and face-scenes.json becomes megabytes of base64;
//   2. gcFaceCrops() reference-counts crop files and deletes whatever nothing points at. Miss the
//      scenes there and it deletes every frame the first time it runs, while the store still points
//      at them — a review grid full of broken images.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let app;
const plain = (v) => JSON.parse(JSON.stringify(v ?? null));

// A real 1×1 JPEG, base64 — enough for saveFaceCrop to write a genuine file.
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL'
  + 'DBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAA'
  + 'AAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

const face = (seed) => ({
  descriptor: Array.from({ length: 128 }, (_, i) => ((i * seed) % 100) / 100),
  box: { x: 10 * seed, y: 20, width: 60, height: 60 },
});

before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });
beforeEach(() => {
  const cfg = app.get('config');
  cfg.ai = { people: [], facesPending: [], faceScenes: [] };
});

const scene = (over = {}) => ({
  clipKey: 'GX010023.MP4__1234',
  name: 'GX010023.MP4',
  img: JPEG,
  w: 1100,
  h: 620,
  faces: [face(1), face(2)],
  ...over,
});

const facesDir = () => join(app.get('STORE_DIR'), 'faces');

test('a group shot is stored, and the FRAME goes to disk — not into the JSON', async () => {
  await app.invoke('faces:saveScenes', [scene()]);
  const saved = plain(await app.invoke('faces:getScenes'));
  assert.equal(saved.length, 1);
  assert.ok(saved[0].img.startsWith('file:'), 'externalised, like every other crop');
  assert.equal(/^data:/.test(saved[0].img), false, 'no base64 left in the store');
  assert.equal(saved[0].faces.length, 2);
  assert.deepEqual(saved[0].faces[0].box, { x: 10, y: 20, width: 60, height: 60 }, 'the box survives');
  assert.equal(saved[0].faces[0].descriptor.length, 128, 'and the descriptor, which is how it re-links');
});

test('⚠ the crop GC does NOT delete the frames', async () => {
  // gcFaceCrops removes any file in faces/ that nothing references. It knew about people and pending
  // clusters — not scenes. Without the scenes in its keep-set it deletes every frame on the next save,
  // while face-scenes.json still points at them.
  await app.invoke('faces:saveScenes', [scene()]);
  const img = plain(await app.invoke('faces:getScenes'))[0].img;
  const file = img.replace('file://', '');

  app.get('gcFaceCrops')();

  assert.ok(existsSync(decodeURIComponent(file)), 'the frame is still on disk after a GC');
  assert.ok(readdirSync(facesDir()).length >= 1);
});

test('a re-scan REPLACES that clip\'s shot, and the old frame is collected', async () => {
  await app.invoke('faces:saveScenes', [scene()]);
  const first = plain(await app.invoke('faces:getScenes'))[0].img;

  await app.invoke('faces:saveScenes', [scene({ w: 1280 })]);   // same clipKey, scanned again
  const after = plain(await app.invoke('faces:getScenes'));

  assert.equal(after.length, 1, 'one shot per clip — not two copies of the same faces');
  assert.equal(after[0].w, 1280, 'the new one won');
  assert.equal(existsSync(decodeURIComponent(first.replace('file://', ''))), false,
    'and the superseded frame was cleaned up rather than leaked');
});

test('a lone face is not a group shot', async () => {
  // The whole feature is "more than one". One face is already served perfectly by the existing card.
  await app.invoke('faces:saveScenes', [scene({ faces: [face(1)] })]);
  assert.deepEqual(plain(await app.invoke('faces:getScenes')), []);
});

test('a frame that cannot be written is DROPPED, never inlined', async () => {
  // Unlike a descriptor, the frame is pure UI sugar and the next scan regenerates it. Keeping it
  // inline "just in case" is how the JSON store quietly becomes megabytes of base64.
  await app.invoke('faces:saveScenes', [scene({ img: 'not-an-image' })]);
  assert.deepEqual(plain(await app.invoke('faces:getScenes')), []);
});

test('the store is registered, lazy, and defaults to empty', () => {
  // face-scenes.json holds frames. Reading it at boot would undo exactly the startup work the other
  // face stores were made lazy for.
  const core = readFileSync(join(ROOT, 'main-mod', '01-core.js'), 'utf8');
  assert.match(core, /'ai\.faceScenes': path\.join\(STORE_DIR, 'face-scenes\.json'\)/);
  assert.match(core, /LAZY_STORES = new Set\(\[[^\]]*'ai\.faceScenes'/);
  assert.match(core, /'ai\.faceScenes': \(\) => \[\]/);
});

// --- the renderer side -------------------------------------------------------------------------

test('the best group frame is the one with the MOST faces in it', () => {
  const src = readFileSync(join(ROOT, 'src', 'mod', '08-people.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function detectFacesForClip('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(inFrame\.length >= 2\)/, 'only frames showing people TOGETHER');
  assert.match(body, /inFrame\.length \* 1e9 \+ inFrame\.reduce/, 'most faces wins; size breaks the tie');
  // The boxes are in `src` space (faceSource may have downscaled a big photo), so the image we keep
  // has to be too — otherwise every box lands in the wrong place on the frame.
  assert.match(body, /if \(src\.el !== img\) \{ try \{ sceneImg = src\.el\.toDataURL/);
});

test('a scene face re-links to its cluster by DESCRIPTOR, never by a stored index', () => {
  // Clusters are rebuilt from faces-pending.json on every reopen and merged across scans, so an index
  // written down today points at a different person tomorrow.
  const src = readFileSync(join(ROOT, 'src', 'mod', '08-people.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function showFaceReviewGrid('));
  // The distance is FACE_CLUSTER_DIST (audit #91 named it; it was a bare 0.5 here). What this test
  // is actually pinning is the DESCRIPTOR lookup, not the number — the number lives in one place now
  // and is pinned by test/face-thresholds.test.mjs.
  assert.match(fn, /const clusterOf = \(desc\) => clusters\.findIndex\(\(c\) => c && !c\.skipped && faceDist\(c\.descriptor, desc\) < FACE_CLUSTER_DIST\)/);
  assert.equal(/faces\[\s*fi\s*\]\.ci\b/.test(fn), false, 'no persisted cluster index');
});

test('clicking a face opens the SAME card — no second naming path', () => {
  // The naming flow (suggestion, chips, "Who is this?", Enter-to-save) is the one he already likes.
  // The scene reuses cardHTML and wire() verbatim; a parallel implementation is how the two drift.
  const src = readFileSync(join(ROOT, 'src', 'mod', '08-people.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function showFaceReviewGrid('));
  // Reuses cardHTML verbatim (a parallel implementation is how the two naming paths drift) — now as a
  // popup ON the photo, whose thumbnail is the clicked face cropped from THIS shot.
  assert.match(fn, /<div class="fsc-pop-wrap">\$\{cardHTML\(sel, \{ faceImg: s\.img, faceBox: selBox/, 'the real card, as a popup on the photo');
  assert.match(fn, /wireScenes\(scenes\)/);
  // …and a face being named ON the shot must not ALSO appear below as a loose head.
  assert.match(fn, /const onScene = new Set\(scenes\.flatMap\(\(s\) => s\.cis\)\.filter\(\(ci\) => ci >= 0\)\)/);
  assert.match(fn, /clusters\.filter\(\(c\) => !c\.skipped && !onScene\.has\(c\._i\)\)/);
});

test('the shot is shown while anyone in it is still unnamed', () => {
  const src = readFileSync(join(ROOT, 'src', 'mod', '08-people.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function showFaceReviewGrid('));
  assert.match(fn, /\.filter\(\(s\) => s\.cis\.filter\(\(ci\) => ci >= 0\)\.length >= 2 && s\.cis\.some\(unresolved\)\)/);
});
