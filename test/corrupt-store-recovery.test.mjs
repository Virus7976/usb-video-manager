// The other half of the corrupt-store chain: getting BACK from it.
//
// 2026-07-20f covered detection (a broken file latches the write block) and the consequence (the file
// is never overwritten). This covers what happens next, and none of it had a test:
//
//   • **quarantine** — a `.corrupt-<timestamp>` copy is taken ONCE, so there is something to hand to
//     support or recover from. `storeQuarantined` appeared in zero tests.
//   • **recovery** — if he restores a good file, `freshStore` re-reads it, clears the latch, and
//     saving works again. Without this the app would stay bricked-for-writes until a restart, having
//     already told him his work could not be saved.
//
// The recovery direction matters as much as the block. A latch that never clears turns a transient
// problem (an antivirus lock, a network share hiccup, a half-finished write from a crash) into a
// session where everything he does is silently discarded — which is worse than the corruption,
// because the corruption at least stopped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

const REAL_WORK = { 'a.mp4__1__1': { subject: 'liam', description: 'skate park', ts: 1 } };
const RESTORED = { 'b.mp4__2__2': { subject: 'vlog', description: 'kitchen chat', ts: 2 } };

const boot = (fileName, contents) => {
  const app = loadMain();
  mkdirSync(app.storeDir, { recursive: true });
  const f = join(app.storeDir, fileName);
  if (contents !== null) writeFileSync(f, contents);
  return { app, f };
};

test('⚠ a corrupt store is quarantined as a .corrupt copy', async () => {
  // Writes are blocked, so the original is safe — but a copy he can hand over (or recover from) is
  // the difference between "your data is fine, trust me" and something he can actually act on.
  const raw = '{"a.mp4__1__1": {"subject": "li';
  const { app, f } = boot('drafts.json', raw);
  try {
    app.get('freshStore')('renameDrafts');
    const copies = readdirSync(app.storeDir).filter((n) => n.startsWith('drafts.json.corrupt-'));
    assert.equal(copies.length, 1, `one quarantine copy — got ${JSON.stringify(readdirSync(app.storeDir))}`);
    assert.equal(readFileSync(join(app.storeDir, copies[0]), 'utf8'), raw, 'and it holds the original bytes');
  } finally { app.dispose(); rmSync(f, { force: true }); }
});

test('it is quarantined ONCE, not on every read', async () => {
  // freshStore runs on essentially every store access. Copying a multi-megabyte people.json on each
  // one would fill his disk with near-identical files while he works.
  const { app, f } = boot('drafts.json', '{"broken');
  try {
    for (let i = 0; i < 5; i += 1) app.get('freshStore')('renameDrafts');
    const copies = readdirSync(app.storeDir).filter((n) => n.startsWith('drafts.json.corrupt-'));
    assert.equal(copies.length, 1, `still one copy after 5 reads — got ${copies.length}`);
  } finally { app.dispose(); rmSync(f, { force: true }); }
});

test('⚠⚠ restoring a good file clears the latch and saving works again', async () => {
  // The recovery path. A latch that never clears turns a transient lock into a whole session of
  // silently discarded work.
  const { app, f } = boot('drafts.json', '{"broken');
  try {
    app.get('freshStore')('renameDrafts');
    assert.equal((app.plain(app.get('storeReadFailed')) || {}).renameDrafts, true, 'blocked first');

    // He (or the antivirus, or the network share) puts a good file back.
    writeFileSync(f, JSON.stringify(RESTORED));
    app.get('freshStore')('renameDrafts');

    assert.notEqual((app.plain(app.get('storeReadFailed')) || {}).renameDrafts, true, 'the latch cleared');
    assert.deepEqual(app.plain(app.get('config').renameDrafts), RESTORED, 'and the restored data is in memory');

    app.get('config').renameDrafts = REAL_WORK;
    app.get('saveStore')('renameDrafts');
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), REAL_WORK, '⚠ saving genuinely works again');
  } finally { app.dispose(); rmSync(f, { force: true }); }
});

test('a still-corrupt file on re-read keeps writes blocked', async () => {
  // The other direction: re-reading must not clear the latch just because it tried.
  const raw = '{"broken';
  const { app, f } = boot('drafts.json', raw);
  try {
    app.get('freshStore')('renameDrafts');
    writeFileSync(f, '{"still broken');       // changed (so it re-reads) but still unparseable
    app.get('freshStore')('renameDrafts');
    assert.equal((app.plain(app.get('storeReadFailed')) || {}).renameDrafts, true, 'still blocked');
    app.get('saveStore')('renameDrafts');
    assert.equal(readFileSync(f, 'utf8'), '{"still broken', 'and still not overwritten');
  } finally { app.dispose(); rmSync(f, { force: true }); }
});

test('a healthy store is never quarantined', async () => {
  // Guard the everyday path: no stray .corrupt files in %APPDATA% during normal use.
  const { app, f } = boot('drafts.json', JSON.stringify(REAL_WORK));
  try {
    for (let i = 0; i < 3; i += 1) app.get('freshStore')('renameDrafts');
    const copies = readdirSync(app.storeDir).filter((n) => n.includes('.corrupt-'));
    assert.deepEqual(copies, [], `nothing quarantined — got ${JSON.stringify(copies)}`);
  } finally { app.dispose(); rmSync(f, { force: true }); }
});

test('an external edit is picked up even when mtime looks unchanged', async () => {
  // The size half of the change check. On FAT/exFAT/network shares the mtime clock is coarse enough
  // that an external write can land in the same tick as ours — mtime alone reads that as "ours" and
  // the in-memory copy silently diverges from the file.
  const { app, f } = boot('drafts.json', JSON.stringify(REAL_WORK));
  try {
    app.get('freshStore')('renameDrafts');
    const st = app.get('fs').statSync(f);

    // Rewrite with content of a DIFFERENT LENGTH, then backdate the mtime so the mtime test can only
    // say "unchanged". My first version restored the exact mtime and passed even with the size check
    // removed — utimesSync does not round-trip sub-millisecond precision, so the mtime came back
    // fractionally NEWER and triggered the re-read on its own. Backdating by a second makes the
    // mtime branch unambiguously false, so only the size branch can notice.
    const bigger = { ...RESTORED, padding: 'x'.repeat(200) };
    writeFileSync(f, JSON.stringify(bigger));
    const older = new Date(st.mtimeMs - 5000);
    app.get('fs').utimesSync(f, older, older);
    const after = app.get('fs').statSync(f);
    assert.ok(after.mtimeMs <= st.mtimeMs, `the fixture really has a non-newer mtime — ${after.mtimeMs} vs ${st.mtimeMs}`);
    assert.notEqual(after.size, st.size, 'and a genuinely different size');

    const got = app.plain(app.get('freshStore')('renameDrafts'));
    assert.deepEqual(got, bigger, `the external change was noticed by SIZE — got ${JSON.stringify(got)}`);
  } finally { app.dispose(); rmSync(f, { force: true }); }
});
