// UPLOADING FOOTAGE FROM THE PHONE, RESUMABLY.
//
// ⚠⚠ WHY RESUMABLE IS NOT OPTIONAL. He said he locks the phone and walks away mid-upload, and a 4 GB
// clip over WiFi takes long enough that the phone WILL sleep, drop the connection, or be
// backgrounded. A plain multipart POST restarts from zero every time that happens — for a
// videographer's footage that means it effectively never completes. (The Gourgess Lawns app he
// pointed at does exactly that: fine for 300 KB photos, wrong for video. Its Imperium sibling has the
// resumable machinery, which is the half worth copying.)
//
// ⚠⚠ AND IT NEVER TOUCHES HIS EXISTING FOOTAGE. Uploads land in their OWN staging directory as
// `.part` files, renamed into place only once the byte count matches what the phone declared. Nothing
// here writes to the intake folder, the Projects tree, or any store — the desktop ingests from
// staging on its own terms, exactly as it already does for phone pulls.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(join(process.cwd(), 'server', 'server.js'));

const TOKEN = 'testtoken1234';
let dir; let upDir; let app;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'uvd-up-'));
  upDir = join(dir, 'phone-uploads');
  mkdirSync(dir, { recursive: true });
  process.env.UVD_TOKEN = TOKEN;
  process.env.UVD_STORE_DIR = dir;
  process.env.UVD_UPLOAD_DIR = upDir;
  app = require('../server/server').build({ logger: false });
  await app.ready();
});
after(async () => {
  try { await app.close(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => { try { rmSync(upDir, { recursive: true, force: true }); } catch { /* ignore */ } });

const H = { 'x-pair-token': TOKEN };
const begin = (name, size) => app.inject({ method: 'POST', url: '/api/upload/begin', headers: H, payload: { name, size } });
const put = (id, offset, buf) => app.inject({
  method: 'PUT', url: `/api/upload/${id}?offset=${offset}`,
  headers: { ...H, 'content-type': 'application/octet-stream' }, payload: buf,
});
const finish = (id) => app.inject({ method: 'POST', url: `/api/upload/${id}/finish`, headers: H, payload: {} });
const statusOf = (id) => app.inject({ method: 'GET', url: `/api/upload/${id}`, headers: H });

test('⚠⚠ an upload interrupted halfway RESUMES from where it stopped', async () => {
  // The property the whole design exists for.
  const data = Buffer.from('A'.repeat(1000));
  const { id } = (await begin('clip.mp4', data.length)).json();

  await put(id, 0, data.subarray(0, 400));      // …phone sleeps here
  const mid = (await statusOf(id)).json();
  assert.equal(mid.offset, 400, 'the server knows exactly how much it has');
  assert.equal(mid.complete, false);

  await put(id, 400, data.subarray(400));       // resumes, sends only the remainder
  const done = (await finish(id)).json();
  assert.equal(done.ok, true, `finished — ${done.error || ''}`);
  assert.equal(done.bytes, 1000);
  assert.equal(readFileSync(join(upDir, 'clip.mp4'), 'utf8'), data.toString(), 'the file is byte-exact');
});

test('⚠⚠ a SHORT file is never renamed into place', async () => {
  // The failure that matters: a truncated video appearing in staging looking finished, which the
  // desktop would then ingest and Tdarr would compress into the archive.
  const { id } = (await begin('short.mp4', 1000)).json();
  await put(id, 0, Buffer.alloc(400));
  const r = await finish(id);
  assert.equal(r.statusCode, 409, 'finishing is refused');
  assert.match(r.json().error, /incomplete: 400 of 1000/, 'and says exactly how short it is');
  assert.equal(existsSync(join(upDir, 'short.mp4')), false, '⚠ nothing appears under the real name');
  assert.ok(readdirSync(upDir).some((n) => n.endsWith('.part')), 'the partial is still there to resume');
});

test('⚠⚠ a chunk at the WRONG offset is refused, not appended', async () => {
  // Appending anyway would corrupt the file silently — bytes in the wrong order, correct final size.
  const { id } = (await begin('c.mp4', 100)).json();
  await put(id, 0, Buffer.alloc(50));
  const r = await put(id, 90, Buffer.alloc(10));   // client thinks it is further along than it is
  assert.equal(r.statusCode, 409);
  const b = r.json();
  assert.match(b.error, /offset mismatch/);
  assert.equal(b.expected, 50, '⚠ and it reports the REAL offset so the client can re-sync');
});

test('⚠ a client cannot write past the size it declared', async () => {
  // Either a bug or an attempt to fill his disk; neither should be honoured.
  const { id } = (await begin('c.mp4', 100)).json();
  const r = await put(id, 0, Buffer.alloc(500));
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /exceeds declared size/);
});

test('⚠⚠ an upload NEVER overwrites a file that is already there', async () => {
  // Silently replacing footage he already has would be the worst possible behaviour.
  mkdirSync(upDir, { recursive: true });
  writeFileSync(join(upDir, 'clip.mp4'), 'ORIGINAL');
  const { id } = (await begin('clip.mp4', 3)).json();
  await put(id, 0, Buffer.from('NEW'));
  const r = (await finish(id)).json();
  assert.equal(r.ok, true);
  assert.equal(r.name, 'clip (2).mp4', '⚠ it lands beside the original, numbered');
  assert.equal(readFileSync(join(upDir, 'clip.mp4'), 'utf8'), 'ORIGINAL', 'the original is untouched');
});

test('⚠⚠ a hostile filename cannot escape the staging folder', async () => {
  // A phone-supplied name is hostile input by default — the same bound as the face-crop route.
  for (const name of ['../evil.mp4', '..\\evil.mp4', '/etc/passwd', 'a/b.mp4', '.hidden.mp4', 'x'.repeat(300) + '.mp4']) {
    const r = await begin(name, 10);
    assert.equal(r.statusCode, 400, `⚠ "${name}" is refused`);
  }
  // And a real name still works, or the loop above passes vacuously.
  assert.equal((await begin('good.mp4', 10)).statusCode, 200);
});

test('⚠ only media extensions are accepted', async () => {
  // An upload endpoint that accepts .exe is a different kind of problem, and he is never uploading
  // one from a camera roll.
  for (const name of ['thing.exe', 'script.ps1', 'notes.txt', 'archive.zip', 'noext']) {
    assert.equal((await begin(name, 10)).statusCode, 400, `${name} is refused`);
  }
  for (const name of ['a.mp4', 'b.MOV', 'c.heic', 'd.insv', 'e.dng']) {
    assert.equal((await begin(name, 10)).statusCode, 200, `${name} is a real camera file`);
  }
});

test('⚠ an unknown upload id is a 404, not a crash', async () => {
  assert.equal((await statusOf('deadbeefdeadbeefdeadbeef')).statusCode, 404);
  assert.equal((await statusOf('../../etc/passwd')).statusCode, 404, 'and the id itself cannot traverse');
  assert.equal((await finish('nope')).statusCode, 409);
});

test('⚠ uploading requires the token, like everything else', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/upload/begin', payload: { name: 'a.mp4', size: 5 } });
  assert.equal(r.statusCode, 401, '⚠ an open upload endpoint is somewhere to dump files on his disk');
});

test('a zero or missing size is refused', async () => {
  // Without a declared size there is nothing to verify completion against, so "finished" would mean
  // "the client stopped sending" — which is exactly the truncation this design prevents.
  for (const size of [0, -1, undefined, 'lots']) {
    assert.equal((await begin('a.mp4', size)).statusCode, 400, `size=${size} is refused`);
  }
});

test('abandoned uploads are swept, but not recent ones', async () => {
  const up = require('../core/upload');
  const { id } = (await begin('a.mp4', 100)).json();
  await put(id, 0, Buffer.alloc(10));
  // "Abandoned" and "he put the phone down on a slow connection" look identical for a while, so the
  // window is generous. Nothing recent is touched.
  assert.equal(up.sweepStale({ dir: upDir, now: Date.now() }).removed, 0, 'a fresh upload survives');
  const swept = up.sweepStale({ dir: upDir, now: Date.now() + 72 * 60 * 60 * 1000 });
  assert.ok(swept.removed >= 1, 'a two-day-old partial is cleaned up');
});
