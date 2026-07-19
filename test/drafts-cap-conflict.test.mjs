// TWO caps on renameDrafts contradicted each other, and the stricter one threw away typed names.
//
// writeDrafts (main-mod/08-finalize-feedback.js) caps at 10000 and is explicit about the rule:
//   "cap generously (users have thousands of clips) and — crucially — NEVER evict a NAMED draft to
//    make room for a flag-only one."
// It sorts named-first, then most-recent.
//
// The boot "slim" block (main-mod/01-core.js) caps the SAME store at 1000, sorted by `ts` ONLY. So a
// recent flag-only write — a `facesScanned` or `selected` update, which every scan produces — evicts
// an older HAND-TYPED name. Ten times stricter, and with the one rule that mattered inverted.
//
// It is not theoretical. `renameDrafts` is NOT in LAZY_STORES, so loadStores() has already read
// drafts.json into config.renameDrafts before the slim runs; the truncation is in-memory, and
// freshStore() only re-reads when the file's mtime/size differ from OUR last write — which they do
// not, because boot recorded them. So currentDrafts() returns the truncated map and the next
// drafts:save persists 1000 entries over the original file. The owner has ~4600 clips on one card.
//
// Second, separate bug in the same function: the 60-day AGE filter also evicts named drafts. Its
// sibling finalMeta:save deliberately exempts unconsumed work from its age filter —
//   "An entry is only evictable once finalize:run has actually FILED that clip. Anything still
//    pending is unconsumed user work and is kept regardless of age."
// — and 01-core.js states the intended contract for drafts outright: "Drafts are only removed by
// drafts:clear (when the footage is copied)." A card named but left uncopied for two months lost
// those names, and the prune runs on EVERY writeDrafts call, so editing one clip today deleted
// other clips' older names.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const DAY = 24 * 3600 * 1000;
const named = (ts) => ({ subject: 'mowing', description: 'front lawn', ts });
const flagOnly = (ts) => ({ subject: '', description: '', facesScanned: true, ts });

test('the boot slim keeps NAMED drafts over newer flag-only ones', () => {
  // BEHAVIOURAL, not source-shape: seed drafts.json OVER the cap and let the real boot slim run on
  // it, because the slim is top-level bundle code that executes during load. An earlier version of
  // this test asserted the old sort expression was absent from the source, and it stayed green when
  // the named-first rule was disabled — passing for the wrong reason. This one cannot.
  const base = mkdtempSync(join(tmpdir(), 'uvd-drafts-'));
  const storeDir = join(base, 'USB SD Auto-Action');
  mkdirSync(storeDir, { recursive: true });

  // 10 named drafts, all OLD, plus enough newer flag-only records to blow past the cap. Sorted by
  // `ts` alone the named ones are last and every one of them is dropped.
  const drafts = {};
  for (let i = 0; i < 10; i++) drafts[`typed-${i}.mp4__1__${i}`] = named(1000 + i);
  for (let i = 0; i < 10600; i++) drafts[`scan-${i}.mp4__2__${i}`] = flagOnly(9e12 + i);
  writeFileSync(join(storeDir, 'drafts.json'), JSON.stringify(drafts));
  writeFileSync(join(storeDir, 'config.json'), JSON.stringify({ intakeFolder: '/x' }));

  let booted;
  try {
    booted = loadMain({ userData: base });
    const kept = booted.get('config').renameDrafts;
    assert.ok(Object.keys(kept).length <= 10000, 'the slim did cap the store');
    for (let i = 0; i < 10; i++) {
      assert.ok(kept[`typed-${i}.mp4__1__${i}`], `the hand-typed name typed-${i} survived the boot slim`);
    }
  } finally {
    try { booted && booted.dispose(); } catch { /* ignore */ }
    rmSync(base, { recursive: true, force: true });
  }
});

test('a NAMED draft survives a writeDrafts prune even when it is older than the age limit', async () => {
  // writeDrafts stamps `ts: now` on everything it SAVES, so an old fixture has to be planted
  // directly into the store; the prune then runs when an UNRELATED clip is saved. That is exactly
  // the real scenario: editing one clip today must not delete another clip's older name.
  const old = Date.now() - (100 * DAY);
  app.get('config').renameDrafts = {
    'ancient-named.mp4__1__1': { subject: 'mowing', description: 'front lawn', ts: old },
    'ancient-flag.mp4__3__3': { subject: '', description: '', facesScanned: true, ts: old },
  };
  await app.invoke('drafts:save', { 'unrelated.mp4__9__9': { subject: 'today', description: '' } });
  const back = app.plain(await app.invoke('drafts:get'));
  assert.ok(back['ancient-named.mp4__1__1'], 'a typed name is unconsumed work — age alone must not evict it');
  assert.equal(back['ancient-named.mp4__1__1'].subject, 'mowing', 'and it is intact');
});

test('an OLD flag-only draft is still pruned — the store must not grow forever', async () => {
  // The age filter still has a job: shedding records that carry no user work. Same planted state as
  // above, checked in the same pass.
  const back = app.plain(await app.invoke('drafts:get'));
  assert.ok(!back['ancient-flag.mp4__3__3'], 'nothing typed here, so it is safe to shed');
});

test('there is exactly ONE renameDrafts cap, shared by both sites', async () => {
  // 1000 vs 10000 meant every boot silently truncated what the previous session had deliberately
  // kept. The fix is not "make the two numbers match" — two numbers drift again. There must be ONE
  // declaration, and both the boot slim and writeDrafts must go through it.
  const core = readFileSync(join(process.cwd(), 'main-mod', '01-core.js'), 'utf8');
  const fin = readFileSync(join(process.cwd(), 'main-mod', '08-finalize-feedback.js'), 'utf8');

  const decls = (core + fin).match(/(?:const|let|var)\s+DRAFTS_CAP\s*=/g) || [];
  assert.equal(decls.length, 1, 'exactly one declaration of the cap, not one per file');

  // Both capping sites must USE it. Slicing to the end of each block, never a fixed window.
  const slim = core.slice(core.indexOf('config.renameDrafts && typeof config.renameDrafts'));
  assert.ok(/ents\.length > DRAFTS_CAP/.test(slim.slice(0, slim.indexOf('\n}'))), 'the boot slim caps via DRAFTS_CAP');
  assert.ok(/entries\.length > DRAFTS_CAP/.test(fin), 'writeDrafts caps via DRAFTS_CAP');

  // And the literal the old boot slim used is gone from the drafts path entirely.
  assert.ok(!/ents\.length > 1000/.test(core), 'no bare 1000 left capping drafts');
});
