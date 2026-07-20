// The test that would have caught the bug I shipped and reverted on 2026-07-20am.
//
// I added a rung to the destination ladder that filed a clip into the project he put the same shoot
// in last time. It passed 8 unit tests. Then filing his real 309 clips TWICE produced:
//
//     2026-06-01_vlog_josiah-talking-head_v1.mp4
//         run 1 → vlog/2026-06-01
//         run 2 → 2026/2026 - Client Work/Gourgess Lawns
//
// **A personal vlog filed into a client job**, because on that date he shot both a lawn job and a
// vlog, and filing the lawn clips taught the ledger that the date belonged to that project.
//
// Two properties failed at once, and neither had a permanent test:
//
//   1. **IDEMPOTENCE.** Filing writes the ledger; the ledger changed where the next run filed. A
//      feedback loop in which re-running keeps moving his footage. Re-running is something the app
//      actively invites — the Organize screen lists filed clips again, and "re-running is safe" is
//      written on its confirm dialog.
//   2. **NO CROSS-CONTAMINATION.** Two shoots on one day must stay in two places. This is a normal
//      day for him, not an edge case.
//
// My unit fixture could not fail this way: it compared "birthday" against "lawnmowing" — ZERO
// overlap. **Real days overlap partially.** So this fixture is deliberately built the way his card
// actually looks: one date, two subjects, an overlapping person, and a standing rule that claims only
// one of them.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

// One real day, exactly as his 2026-06-01 looked: a client lawn job AND a personal vlog, with Liam in
// both, and a rule that claims the lawn work only.
const A_REAL_DAY = [
  '2026-06-01_lawn-mowing_dennis-front-yard_v1.mp4',
  '2026-06-01_lawn-mowing_dennis-back-yard_v1.mp4',
  // ⚠ THE CLIP THAT MAKES THIS FIXTURE REAL, and the one my first version lacked.
  //
  // His rule matches on subject + location + DESCRIPTION. So a clip whose subject is "vlog" but whose
  // description mentions the lawn is routed into the client project — and the ledger then records
  // that project as containing the subject **"vlog"**. That is the bridge: from then on, every vlog
  // sharing that date "overlaps" the client job and a ledger rung drags it in.
  //
  // Without this one filename the fixture cannot reproduce the failure at all — I proved that by
  // re-applying the reverted rung and watching all six tests stay green (2026-07-20an).
  '2026-06-01_vlog_dennis-lawn-tour_v1.mp4',
  '2026-06-01_vlog_josiah-talking-head_v1.mp4',
  '2026-06-01_vlog_josiah-grab-bag_v1.mp4',
  '2026-06-02_timelapse_sunrise_v1.mp4',
];
const HIS_RULE = [{
  id: 'r1', name: 'Lawn care (Gourgess Lawns)', kind: 'route',
  match: ['lawn', 'lawn-mowing', 'lawnmowing', 'mowing'], byDay: true,
  dest: '2026/2026 - Client Work/Gourgess Lawns',
}];

let box;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'uvd-idem-'));
  const dir = join(base, 'Compressed');
  const dest = join(base, 'Projects');
  mkdirSync(dir, { recursive: true });
  mkdirSync(dest, { recursive: true });
  for (const n of A_REAL_DAY) writeFileSync(join(dir, n), `FOOTAGE ${n}`);
  const cfg = app.get('config');
  cfg.projectsRoot = dest; cfg.finalMeta = {}; cfg.projectLedger = [];
  cfg.ai = cfg.ai || {};
  cfg.ai.routes = JSON.parse(JSON.stringify(HIS_RULE));
  box = { base, dir, dest, cleanup: () => rmSync(base, { recursive: true, force: true }) };
});

const fileEverything = async () => {
  const scan = await app.invoke('finalize:scan', { dir: box.dir });
  const items = Array.from(scan.files).map((f) => ({ ...f }));
  const s = await app.invoke('finalize:run', {
    dir: box.dir, items,
    options: { embed: false, csv: false, organize: true, nas: false, copy: true },
    organizeDest: box.dest, folderLevels: ['category', 'project'], nasPath: '',
  });
  const placed = {};
  for (const x of Array.from(s.filedRels || [])) placed[String(x.name)] = String(x.rel);
  return { moved: s.moved, skipped: s.skipped, placed };
};
const treeFiles = () => {
  const out = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), r); else out.push(r);
    }
  };
  walk(box.dest, '');
  return out.sort();
};

