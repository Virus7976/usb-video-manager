// Audit #29 — step-3 "Run" filed footage but recorded NOTHING to the project ledger.
//
// Only the map's "Apply" called ledger:record. The ledger is what lets a later import from the same
// shoot be offered the same project, and the shoot DATE is the strongest signal this app has
// (usb-app-shoots-in-batches) — so filing via Run silently threw away all placement learning. Two
// filing paths disagreeing is exactly the divergence PROMPT.md §2 calls the root of the scariest bugs.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMain } from './harness.mjs';
import { tempDir } from './fixtures.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const ledger = () => app.plain(app.get('config').projectLedger || []);

let dirs = [];
beforeEach(() => {
  dirs = [];
  const cfg = app.get('config');
  cfg.projectLedger = [];
  cfg.lastOrganize = null;
  cfg.lastLedger = null;
});

const mk = (p) => { const d = tempDir(p); dirs.push(d); return d.dir; };

// Run one clip through finalize:run in organize mode, filing it at `rel`.
async function runFinalize(rel, meta, name = 'ski-run.mp4') {
  const src = mk('fin-src-');
  const dest = mk('fin-dest-');
  const file = path.join(src, name);
  fs.writeFileSync(file, 'footage');
  const r = await app.invoke('finalize:run', {
    items: [{ name, path: file, sourcePath: file, rel, meta }],
    organizeDest: dest,
    options: { organize: true, copy: true, embed: false, csv: false },
  });
  return { r, dest };
}

test('#29 filing via Run records the project in the ledger', async () => {
  const { r } = await runFinalize('2026/2026 - Client Work/Acme Shoot', {
    subject: 'acme promo', date: '2026-07-18', location: 'calgary', people: ['josiah'],
  });
  assert.ok(r && r.ok !== false, `the run itself succeeded: ${JSON.stringify(r && r.errors)}`);

  const led = ledger();
  assert.equal(led.length, 1, 'Run recorded a project — this used to be 0');
  assert.equal(led[0].rel, '2026/2026 - Client Work/Acme Shoot');
  assert.equal(led[0].clips, 1);
  // The date is the whole point: it's what matches a later import from the same shoot.
  assert.deepEqual(led[0].dates, ['2026-07-18']);
  assert.deepEqual(led[0].subjects, ['acme promo']);
  assert.deepEqual(led[0].people, ['josiah']);
});

test('#29 Run records the SAME shape Apply does (the two paths agree)', async () => {
  // Apply goes through the ledger:record IPC; Run calls the shared writer directly. If these ever
  // diverge, one filing path learns and the other doesn't — the #29 bug in a new costume.
  await runFinalize('2026/2026 - Personal/Ski Trip', { subject: 'skiing', date: '2026-01-02' });
  const viaRun = ledger()[0];

  app.get('config').projectLedger = [];
  app.get('config').lastLedger = null;
  await app.invoke('ledger:record', {
    entries: [{ rel: '2026/2026 - Personal/Ski Trip', name: 'ski-run.mp4', subject: 'skiing', date: '2026-01-02' }],
  });
  const viaApply = ledger()[0];

  for (const k of ['rel', 'name', 'category', 'clips']) {
    assert.deepEqual(viaRun[k], viaApply[k], `field "${k}" matches across both filing paths`);
  }
  assert.deepEqual(viaRun.dates, viaApply.dates);
  assert.deepEqual(viaRun.subjects, viaApply.subjects);
});

test('#29 a Run-recorded project is UNDOABLE (the #37 delta ordering holds)', async () => {
  // reverseLastLedger only reverses a delta whose ts >= lastOrganize.ts. finalize:run stamps
  // lastOrganize BEFORE recording, so the ordering must come out right — if the record ran first,
  // undo would silently refuse to take it back.
  await runFinalize('2026/2026 - Client Work/One Off', { subject: 'oneoff', date: '2026-07-18' });
  assert.equal(ledger().length, 1);

  const ll = app.get('config').lastLedger;
  const lo = app.get('config').lastOrganize;
  assert.ok(ll && lo && ll.ts >= lo.ts, 'the ledger delta is stamped at or after the run');

  await app.invoke('organize:undo');
  assert.equal(ledger().length, 0, 'undoing the Run also takes back what it taught');
});

test('#29 a run that files nothing records nothing', async () => {
  const dest = mk('fin-empty-');
  await app.invoke('finalize:run', { items: [], organizeDest: dest, options: { organize: true, copy: true, embed: false, csv: false } });
  assert.deepEqual(ledger(), [], 'no phantom project from an empty run');
});
