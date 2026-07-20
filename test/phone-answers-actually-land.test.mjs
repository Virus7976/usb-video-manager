// THE ROUND TRIP CLOSES: an answer given on the phone is applied by the desktop.
//
// The phone appends an instruction to phone-actions.jsonl; this exercises the other half — the
// desktop reading it and applying it through its OWN handlers, in the process that owns those files.
//
// Two design flaws from the first cut are fixed here and pinned below, because both would have caused
// exactly the bugs already fixed in the desktop app:
//
//   ⚠⚠ THE CLUSTER ID WAS AN ARRAY INDEX. Only meaningful for the exact list that produced it — the
//      desktop merges new clusters into the store on every scan, so index 7 this evening is a
//      different face tomorrow. A queued answer would have confirmed the WRONG person. It is now the
//      crop filename, which is unique per cluster and never rewritten in place.
//
//   ⚠⚠ MARKING AN ACTION APPLIED REWROTE THE QUEUE FILE. That is a read-modify-write on the very file
//      the server appends to — a phone answer arriving mid-rewrite would be silently dropped. Both
//      sides now only ever APPEND; applied-ness is a marker line that `read` folds in.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { loadMain } from './harness.mjs';

const require = createRequire(join(process.cwd(), 'main.js'));
const queue = require('./core/action-queue');

let app; let dir;

