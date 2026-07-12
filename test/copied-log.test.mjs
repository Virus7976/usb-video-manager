// "Then I delete stuff off the card" — a SEPARATE, LATER, deliberate act.
//
// That is the stated workflow: copy off the card → let Tdarr compress → organize days later →
// and only then clear the card. But `state.copied` — the list that gates the Delete step — lived
// only in memory. After a restart it was empty, the "3 Delete" pill was a silent no-op, and the
// ONLY way to clear a card was to copy the entire thing again.
//
// copiedLog makes it durable, keyed by the stable name__size fingerprint so it survives a replug
// under a new drive letter and a restart. It is a convenience for REBUILDING the delete list, and
// never an authority to delete: delete:source re-hashes source against dest itself and refuses
// anything it cannot prove (see delete-gate.test.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let app; let dir;

before(() => { app = loadMain(); dir = mkdtempSync(join(tmpdir(), 'copiedlog-')); });
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** A file copied off a card into intake. `key` is the stable name__size fingerprint. */
function copied(name, bytes = 'footage') {
  const card = join(dir, 'card'); const intake = join(dir, 'intake');
  mkdirSync(card, { recursive: true }); mkdirSync(intake, { recursive: true });
  const source = join(card, name); const dest = join(intake, name);
  writeFileSync(source, bytes); writeFileSync(dest, bytes);
  return { key: `${name}__${bytes.length}`, source, dest, name };
}

test('a copy recorded today is still there in a later session', async () => {
  const a = copied('GX010023.MP4');
  await app.invoke('copied:record', [a]);

  // …a restart later (the store is read fresh from disk), the record is intact.
  const got = await app.invoke('copied:get', [a.key]);
  assert.ok(got[a.key], 'the card can still be cleared days later, without re-copying it');
  assert.equal(got[a.key].dest, a.dest);
});

test('the key is the stable fingerprint — a new drive letter still matches', async () => {
  // The card comes back as F: instead of E:. name__size is unchanged, so the lookup still hits.
  const a = copied('GX010024.MP4', 'twelve-bytes');
  await app.invoke('copied:record', [a]);

  const got = await app.invoke('copied:get', [`GX010024.MP4__${'twelve-bytes'.length}`]);
  assert.ok(got[a.key], 'a replug under a different drive letter does not lose the record');
});

test('a record whose COPY has vanished is dropped, not offered for deletion', async () => {
  // The decisive safety property. If the intake copy was moved/renamed by the compressor or
  // deleted, that record proves nothing — offering it would be offering to delete footage whose
  // only other copy is gone.
  const a = copied('GX010025.MP4');
  await app.invoke('copied:record', [a]);
  unlinkSync(a.dest);                                   // the copy is gone

  const got = await app.invoke('copied:get', [a.key]);
  assert.equal(got[a.key], undefined, 'NOT offered — its copy no longer exists');

  // …and the dead record is pruned, so it can't come back.
  const again = await app.invoke('copied:get', null);
  assert.equal(again[a.key], undefined);
});

test('only the requested keys come back — one card can never surface another card\'s clips', async () => {
  // This is the bug that let the phone flow list a previous CARD's files. The delete list is
  // rebuilt from the intersection of what is physically on THIS card and what we logged, so
  // another source's clips simply aren't in the query.
  const mine = copied('MINE.MP4');
  const other = copied('OTHER-CARD.MP4');
  await app.invoke('copied:record', [mine, other]);

  const got = await app.invoke('copied:get', [mine.key]);
  assert.ok(got[mine.key]);
  assert.equal(got[other.key], undefined, 'the other card\'s clip is not in this card\'s delete list');
});

test('forgetting a deleted clip stops it being offered again', async () => {
  const a = copied('GX010026.MP4');
  await app.invoke('copied:record', [a]);
  await app.invoke('copied:forget', [a.key]);
  const got = await app.invoke('copied:get', [a.key]);
  assert.equal(got[a.key], undefined);
});

