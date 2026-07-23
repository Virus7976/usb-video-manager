// ⚠⚠ THE WHOLE CHAIN, ONCE: phone → server → desktop → nameable.
//
// Each link is tested on its own — the resumable core, the phone client, `uploads:list`,
// `uploads:ingest`. Every one of them passes. That is exactly the state this session has been burned
// by three separate times:
//
//   · `config:get` did not expose a key the setup screen read — both sides correct, join broken
//   · the Organize screen gave up before asking the scan that would have answered it
//   · a card interpolated an identifier that did not exist, blanking the whole screen
//
// In all three the pieces were individually right and the SEAM was wrong, and no unit test could see
// it because a unit test only ever looks at one side. So this walks the join, using the real upload
// core the server calls and the real IPC the desktop exposes — no mocks of the thing under test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { loadMain } from './harness.mjs';

const require = createRequire(import.meta.url);
const upload = require('../core/upload.js');

let app; let staging; let intake;

before(() => {
  app = loadMain();
  // The exact directory the SERVER writes to and the desktop reads from. Computed the way each side
  // computes it, not passed between them — if those two ever disagree, this test is what notices.
  staging = join(app.storeDir, 'phone-uploads');
  intake = join(app.dirs.userData, 'intake');
  for (const d of [staging, intake]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  mkdirSync(staging, { recursive: true });
  mkdirSync(intake, { recursive: true });
  app.get('config').intakeFolder = intake;
});
after(() => { try { app.dispose(); } catch { /* ignore */ } });

// Send a clip the way the phone client does: begin → chunks at an offset → finish.
const phoneSends = (name, body, { interruptAfter = null } = {}) => {
  const buf = Buffer.from(body);
  const b = upload.begin({ dir: staging, name, size: buf.length, at: Date.now() });
  assert.equal(b.ok, true, 'the server accepted the upload');
  let offset = Number(b.offset) || 0;
  const CHUNK = 4;
  while (offset < buf.length) {
    if (interruptAfter !== null && offset >= interruptAfter) return { id: b.id, offset, interrupted: true };
    const end = Math.min(offset + CHUNK, buf.length);
    const r = upload.appendChunk({ dir: staging, id: b.id, offset, buf: buf.subarray(offset, end) });
    assert.equal(r.ok, true, `chunk at ${offset} landed`);
    offset = Number(r.offset) || end;
  }
  return { ...upload.finish({ dir: staging, id: b.id }), id: b.id, offset };
};

test('⚠⚠⚠ a clip sent from the phone becomes a clip the desktop can name', async () => {
  phoneSends('IMG_7001.MP4', 'THE-ONLY-COPY-OF-THIS-FOOTAGE');

  // The desktop sees it waiting…
  const listed = app.plain(await app.invoke('uploads:list'));
  assert.equal(listed.total, 1, `⚠⚠⚠ the upload is visible to the desktop — got ${listed.total}`);
  assert.equal(listed.files[0].name, 'IMG_7001.MP4');

  // …brings it in…
  const ing = app.plain(await app.invoke('uploads:ingest', {}));
  assert.equal(ing.ok, true, `⚠⚠⚠ ingest succeeded — got ${ing.error}`);
  assert.equal(ing.ingested, 1);

  // …and it is byte-for-byte in the folder the naming flow reads.
  assert.equal(readFileSync(join(intake, 'IMG_7001.MP4'), 'utf8'), 'THE-ONLY-COPY-OF-THIS-FOOTAGE',
    '⚠⚠⚠ intact through every hop — phone, server, staging, verified copy');
});

test('⚠⚠ an interrupted upload is never offered, and finishes later intact', async () => {
  // His real case: phone sleeps mid-transfer. The half-sent clip must not be ingestable — a truncated
  // file reaching his archive is worse than one that has not arrived yet.
  const half = phoneSends('IMG_7002.MP4', 'FIRST-HALF-THEN-SECOND-HALF', { interruptAfter: 8 });
  assert.equal(half.interrupted, true, 'setup: it really stopped mid-flight');

  const midway = app.plain(await app.invoke('uploads:list'));
  // ⚠⚠ ASSERT THAT NOTHING AT ALL IS OFFERED. Two earlier versions of this line were vacuous, and
  // the reason is worth keeping: an in-flight upload is stored under its upload ID, not the clip's
  // name — `4830bec0….part`, `4830bec0….json`. So neither `name === 'IMG_7002.MP4'` nor
  // `name.startsWith('IMG_7002')` could ever match the junk, and both stayed green with the `.part`
  // filter deleted. Probed the real core to find that out. Staging is empty at this point (test 1
  // ingested everything), so `total` is the only assertion the bug cannot slip past.
  assert.equal(midway.total, 0,
    `⚠⚠ a partial transfer must offer NOTHING — got ${JSON.stringify(midway.files.map((f) => f.name))}`);

  // He unlocks the phone; the client asks what is there and carries on from exactly that byte.
  const st = upload.status({ dir: staging, id: half.id });
  assert.equal(st.offset, 8, '⚠⚠ the server remembers how far it got');
  const rest = Buffer.from('FIRST-HALF-THEN-SECOND-HALF');
  upload.appendChunk({ dir: staging, id: half.id, offset: 8, buf: rest.subarray(8) });
  upload.finish({ dir: staging, id: half.id });

  const after = app.plain(await app.invoke('uploads:list'));
  assert.ok(after.files.some((f) => f.name === 'IMG_7002.MP4'), '⚠⚠ now complete, now offered');
  const ing = app.plain(await app.invoke('uploads:ingest', {}));
  assert.equal(ing.ok, true);
  assert.equal(readFileSync(join(intake, 'IMG_7002.MP4'), 'utf8'), 'FIRST-HALF-THEN-SECOND-HALF',
    '⚠⚠⚠ resumed and reassembled correctly — not two first-halves, not a truncated file');
});

test('⚠⚠ two phones sending the same filename both survive', async () => {
  // `IMG_0001.MP4` is not a rare name. The ADB path once destroyed a photo exactly this way.
  phoneSends('IMG_0001.MP4', 'FROM-PHONE-A');
  let ing = app.plain(await app.invoke('uploads:ingest', {}));
  assert.equal(ing.ingested, 1);
  phoneSends('IMG_0001.MP4', 'FROM-PHONE-B');
  ing = app.plain(await app.invoke('uploads:ingest', {}));
  assert.equal(ing.ingested, 1);

  const bodies = readdirSync(intake)
    .filter((n) => n.startsWith('IMG_0001'))
    .map((n) => readFileSync(join(intake, n), 'utf8'))
    .sort();
  assert.deepEqual(bodies, ['FROM-PHONE-A', 'FROM-PHONE-B'],
    '⚠⚠⚠ both clips exist — neither overwrote the other');
});

test('⚠ staging is left clean, so the same clip is not offered twice', async () => {
  const left = app.plain(await app.invoke('uploads:list'));
  assert.equal(left.total, 0, '⚠ everything ingested has been released from staging');
  assert.equal(existsSync(join(staging, 'IMG_7001.MP4')), false);
});