test('⚠⚠ filing the same folder TWICE moves nothing the second time', async () => {
  // The property that broke. Re-running is invited by the app itself — the Organize screen lists
  // filed clips again and its confirm dialog says re-running is safe.
  try {
    const first = await fileEverything();
    assert.equal(first.moved, A_REAL_DAY.length, 'everything filed on the first pass');
    const after1 = treeFiles();

    const second = await fileEverything();
    assert.equal(second.moved, 0, `⚠ the second run moves nothing — it moved ${second.moved}`);
    assert.deepEqual(treeFiles(), after1, 'and the tree is byte-for-byte the same set of files');
  } finally { box.cleanup(); }
});

test('⚠⚠ two shoots on ONE day stay in two places', async () => {
  // The contamination case, built the way his real day is built rather than the way a guard is
  // shaped: same date, same person, different work, one rule claiming half of it.
  try {
    const { placed } = await fileEverything();
    const lawn = placed['2026-06-01_lawn-mowing_dennis-front-yard_v1.mp4'];
    const vlog = placed['2026-06-01_vlog_josiah-talking-head_v1.mp4'];
    assert.match(lawn, /Gourgess Lawns/, `the client work goes to the client project — got ${lawn}`);
    assert.doesNotMatch(vlog, /Gourgess Lawns/,
      `⚠ his personal vlog must NOT land in a client job — got ${vlog}`);
  } finally { box.cleanup(); }
});

test('⚠ and they STILL stay apart on the second run', async () => {
  // The reverted bug only appeared on run 2, once filing had taught the ledger about that date. A
  // single-run test cannot see it — which is exactly why the first version of this shipped broken.
  try {
    await fileEverything();
    const { placed } = await fileEverything();
    for (const [name, rel] of Object.entries(placed)) {
      if (!/_vlog_/.test(name)) continue;
      assert.doesNotMatch(rel, /Gourgess Lawns/, `⚠ ${name} drifted into a client job on run 2 — ${rel}`);
    }
  } finally { box.cleanup(); }
});

test('filing does not multiply the files on disk', async () => {
  // The plainest statement of the same property: N clips in, N clips out, however many times he runs.
  try {
    await fileEverything();
    await fileEverything();
    await fileEverything();
    const vids = treeFiles().filter((f) => /\.mp4$/i.test(f));
    assert.equal(vids.length, A_REAL_DAY.length,
      `three runs, still ${A_REAL_DAY.length} clips — got ${vids.length}: ${JSON.stringify(vids)}`);
  } finally { box.cleanup(); }
});

test('⚠ a clip keeps the SAME destination across runs', async () => {
  // Idempotence is not just "nothing moved" — it is "the answer did not change". A ladder whose
  // output depends on what previous runs wrote is a ladder that can never settle.
  try {
    const first = await fileEverything();
    app.get('config').finalMeta = {};          // force a fresh scan path, not a cached verdict
    const scan = await app.invoke('finalize:scan', { dir: box.dir });
    const preview = app.plain(await app.invoke('organize:previewDest', {
      items: Array.from(scan.files).map((f) => ({ name: f.name, sourcePath: f.sourcePath, meta: f.meta || {} })),
      folderLevels: ['category', 'project'],
    }));
    for (const d of preview.dests) {
      const was = first.placed[d.name];
      if (!was) continue;
      assert.equal(d.rel, was, `⚠ ${d.name}: filed to "${was}" but now predicted "${d.rel}"`);
    }
  } finally { box.cleanup(); }
});

test('the ledger still learns from the run — it just does not redirect it', async () => {
  // Guard the other direction. The fix for the reverted bug must not be "stop recording", because the
  // ledger is what makes "same shoot → same project" possible at all.
  try {
    await fileEverything();
    const led = app.plain(app.get('config').projectLedger) || [];
    assert.ok(led.length >= 2, `it learned the projects — got ${led.length}`);
    assert.ok(led.some((p) => /Gourgess Lawns/.test(String(p.rel))), 'including the client job');
  } finally { box.cleanup(); }
});
