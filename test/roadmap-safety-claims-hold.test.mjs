// Spot-check of FEATURES.md's safety-critical `done` claims — by probe, not by reading.
//
// Three roadmap entries have already turned out wrong this session: item 84 ("dead" — the capability
// works two ways), item 89's ffmpeg check ("unreachable" — it is a sibling, not nested), and the
// file's headline premise about competing subjects (they live in drafts, not the folder Organize
// scans). A roadmap that misreports sends every future session at the wrong problem, so the entries
// where being wrong is expensive deserve a probe rather than trust.
//
// ⚠ THE RESULT HERE IS THE OPPOSITE, AND THAT MATTERS TOO: these three hold. Item 21's delete gate
// and item 24's re-import guard are correct, and item 24 is better than its one-line description.
// "The roadmap is unreliable" would have been an over-correction from three bad entries.
//
// ⚠⚠ IT TOOK THREE WRONG PROBES TO LEARN THAT. Checking item 24 I first seeded `config.imports`
// (not the mechanism), then read `scan:videos` for a flag the RENDERER adds, then called
// `copied:record` without `source` — which the handler silently filters on. Each wrong probe
// produced an empty result that read exactly like a missing feature. The control is what separates
// "this is broken" from "I asked wrongly", and all three tests below start from one.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let base;
before(() => { app = loadMain(); });
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  base = mkdtempSync(join(tmpdir(), 'roadmap-'));
  app.get('config').copiedLog = {};
});

// --- item 21: delete from the card ONLY after re-verifying each pair ----------------------------

test('⚠⚠⚠ #21 the delete gate passes a true pair and FAILS a mismatched one', async () => {
  // The one irreversible act in this app. A gate that cannot fail is the worst possible bug here,
  // so both directions are asserted — a gate that always passes would satisfy half of this test.
  const a = join(base, 'a.mp4'); const b = join(base, 'b.mp4');
  writeFileSync(a, 'IDENTICAL-BYTES'); writeFileSync(b, 'IDENTICAL-BYTES');
  const same = await app.call('verifyCopyPair', a, b);
  assert.ok(same === true || (same && same.ok), '⚠ a real copy verifies');

  writeFileSync(b, 'DIFFERENT-BYTES-ENTIRELY');
  const diff = await app.call('verifyCopyPair', a, b);
  assert.ok(!(diff === true || (diff && diff.ok)),
    '⚠⚠⚠ a mismatched pair must NOT verify — this is what stands between him and deleted footage');
});

// --- item 24: never re-import a clip already imported -------------------------------------------

const KEY = 'GX010001.MP4__64__1700000000';
const record = async (dest) => app.invoke('copied:record', [{
  key: KEY, source: '/card/GX010001.MP4', dest, name: 'GX010001.MP4',
}]);
const known = async () => app.plain(await app.invoke('copied:get', [KEY]));

test('⚠ CONTROL — a clip that was never copied is not known', async () => {
  assert.deepEqual(await known(), {}, '⚠ nothing is claimed before anything happens');
});

test('⚠⚠ #24 a copied clip IS remembered, so it is not pulled twice', async () => {
  const intake = join(base, 'intake'); mkdirSync(intake, { recursive: true });
  const landed = join(intake, 'GX010001.MP4'); writeFileSync(landed, 'x'.repeat(64));
  await record(landed);
  const got = await known();
  assert.ok(got[KEY], '⚠⚠ the clip is recognised on the next scan');
  assert.equal(got[KEY].dest, landed, 'and it says where the copy went');
});

test('⚠⚠ #24 a record whose copy was DELETED is forgotten', async () => {
  // Better than the roadmap line describes, and worth pinning: if he deletes the imported copy, the
  // app must not keep insisting the clip is already imported. Otherwise a deleted import becomes
  // permanently un-re-importable, and the card is the only place the footage still exists.
  const intake = join(base, 'intake'); mkdirSync(intake, { recursive: true });
  const landed = join(intake, 'GX010001.MP4'); writeFileSync(landed, 'x'.repeat(64));
  await record(landed);
  assert.ok((await known())[KEY], 'setup: it is remembered while the copy exists');

  rmSync(landed, { force: true });
  assert.deepEqual(await known(), {},
    '⚠⚠ with the copy gone the claim is dropped — he can import it again');
});
