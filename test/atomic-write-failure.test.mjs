// What happens when a store write FAILS halfway had no test.
//
// Four test files call `writeJsonAtomic`, and one stubs it out to simulate ENOSPC — but nothing
// exercises the function's own failure path. That path is the reason it exists. `saveStore` writes
// ~10 JSON files that hold everything the app has ever learned: 4594 drafts, 48 enrolled people, 458
// pending faces, the project ledger. None of it is regenerable — re-scanning a card cannot recover a
// name he typed or a face he confirmed.
//
// The whole point of write-temp → fsync → rename is that a failure at ANY stage leaves the previous
// file untouched, because the rename is the only step that replaces it. The two things that must be
// true after a failed write:
//
//   1. the OLD store is still there, intact and parseable;
//   2. no `.tmp` litter is left behind (it accumulates in %APPDATA% forever otherwise).
//
// A disk full mid-write is the realistic trigger — his intake is a nearly-full drive, which is why
// the app already has free-space checks elsewhere.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const GOOD = { drafts: { 'a.mp4__1__1': { subject: 'liam', description: 'skate park' } }, version: 1 };

let box;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'uvd-atomic-'));
  const file = join(dir, 'drafts.json');
  writeFileSync(file, JSON.stringify(GOOD, null, 2));
  box = { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
});

// Fail one specific fs call, leaving everything else real — a blanket stub would change which stage
// of the write is being tested (the lesson from 2026-07-20d).
const failing = async (method, fn) => {
  app.get(`__realFsCall = fs.${method}`);
  app.get(`fs.${method} = function () { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; };`);
  try { return await fn(); } finally { app.get(`fs.${method} = __realFsCall`); }
};

const tmps = () => readdirSync(box.dir).filter((n) => n.endsWith('.tmp'));

test('⚠ a write that fails at fsync leaves the OLD store intact', async () => {
  try {
    let threw = null;
    await failing('fsyncSync', async () => {
      try { app.get('writeJsonAtomic')(box.file, { drafts: {}, wiped: true }); }
      catch (e) { threw = e; }
    });
    assert.ok(threw, 'the failure is reported, not swallowed');
    const back = JSON.parse(readFileSync(box.file, 'utf8'));
    assert.deepEqual(back, GOOD, '⚠ his 4594 drafts are still exactly what they were');
  } finally { box.cleanup(); }
});

test('⚠ and it leaves no .tmp litter behind', async () => {
  // These live in %APPDATA% and nothing else ever cleans them up.
  try {
    await failing('fsyncSync', async () => {
      try { app.get('writeJsonAtomic')(box.file, { drafts: {} }); } catch { /* expected */ }
    });
    assert.deepEqual(tmps(), [], `no temp files left — got ${JSON.stringify(readdirSync(box.dir))}`);
  } finally { box.cleanup(); }
});

test('a write that fails at the WRITE stage is equally safe', async () => {
  // Earlier stage, same two guarantees — the cleanup is in a catch that covers write, fsync and
  // rename alike, which its comment says explicitly ("not just rename").
  try {
    await failing('writeSync', async () => {
      try { app.get('writeJsonAtomic')(box.file, { drafts: {} }); } catch { /* expected */ }
    });
    assert.deepEqual(JSON.parse(readFileSync(box.file, 'utf8')), GOOD, 'old store intact');
    assert.deepEqual(tmps(), [], 'no temp left');
  } finally { box.cleanup(); }
});

test('a write that fails at the RENAME is equally safe', async () => {
  // The last stage, and the only one that would otherwise have replaced the file.
  try {
    await failing('renameSync', async () => {
      try { app.get('writeJsonAtomic')(box.file, { drafts: {} }); } catch { /* expected */ }
    });
    assert.deepEqual(JSON.parse(readFileSync(box.file, 'utf8')), GOOD, 'old store intact');
    assert.deepEqual(tmps(), [], 'no temp left');
  } finally { box.cleanup(); }
});

test('a SUCCESSFUL write really replaces the file', async () => {
  // The other direction: a guard that never lets anything through would be worse than the bug.
  try {
    const next = { drafts: { 'b.mp4__2__2': { subject: 'vlog' } }, version: 2 };
    app.get('writeJsonAtomic')(box.file, next);
    assert.deepEqual(JSON.parse(readFileSync(box.file, 'utf8')), next, 'the new data is there');
    assert.deepEqual(tmps(), [], 'and no temp remains after success either');
  } finally { box.cleanup(); }
});

test('writing a store that did not exist yet still works', async () => {
  // First run on a fresh machine: there is no old file to preserve, and the failure path must not
  // depend on one existing.
  try {
    const fresh = join(box.dir, 'people.json');
    app.get('writeJsonAtomic')(fresh, { people: [] });
    assert.equal(existsSync(fresh), true, 'created');
    let threw = null;
    await failing('fsyncSync', async () => {
      const another = join(box.dir, 'faces.json');
      try { app.get('writeJsonAtomic')(another, { x: 1 }); } catch (e) { threw = e; }
      assert.equal(existsSync(another), false, 'a failed first write leaves no half-file');
    });
    assert.ok(threw, 'and still reports the failure');
    assert.deepEqual(tmps(), [], 'no temp left');
  } finally { box.cleanup(); }
});

test('two concurrent writers use different temp names', async () => {
  // The unique-temp-name rule, stated in the code as "so two concurrent writers can't clobber a
  // shared <file>.tmp and corrupt each other's output". Verified by watching the names actually used
  // rather than by reading the counter.
  try {
    const seen = [];
    app.get('__realOpen = fs.openSync');
    app.get(`fs.openSync = function (p, ...rest) { if (String(p).endsWith('.tmp')) __seenTmp.push(String(p)); return __realOpen(p, ...rest); };`);
    app.get('__seenTmp = []');
    try {
      app.get('writeJsonAtomic')(box.file, { n: 1 });
      app.get('writeJsonAtomic')(box.file, { n: 2 });
      seen.push(...(app.plain(app.get('__seenTmp')) || []));
    } finally { app.get('fs.openSync = __realOpen'); }
    assert.equal(seen.length, 2, `two temp files were opened — got ${JSON.stringify(seen)}`);
    assert.notEqual(seen[0], seen[1], `and they had different names — got ${JSON.stringify(seen)}`);
  } finally { box.cleanup(); }
});
