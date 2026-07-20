// How the phone changes anything without racing the desktop app.
//
// ⚠⚠ THE DESIGN, AND WHY IT IS NOT JUST "LET THE SERVER WRITE THE STORE".
//
// The desktop owns faces-pending.json, people.json and the rest, and that ownership is load-bearing:
// atomic writes, a read-failure quarantine that refuses to write a store it could not read, debounced
// saves, caps, prunes and a single undo record — several of which were fixed the same day this was
// written. Two writers would race every one of them.
//
// So the phone APPENDS an instruction to `phone-actions.jsonl`, a file nothing else writes, and the
// desktop applies it later through its own handlers. One writer per file, always. The consequence he
// actually cares about: answering on the couch cannot fail because the PC is busy or asleep — the
// worst case is that the answer waits.
//
// JSON Lines, not a JSON array: an array has to be re-serialised whole on every append, which is both
// a read-modify-write race with itself and a torn-file risk that would lose EVERY earlier answer.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(join(process.cwd(), 'server', 'server.js'));
const queue = require('../core/action-queue');

const TOKEN = 'testtoken1234';
let dir; let app;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'uvd-q-'));
  mkdirSync(join(dir, 'faces'), { recursive: true });
  writeFileSync(join(dir, 'faces-pending.json'), JSON.stringify([
    { thumb: 'file:///C:/x/faces/a.jpg', suggest: { name: 'Josiah', dist: 0.3 }, clipKeys: ['a'] },
  ]));
  process.env.UVD_TOKEN = TOKEN;
  process.env.UVD_STORE_DIR = dir;
  app = require('../server/server').build({ logger: false });
  await app.ready();
});
after(async () => {
  try { await app.close(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => { try { rmSync(join(dir, queue.QUEUE_FILE), { force: true }); } catch { /* ignore */ } });

const post = (payload, token = TOKEN) => app.inject({
  method: 'POST', url: '/api/actions', headers: { 'x-pair-token': token }, payload,
});

test('⚠⚠ answering does NOT touch any store', async () => {
  // The property the whole design exists for.
  const before = readFileSync(join(dir, 'faces-pending.json'), 'utf8');
  const r = await post({ type: 'face.confirm', clusterId: '0', name: 'Josiah' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().queued, true, 'it is queued, not applied');
  assert.equal(readFileSync(join(dir, 'faces-pending.json'), 'utf8'), before,
    '⚠ the store must be byte-identical — a second writer would race the desktop app');
});

test('the instruction lands in a file nothing else writes', async () => {
  await post({ type: 'face.confirm', clusterId: '0', name: 'Josiah' });
  const lines = readFileSync(join(dir, queue.QUEUE_FILE), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.type, 'face.confirm');
  assert.equal(rec.name, 'Josiah');
  assert.equal(rec.source, 'phone', 'the desktop can tell where it came from');
  assert.ok(rec.at > 0 && rec.id, 'and it is timestamped and identifiable');
});

test('⚠ appending never rewrites what is already there', async () => {
  // The reason this is JSONL. A format that re-serialises the whole file on append could lose every
  // earlier answer to one torn write.
  for (const n of ['A', 'B', 'C']) await post({ type: 'face.confirm', clusterId: '0', name: n });
  const raw = readFileSync(join(dir, queue.QUEUE_FILE), 'utf8');
  assert.equal(raw.trim().split('\n').length, 3, 'all three survive');
  for (const n of ['A', 'B', 'C']) assert.ok(raw.includes(`"name":"${n}"`), `${n} is still there`);
});

test('⚠⚠ a torn final line costs ONE answer, not all of them', async () => {
  // The failure this format is chosen to bound: power loss or a killed process mid-append.
  await post({ type: 'face.confirm', clusterId: '0', name: 'Josiah' });
  await post({ type: 'face.reject', clusterId: '1' });
  appendFileSync(join(dir, queue.QUEUE_FILE), '{"type":"face.conf', 'utf8');   // truncated write
  const pending = queue.read({ dir });
  assert.equal(pending.length, 2, '⚠ the two complete answers still read back');
  assert.equal(pending[0].name, 'Josiah');
});

test('an instruction the desktop could not understand is refused at the door', async () => {
  // Worse than a rejected request: an unknown action sits in the queue looking like pending work
  // forever, and nothing ever applies it.
  const cases = [
    [{ type: 'face.confirm', clusterId: '0' }, /name is required/],
    [{ type: 'face.confirm', name: 'x' }, /clusterId is required/],
    [{ type: 'nonsense', clusterId: '0' }, /unknown action/],
    [{}, /unknown action/],
    [{ type: 'face.confirm', clusterId: '0', name: 'x'.repeat(200) }, /too long/],
    [{ type: 'question.answer', questionId: 'q1' }, /answer is required/],
  ];
  for (const [payload, re] of cases) {
    const r = await post(payload);
    assert.equal(r.statusCode, 400, `${JSON.stringify(payload)} is refused`);
    assert.match(r.json().error, re, 'and says why');
  }
  // Nothing reached disk.
  let exists = true;
  try { statSync(join(dir, queue.QUEUE_FILE)); } catch { exists = false; }
  assert.equal(exists, false, '⚠ a refused action must not be written');
});

test('⚠ queueing requires the token, like everything else', async () => {
  assert.equal((await post({ type: 'face.reject', clusterId: '0' }, null)).statusCode, 401);
  assert.equal((await post({ type: 'face.reject', clusterId: '0' }, 'wrongtoken12')).statusCode, 401);
});

test('the phone can see what is still waiting', async () => {
  // So a queued answer looks QUEUED rather than looking like it silently did nothing — the same
  // "success over nothing happened" failure the desktop app has repeatedly been bitten by.
  await post({ type: 'face.confirm', clusterId: '0', name: 'Josiah' });
  await post({ type: 'face.skip', clusterId: '1' });
  const r = await app.inject({ method: 'GET', url: '/api/actions', headers: { 'x-pair-token': TOKEN } });
  const b = r.json();
  assert.equal(b.count, 2);
  assert.equal(b.actions[0].type, 'face.confirm');
});

test('⚠ an APPLIED instruction drops out of the pending list', async () => {
  // The desktop marks it applied by appending `appliedAt`; the server only ever adds. Without this
  // the phone would show every answer he has ever given as still waiting.
  await post({ type: 'face.confirm', clusterId: '0', name: 'Josiah' });
  const raw = readFileSync(join(dir, queue.QUEUE_FILE), 'utf8').trim();
  const rec = { ...JSON.parse(raw), appliedAt: Date.now() };
  writeFileSync(join(dir, queue.QUEUE_FILE), `${JSON.stringify(rec)}\n`, 'utf8');
  assert.equal(queue.read({ dir }).length, 0, 'applied is no longer pending');
  assert.equal(queue.read({ dir, includeApplied: true }).length, 1, 'but the record is kept');
});

test('a missing queue is empty, not an error', () => {
  // Normal on any machine where he has not answered anything from the phone yet.
  assert.deepEqual(queue.read({ dir: join(dir, 'nope') }), []);
});

test('⚠ every OTHER write is still refused', async () => {
  const r = await app.inject({
    method: 'POST', url: '/api/faces/confirm',
    headers: { 'x-pair-token': TOKEN }, payload: { id: '0' },
  });
  assert.equal(r.statusCode, 501, 'only /api/actions accepts writes');
});

test('the phone page is served, and carries no token of its own', async () => {
  const r = await app.inject({ method: 'GET', url: '/' });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.ok(!r.body.includes(TOKEN), '⚠ the page must never ship with a token baked in');
  assert.match(r.body, /X-Pair-Token/, 'it sends the token it was given as a header');
  assert.ok(!/document\.cookie/.test(r.body), 'and does not use cookies, which are sent automatically');
});