test('junk in, nothing out', async () => {
  for (const payload of [null, undefined, 'nope', [null], [{}], [{ key: 'k' }], [{ source: 's', dest: 'd' }]]) {
    assert.equal(await app.invoke('copied:record', payload), true, 'never throws');
  }
  const got = await app.invoke('copied:get', ['k']);
  assert.equal(got.k, undefined, 'an incomplete record is not stored');
});

// --- the wiring ------------------------------------------------------------------------

test('the renderer records after a copy, rebuilds after a scan, and forgets after a delete', () => {
  const core = readFileSync(join(ROOT, 'src', 'mod', '01-core.js'), 'utf8');
  const flow = readFileSync(join(ROOT, 'src', 'mod', '09-phone-finalize.js'), 'utf8');

  assert.match(flow, /window\.api\.recordCopied\(/, 'a completed copy is recorded durably');
  assert.match(core, /async function restoreCopiedFromLog\(\)/, 'a scan rebuilds the delete list');
  assert.match(core, /await restoreCopiedFromLog\(\);/, 'and it is actually called after the scan');
  assert.match(flow, /window\.api\.forgetCopied\(gone\)/, 'a successful delete forgets the record');

  // The rebuild is scoped to clips ON THIS CARD — never the whole log.
  const fn = core.slice(core.indexOf('async function restoreCopiedFromLog'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /state\.scannedFiles\.map\(\(c\) => clipKey\(c\)\)/, 'it asks only about the clips actually on this card');
  assert.match(body, /state\.copied = \[\];/, 'and starts from empty, so a stale list can never leak in');
});

test('the phone/card branch is DERIVED from the loaded clips, not a flag that can drift', () => {
  // goHome() set `state.phoneBackup = false` while leaving the PHONE clips in state.scannedFiles.
  // Re-entering via "Name & copy clips" then ran the CARD copy path on phone files: straight from
  // the staging temp dir into "01 - Uncompressed", bypassing the deliberate "Send to Uncompressed"
  // gate that exists so Tdarr can't compress them early — and then offered the staging temp files
  // to the Delete step. scannedDrive is set by BOTH entry points and cannot disagree with the
  // clips that are loaded, so the branch is derived from it.
  const core = readFileSync(join(ROOT, 'src', 'mod', '01-core.js'), 'utf8');
  const flow = readFileSync(join(ROOT, 'src', 'mod', '09-phone-finalize.js'), 'utf8');
  const people = readFileSync(join(ROOT, 'src', 'mod', '08-people.js'), 'utf8');

  assert.match(core, /const isPhoneFlow = \(\) => state\.scannedDrive === '__phone__'/, 'the predicate is derived');
  assert.match(flow, /if \(isPhoneFlow\(\)\) return runPhoneCopy\(\)/, 'the copy branch uses it');

  // The mutable flag is gone from every code path — a stale `true`/`false` cannot survive anywhere.
  for (const [name, src] of [['01-core', core], ['09-phone-finalize', flow], ['08-people', people]]) {
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.equal(/state\.phoneBackup/.test(code), false, `${name} no longer reads or writes the flag`);
  }

  // Both entry points establish the truth it derives from.
  assert.match(flow, /state\.scannedDrive = '__phone__'/, 'phone entry marks the source');
  assert.match(core, /state\.scannedDrive = state\.drive\.mountpoint/, 'card entry marks the source');
});

test('a REFUSED delete keeps its record — the file is still on the card', () => {
  // Only `r.ok` clears a record. A file the main-process gate refused was NOT deleted, so it must
  // remain in the log and remain offerable, or it becomes undeletable through the UI forever.
  const flow = readFileSync(join(ROOT, 'src', 'mod', '09-phone-finalize.js'), 'utf8');
  const idx = flow.indexOf('window.api.forgetCopied(gone)');
  const around = flow.slice(idx - 400, idx);
  assert.match(around, /results\.filter\(\(r\) => r\.ok\)/, 'only successfully deleted files are forgotten');
});
