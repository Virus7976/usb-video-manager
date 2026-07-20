// `backfillLedgerFromTree` is fully built, tested, has an IPC handler AND a preload bridge — and
// **nothing calls it**. The repo's own reachability test pins it in `KNOWN_UNUSED`.
//
// Its header says exactly what it is for: *"The ledger is only written AFTER this app files a clip.
// So for anyone with an existing library — say 200 projects filed by hand over years — it is
// completely empty… This reads what is ALREADY on disk and builds the memory that should have been
// there."*
//
// That is his situation precisely, and the numbers are not small:
//
//     C:\Users\jakeg\Videos\02 - Projects\2026
//        2026 - Client Work    1194 files
//        2026 - Personal         60
//        2026 - Social Media    100
//        ------------------------------
//        1354 clips already filed by hand — and a project ledger of ZERO.
//
// Everything downstream of the ledger is therefore dead for him: `ledgerMatch` opens with
// `if (!ledgerCache.length) return null;` so obvious repeats never file themselves, the same-shoot
// offer stays quiet, and `search_projects` finds nothing. The answer has been sitting on his disk the
// whole time, next to a tested one-shot importer with no button.
//
// SECOND DEFECT, and it would have made wiring it up pointless: `backfillLedgerFromTree` ends with
// `saveConfig()` alone. `projectLedger` is a SIDECAR store, and `saveConfig()` runs
// `stripStoresForWrite()`, which deletes every key whose sidecar exists on disk. The entire import
// would vanish on restart. Every other ledger writer pairs `saveStore('projectLedger')` with
// `saveConfig()`; this one didn't.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

let box;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'uvd-backfill-'));
  const root = join(base, '2026');
  mkdirSync(join(root, '2026 - Client Work'), { recursive: true });
  for (const n of ['2026-03-14_vlog_a_v1.mp4', '2026-03-14_vlog_b_v1.mp4']) {
    writeFileSync(join(root, '2026 - Client Work', n), 'FOOTAGE');
  }
  const cfg = app.get('config');
  cfg.projectsRoot = root;
  cfg.projectLedger = [];
  box = { base, root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
});

test('an empty ledger beside a filled Projects tree is reported as a problem', async () => {
  // The health card is where this app already detects a problem and offers a one-click fix. An
  // importer with no button is not a feature.
  try {
    const h = await app.invoke('ai:health');
    const p = ((h && h.problems) || []).find((x) => x && x.id === 'no-ledger');
    assert.ok(p, `the empty ledger is surfaced — got ${JSON.stringify(((h && h.problems) || []).map((x) => x.id))}`);
    assert.equal(p.fix, 'backfillLedger', 'and it offers the importer');
  } finally { box.cleanup(); }
});

test('it is NOT reported once the ledger has entries', async () => {
  // Guard the other direction: this must not nag forever.
  try {
    app.get('config').projectLedger = [{ id: 'p1', rel: 'x', name: 'x', clips: 1, clipNames: ['a.mp4'], dates: [], subjects: [], locations: [], people: [], samples: [], firstSeen: 1, lastSeen: 1 }];
    const h = await app.invoke('ai:health');
    const p = ((h && h.problems) || []).find((x) => x && x.id === 'no-ledger');
    assert.equal(p, undefined, 'nothing to fix once it has learned something');
  } finally { box.cleanup(); }
});

test('it is not reported when there is no Projects tree to read', async () => {
  try {
    app.get('config').projectsRoot = '';
    const h = await app.invoke('ai:health');
    const p = ((h && h.problems) || []).find((x) => x && x.id === 'no-ledger');
    assert.equal(p, undefined, 'no tree, nothing to import — a different problem already covers that');
  } finally { box.cleanup(); }
});

test('the import actually reads the tree into the ledger', async () => {
  try {
    const r = await app.invoke('ai:backfillLedger');
    assert.ok(r && r.ok, `the import ran: ${JSON.stringify(r)}`);
    const led = app.plain(app.get('config').projectLedger) || [];
    assert.ok(led.length >= 1, `it learned at least one project — got ${led.length}`);
    assert.ok(led.some((p) => String(p.rel || '').includes('Client Work')), 'including his real folder');
  } finally { box.cleanup(); }
});

test('⚠ the import SURVIVES a restart — it is written to the sidecar, not just config', async () => {
  // The defect that would have made wiring it up pointless. projectLedger is a sidecar store, and
  // saveConfig() strips every key whose sidecar exists — so a config-only save discards the whole
  // import silently at the next launch.
  try {
    let sawSave = false;
    const real = app.get('saveStore');
    app.get('__savedStores = [];');
    app.get('saveStore = function (k) { __savedStores.push(k); return __realSaveStore(k); };');
    app.get(`__realSaveStore = ${String(real)}`);
    await app.invoke('ai:backfillLedger');
    const saved = app.plain(app.get('__savedStores')) || [];
    sawSave = saved.includes('projectLedger');
    app.get(`saveStore = ${String(real)}`);
    assert.equal(sawSave, true, `the sidecar was written — saveStore calls were ${JSON.stringify(saved)}`);
  } finally { box.cleanup(); }
});

test('the renderer can actually trigger it', async () => {
  const { readFileSync } = await import('node:fs');
  const core = readFileSync(join(process.cwd(), 'src', 'mod', '01-core.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.match(core, /p\.fix === 'backfillLedger'/, 'the health card dispatches the fix');
  assert.match(core, /aiBackfillLedger\(/, 'and calls the bridge that was never called');
});
