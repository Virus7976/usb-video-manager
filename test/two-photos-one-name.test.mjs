// A phone holds two different photos with the same filename in different folders —
// `DCIM/Camera/IMG_0001.jpg` and `Pictures/IMG_0001.jpg`. That is ordinary, not an edge case:
// screenshots, downloads and camera output collide constantly.
//
// The pull pipeline identified items by `name` ALONE, and it broke three ways at once:
//
//   1. ⚠⚠ IT DELETED A PHOTO THAT HAD TRANSFERRED PERFECTLY.
//      `claimPullDest` correctly wrote the second item to `IMG_0001 (1).jpg`. The staging loop then
//      re-derived `join(dest, it.name)` → `IMG_0001.jpg` → stat'd the FIRST item's photo, compared
//      its size against the SECOND item's size, concluded "truncated pull" and unlinked it. The
//      first photo is gone from the import and the ` (1)` file is orphaned — never staged, never
//      named, never imported. In his flow the phone gets cleared afterwards, so that is the only
//      copy. This is the single worst class of bug in this app.
//   2. `mergePullResults` did `by.set(r.name, r)` — two items collapse to one result, so one photo
//      vanishes from the counts the UI reports.
//   3. `adbRetryList` treated a FAILED item as done because its same-named twin succeeded, so it
//      never got its MTP second chance.
//
// The fix gives an item a real identity: folder + filename (`pullKey`). Two items in the SAME folder
// cannot share a name, so that is unique by construction.
//
// NOTE ON SCOPE: the MTP PowerShell copier has the same collision hole (it does
// `Join-Path $dest $entry.name` with no claim set) and is NOT fixed here — it cannot be tested from
// WSL without a real device, and guessing at PowerShell that moves his only copy of a photo is not a
// trade worth making. Recorded in QUESTIONS.md instead. The fallbacks below keep that path's
// behaviour exactly as it was.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

const src = readFileSync(join(process.cwd(), 'main-mod', '05-windows-phone.js'), 'utf8');

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const call = (expr) => app.plain(app.get(expr));

const A = { rel: 'DCIM/Camera', name: 'IMG_0001.jpg', size: 100 };
const B = { rel: 'Pictures', name: 'IMG_0001.jpg', size: 200 };

test('⚠⚠ two photos sharing a filename are DIFFERENT items', () => {
  // The property the whole fix rests on.
  const ka = call(`pullKey(${JSON.stringify(A)})`);
  const kb = call(`pullKey(${JSON.stringify(B)})`);
  assert.notEqual(ka, kb, `⚠ same-named photos in different folders must not share an identity — both are ${ka}`);
  // And the same item is stable across calls, or nothing downstream can pair on it.
  assert.equal(call(`pullKey(${JSON.stringify(A)})`), ka, 'stable');
  // Case-insensitively equal, because Windows paths are.
  assert.equal(call(`pullKey({ rel: 'DCIM/Camera', name: 'img_0001.JPG' })`), ka, 'case-folded like the filesystem');
});

test('⚠⚠ merging pull results keeps BOTH photos', () => {
  // Bug 2. Keyed on the bare name, one of these two silently disappeared.
  const first = [
    { status: 'OK', name: 'IMG_0001.jpg', key: 'dcim/camera/img_0001.jpg', dest: 'D:\\t\\IMG_0001.jpg' },
    { status: 'OK', name: 'IMG_0001.jpg', key: 'pictures/img_0001.jpg', dest: 'D:\\t\\IMG_0001 (1).jpg' },
  ];
  const merged = call(`mergePullResults(${JSON.stringify(first)}, [])`);
  assert.equal(merged.length, 2, `⚠ both photos survive the merge — got ${merged.length}`);
  const dests = merged.map((r) => r.dest).sort();
  assert.deepEqual(dests, ['D:\\t\\IMG_0001 (1).jpg', 'D:\\t\\IMG_0001.jpg'], 'each keeps its own real path');
});

test('the MTP retry still wins over the failed ADB attempt for the SAME item', () => {
  // The behaviour mergePullResults exists for (audit #87) must survive the re-keying: a file MTP
  // rescued reports OK, not a phantom loss.
  const merged = call(`mergePullResults(
    [{ status: 'FAIL', name: 'a.jpg', key: 'dcim/a.jpg' }],
    [{ status: 'OK', name: 'a.jpg', key: 'dcim/a.jpg' }]
  )`);
  assert.equal(merged.length, 1, 'still one item, not two');
  assert.equal(merged[0].status, 'OK', 'the later attempt wins');
});

test('⚠ a failed photo is still retried when its same-named twin succeeded', () => {
  // Bug 3. Keyed on the name, B was considered done because A had succeeded.
  const items = [A, B];
  const results = [{ status: 'OK', name: 'IMG_0001.jpg', key: 'dcim/camera/img_0001.jpg' }];
  const retry = call(`adbRetryList(${JSON.stringify(items)}, ${JSON.stringify(results)})`);
  assert.equal(retry.length, 1, `⚠ the photo that failed must get its MTP retry — got ${retry.length}`);
  assert.equal(retry[0].rel, 'Pictures', 'and it is the one that actually failed');
});

test('an MTP result without a key still marks its item done', () => {
  // The compatibility path. MTP results carry names only; treating them as unmatched would re-pull
  // every file over the slow path on every run.
  const retry = call(`adbRetryList(${JSON.stringify([A])}, ${JSON.stringify([{ status: 'OK', name: 'IMG_0001.jpg' }])})`);
  assert.equal(retry.length, 0, 'a name-only OK still counts');
});

test('⚠⚠ the staging loop uses the path the file was ACTUALLY written to', () => {
  // Bug 1, the photo-deleting one. `pullInto` is a local inside the phone:pull handler and the
  // delete only fires against a real device, so this one is pinned against the source.
  const at = src.indexOf('const destByKey = new Map();');
  assert.ok(at > -1, 'the staging loop builds a map of real destinations');
  const block = src.slice(at, at + 2000);
  assert.match(block, /destByKey\.get\(pullKey\(it\)\) \|\| path\.join\(dest, it\.name\)/,
    '⚠ the real destination wins; the derived path is only the MTP fallback');
  // The truncation gate below it must SURVIVE — deleting a genuinely short file is correct and is
  // what stops Tdarr compressing a corrupt clip into the archive. The bug was which file it read,
  // never that it deleted one.
  assert.match(block, /st\.size !== it\.size/, 'the truncation gate still exists');
  assert.match(block, /fsp\.unlink\(p\)/, 'and still removes a genuinely truncated file');
});

test('⚠ the pull records the real destination for every item', () => {
  // Without `dest` on the result there is nothing for destByKey to hold, and the staging loop falls
  // back to the derived path for everything — silently restoring the original bug.
  assert.match(src, /results\.push\(\{ status, name: it\.name, key: pullKey\(it\), dest: destFile \}\)/,
    'status, identity and the real path');
});