const CROP_A = 'aaa111.jpg';
const CROP_B = 'bbb222.jpg';

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'uvd-land-'));
  app = loadMain({ userData: dir });
});
after(() => { try { app.dispose(); } catch { /* ignore */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

// STORE_DIR nests one level under appData — the same shape the app itself uses.
const storeDir = () => join(dir, 'USB SD Auto-Action');

beforeEach(() => {
  mkdirSync(storeDir(), { recursive: true });
  try { rmSync(join(storeDir(), queue.QUEUE_FILE), { force: true }); } catch { /* ignore */ }
  const cfg = app.get('config');
  cfg.ai = cfg.ai || {};
  cfg.ai.people = [];
  cfg.ai.facesPending = [
    { thumb: `file:///C:/x/faces/${CROP_A}`, descriptor: [0.1, 0.2], descriptors: [[0.1, 0.2]], clipKeys: ['k1'], suggest: { name: 'Josiah', dist: 0.3 } },
    { thumb: `file:///C:/x/faces/${CROP_B}`, descriptor: [0.9, 0.8], descriptors: [[0.9, 0.8]], clipKeys: ['k2'], suggest: null },
  ];
});

const queueIt = (action) => queue.append(action, { dir: storeDir(), at: Date.now(), source: 'phone' });

test('⚠⚠ confirming on the phone enrols the person on the desktop', async () => {
  queueIt({ type: 'face.confirm', clusterId: CROP_A, name: 'Josiah' });
  const r = app.plain(await app.invoke('phone:applyQueue'));
  assert.equal(r.ok, true);
  assert.equal(r.applied, 1, `one answer landed — got ${r.applied}`);
  const people = app.plain(app.get('config.ai.people'));
  assert.equal(people.length, 1, 'the person now exists');
  assert.equal(people[0].name, 'Josiah');
  const pending = app.plain(app.get('config.ai.facesPending'));
  assert.equal(pending[0].done, true, 'and the cluster is answered, so it stops being offered');
  assert.equal(pending[0].assignedName, 'Josiah');
});

test('⚠⚠ it enrols through the SAME function the desktop review uses', async () => {
  // Not a second enrolment path. savePersonRecord was extracted from the people:save handler
  // precisely so both go through one implementation — a twin would drift, which is the failure this
  // codebase produces most often.
  const src = readFileSync(join(process.cwd(), 'main-mod', '11-phone-queue.js'), 'utf8');
  assert.match(src, /const saved = savePersonRecord\(\{/, 'the consumer calls the shared function');
  const fb = readFileSync(join(process.cwd(), 'main-mod', '08-finalize-feedback.js'), 'utf8');
  assert.match(fb, /function savePersonRecord\(payload\) \{/, 'which is a real function…');
  assert.match(fb, /ipcMain\.handle\('people:save', \(_e, payload\) => savePersonRecord\(payload\)\);/,
    '…and the handler is a one-line adapter over it, so there is no second path');
});

test('reject and skip are applied too, and do not enrol anyone', async () => {
  queueIt({ type: 'face.reject', clusterId: CROP_A });
  queueIt({ type: 'face.skip', clusterId: CROP_B });
  const r = app.plain(await app.invoke('phone:applyQueue'));
  assert.equal(r.applied, 2);
  const pending = app.plain(app.get('config.ai.facesPending'));
  assert.equal(pending[0].rejected, true);
  assert.equal(pending[1].skipped, true);
  assert.equal(app.plain(app.get('config.ai.people')).length, 0, 'nobody was enrolled');
});

test('⚠⚠ an applied answer is not applied TWICE', async () => {
  // Without the marker it would re-enrol on every launch, growing the person's face list forever.
  queueIt({ type: 'face.confirm', clusterId: CROP_A, name: 'Josiah' });
  assert.equal(app.plain(await app.invoke('phone:applyQueue')).applied, 1);
  const second = app.plain(await app.invoke('phone:applyQueue'));
  assert.equal(second.nothingToDo, true, `⚠ the queue is empty the second time — got ${JSON.stringify(second)}`);
  assert.equal(app.plain(app.get('config.ai.people')).length, 1, 'and the person was not enrolled twice');
});

test('⚠⚠ marking applied APPENDS — it never rewrites the queue file', async () => {
  // A rewrite would race the server, which is appending to the same file. The whole point of the
  // split is that neither side can lose the other's writes.
  queueIt({ type: 'face.confirm', clusterId: CROP_A, name: 'Josiah' });
  const before = readFileSync(join(storeDir(), queue.QUEUE_FILE), 'utf8');
  await app.invoke('phone:applyQueue');
  const after = readFileSync(join(storeDir(), queue.QUEUE_FILE), 'utf8');
  assert.ok(after.startsWith(before), '⚠ every earlier byte is untouched — the marker is appended');
  assert.ok(after.length > before.length, 'and something was added');
  assert.match(after.slice(before.length), /"type":"_applied"/, 'namely an applied marker');
});

test('⚠ an answer for a cluster that is GONE is not retried forever', async () => {
  // The commonest real case: he answered it at the PC before the queue was applied.
  queueIt({ type: 'face.confirm', clusterId: 'nolongerhere.jpg', name: 'Josiah' });
  const r = app.plain(await app.invoke('phone:applyQueue'));
  assert.equal(r.ok, true);
  assert.match(r.results[0].note || '', /already handled/, 'it is reported, not silently dropped');
  assert.equal(app.plain(await app.invoke('phone:applyQueue')).nothingToDo, true, 'and it stops being offered');
});

test('⚠⚠ an action this build does not understand is KEPT, not dropped', async () => {
  // A newer phone client can be ahead of an older desktop. Marking an unknown action applied would
  // silently discard his answer.
  writeFileSync(join(storeDir(), queue.QUEUE_FILE),
    `${JSON.stringify({ id: 'x1', at: Date.now(), type: 'face.tagLocation', clusterId: CROP_A })}\n`, 'utf8');
  const r = app.plain(await app.invoke('phone:applyQueue'));
  assert.equal(r.results[0].ok, false);
  assert.match(r.results[0].error, /not supported/);
  assert.equal(queue.read({ dir: storeDir() }).length, 1, '⚠ it is still queued for a newer build');
});

test('⚠⚠ nothing is applied when the face store could not be READ', async () => {
  // An unreadable faces-pending.json leaves an empty default in memory. Applying against that would
  // write a store containing only what the phone happened to mention — i.e. delete the review. And
  // crucially the answers must NOT be marked applied, or they are lost along with it.
  queueIt({ type: 'face.confirm', clusterId: CROP_A, name: 'Josiah' });
  app.get('storeReadFailed')['ai.facesPending'] = true;
  const r = app.plain(await app.invoke('phone:applyQueue'));
  app.get('storeReadFailed')['ai.facesPending'] = false;
  assert.equal(r.ok, false, 'it refuses');
  assert.match(r.error, /could not be read/i, 'and says why');
  assert.equal(queue.read({ dir: storeDir() }).length, 1, '⚠ the answer survives for the next launch');
});

test('the waiting count is reported for a badge', async () => {
  queueIt({ type: 'face.skip', clusterId: CROP_A });
  queueIt({ type: 'face.skip', clusterId: CROP_B });
  assert.equal(app.plain(await app.invoke('phone:queueCount')).count, 2);
  await app.invoke('phone:applyQueue');
  assert.equal(app.plain(await app.invoke('phone:queueCount')).count, 0, 'and drops as they are applied');
});

test('⚠ the new core module is in the packaging allowlist', () => {
  // 11-phone-queue.js requires ./core/action-queue. If core/ were not shipped, every test here still
  // passes and the INSTALLED app fails to boot — the trap core/clip-key.js documents.
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  assert.ok((pkg.build.files || []).includes('core/**/*'), '⚠ core/ must ship or the app cannot start');
  const bundled = readFileSync(join(process.cwd(), 'main.js'), 'utf8');
  assert.match(bundled, /require\('\.\/core\/action-queue'\)/, 'and the require survives the bundle');
});
