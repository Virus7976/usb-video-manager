// Undo removed the clips and left the folders standing.
//
// Found by round-trip probing (file → undo → look), the same technique that caught the phantom filed
// badge an hour earlier. Everything the undo reported was true — 1 undone, ledger reversed, the rescan
// correctly says "not filed" — and `Projects/` still contained `vlog/2026-03-14/`.
//
// In his archive an empty dated folder is not harmless litter. It looks exactly like a real shoot, and
// the folder-reuse rule (2026-07-19cg) prefers a folder that already exists — so a later `vlog` clip
// would be handed to a directory that was never meant to be there. Undo is supposed to leave no trace.
//
// ⚠ This DELETES inside his Projects tree, which is the direction that cannot be taken back, so the
// scope is deliberately narrow and every limit below has a test:
//   • only directories THIS undo emptied — the parents of files it actually moved back;
//   • only when `readdir` says the directory is genuinely empty;
//   • never the destination root, and never anything outside it;
//   • walking up only while each parent is ALSO empty.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

let box;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'uvd-undodir-'));
  const dir = join(base, 'Compressed');
  const dest = join(base, 'Projects');
  mkdirSync(dir, { recursive: true });
  mkdirSync(dest, { recursive: true });
  const cfg = app.get('config');
  cfg.projectsRoot = dest; cfg.organizeDest = dest;
  cfg.projectLedger = []; cfg.finalMeta = {}; cfg.lastOrganize = null;
  box = { base, dir, dest, cleanup: () => rmSync(base, { recursive: true, force: true }) };
});

const fileThem = async (...names) => {
  for (const n of names) writeFileSync(join(box.dir, n), 'FOOTAGE');
  const scan = await app.invoke('finalize:scan', { dir: box.dir });
  return app.invoke('finalize:run', {
    dir: box.dir, items: Array.from(scan.files).map((f) => ({ ...f })),
    options: { embed: false, csv: false, organize: true, nas: false, copy: true },
    organizeDest: box.dest, folderLevels: ['category', 'project'], nasPath: '',
  });
};

test('⚠ undo leaves no empty folder behind', async () => {
  try {
    await fileThem('2026-03-14_vlog_a_v1.mp4');
    assert.ok(readdirSync(box.dest).length > 0, 'the fixture really filed something');
    await app.invoke('organize:undo');
    assert.deepEqual(readdirSync(box.dest), [], `the tree is as it was — got ${JSON.stringify(readdirSync(box.dest))}`);
  } finally { box.cleanup(); }
});

test('it walks up only while each parent is also empty', async () => {
  // `vlog/2026-03-14/` goes, and then `vlog/` goes because its last date folder did.
  try {
    await fileThem('2026-03-14_vlog_a_v1.mp4', '2026-04-02_vlog_b_v1.mp4');
    assert.deepEqual(readdirSync(box.dest), ['vlog'], 'both shoots live under one subject');
    await app.invoke('organize:undo');
    assert.deepEqual(readdirSync(box.dest), [], 'the subject folder goes with its last shoot');
  } finally { box.cleanup(); }
});

test('⚠⚠ a folder with ANYTHING of his in it is never removed', async () => {
  // The limit that matters most. If he put something in that folder himself, it stays — and so does
  // the folder.
  //
  // ⚠ TWO INDEPENDENT PROTECTIONS, and I checked which is load-bearing rather than assuming:
  //   • removing the `if (entries.length) break;` check alone → still safe, because `rmdir` refuses a
  //     non-empty directory (ENOTEMPTY) and the surrounding `catch { break; }` swallows it;
  //   • swapping `rmdir` for a recursive `rm` alone → still safe, because the entries check stops it
  //     ever running on a non-empty directory;
  //   • removing BOTH → **this test fails**, which is exactly right.
  // So neither is redundant: each covers the other's failure, and the explicit check is what keeps a
  // future "why not use fs.rm?" edit from being catastrophic. Verified all three by breaking them.
  try {
    await fileThem('2026-03-14_vlog_a_v1.mp4');
    const shoot = join(box.dest, 'vlog', '2026-03-14');
    writeFileSync(join(shoot, 'his-notes.txt'), 'MINE');
    await app.invoke('organize:undo');
    assert.equal(existsSync(shoot), true, '⚠ the folder survives');
    assert.equal(existsSync(join(shoot, 'his-notes.txt')), true, '⚠ and so does his file');
  } finally { box.cleanup(); }
});

test('⚠⚠ the destination ROOT is never removed, even when empty', async () => {
  // Undoing the only run in an otherwise-empty Projects tree must not delete the tree.
  try {
    await fileThem('2026-03-14_vlog_a_v1.mp4');
    await app.invoke('organize:undo');
    assert.equal(existsSync(box.dest), true, '⚠ the Projects folder itself is still there');
  } finally { box.cleanup(); }
});

test('a sibling project folder is untouched', async () => {
  // Only the directories THIS undo emptied. Another project that happens to be empty is not ours to
  // tidy — he may have created it deliberately for work he is about to do.
  try {
    mkdirSync(join(box.dest, '2026 - Client Work'), { recursive: true });
    await fileThem('2026-03-14_vlog_a_v1.mp4');
    await app.invoke('organize:undo');
    assert.equal(existsSync(join(box.dest, '2026 - Client Work')), true,
      'an unrelated empty folder is left exactly as he made it');
  } finally { box.cleanup(); }
});

test('the clip really is back where it came from', async () => {
  // The cleanup must not be mistaken for the undo working: prove the footage returned first.
  try {
    await fileThem('2026-03-14_vlog_a_v1.mp4');
    const r = app.plain(await app.invoke('organize:undo'));
    assert.equal(r.undone, 1, 'one clip undone');
    assert.equal(existsSync(join(box.dir, '2026-03-14_vlog_a_v1.mp4')), true, 'and it is back in the source folder');
  } finally { box.cleanup(); }
});

test('a failed tidy-up never fails the undo', async () => {
  // The footage is already back by the time this runs, so a permissions problem on a directory must
  // not turn a successful undo into a reported failure.
  try {
    await fileThem('2026-03-14_vlog_a_v1.mp4');
    const src = (await import('node:fs')).readFileSync(join(process.cwd(), 'main-mod', '02-media.js'), 'utf8');
    const at = src.indexOf('const emptiedDirs =');
    const end = src.indexOf('clearFinalMetaDone', at);
    assert.ok(at > -1 && end > at, 'located the tidy-up block');
    const block = src.slice(at, end);
    assert.match(block, /catch \{ break; \}/, 'every filesystem step is caught');
    assert.doesNotMatch(block, /throw/, 'and nothing is rethrown into the undo');
  } finally { box.cleanup(); }
});
