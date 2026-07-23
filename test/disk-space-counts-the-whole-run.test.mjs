// ⚠⚠ 47 FOLDERS ON ONE DISK WERE EACH CHECKED AS IF THEY WERE ALONE.
//
// `projects:move` refuses a run that would not fit — a good guard, and it was there. But it grouped
// the sizes by destination FOLDER and checked each one against the whole free space, so N folders on
// one drive never added up. Measured on a real volume:
//
//     free on volume : 959.6 GB
//     two folders    : 575.8 GB each  →  1,151.5 GB requested
//     result         : ok=true, no refusal
//
// His real shape is 310 clips into 47 folders, all on C:, which his own notes call the tight disk.
// Every folder's share is small; the run as a whole is not.
//
// `nearestExistingDir` walks up to the first folder that exists, so destinations that do not exist
// yet resolve to a shared parent — which makes the probe path a usable stand-in for "the same
// volume" without a filesystem id Node does not portably expose.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let base; let root; let src; let free;
before(() => { app = loadMain(); });
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  base = mkdtempSync(join(tmpdir(), 'space-'));
  root = join(base, 'projects'); mkdirSync(root, { recursive: true });
  src = join(base, 'src'); mkdirSync(src, { recursive: true });
  const st = statfsSync(base);
  free = Number(st.bavail) * Number(st.bsize);
});

// `size` is honoured by the check, so a test can claim a large file without writing one.
const clip = (name, size) => {
  const p = join(src, name);
  writeFileSync(p, 'x');
  return { from: p, toDir: join(root, `Folder-${name}`), rel: `Folder-${name}`, name, size };
};
const move = async (moves) => app.plain(await app.invoke('projects:move', { root, copy: true, moves }));

test('⚠ CONTROL — a run that genuinely fits is allowed', async () => {
  // Without this, "refuses when too big" could pass by refusing everything.
  const small = Math.floor(free * 0.01);
  const r = await move([clip('a.mp4', small), clip('b.mp4', small)]);
  assert.equal(r.ok, true, `⚠ a small run must still file — got ${r.error}`);
});

test('⚠⚠⚠ folders on ONE volume are counted together', async () => {
  const each = Math.floor(free * 0.6);            // 60% each — fine alone, 120% together
  const r = await move([clip('a.mp4', each), clip('b.mp4', each)]);
  assert.equal(r.ok, false, '⚠⚠⚠ the run must be refused, not started');
  assert.match(r.error, /Not enough room/i, 'and say why');
});

test('⚠⚠ the number he is shown is the WHOLE run, not one folder', async () => {
  // "needs 575.8 GB" when it needs 1,151.5 GB sends him to free up half of what he actually must.
  const each = Math.floor(free * 0.6);
  const r = await move([clip('a.mp4', each), clip('b.mp4', each)]);
  const need = Number((r.error.match(/needs ([\d.]+) GB/) || [])[1]);
  const oneFolder = each / 1e9;
  assert.ok(need > oneFolder * 1.5,
    `⚠⚠ the total is quoted (${need} GB), not a single folder's share (${oneFolder.toFixed(1)} GB)`);
});

test('⚠⚠ many small folders still add up — his actual shape', async () => {
  // 47 folders where each share is trivially small and the sum is not. This is the case the old
  // per-folder check could never catch, no matter how many folders there were.
  const each = Math.floor(free * 0.05);           // 5% each × 30 = 150%
  const moves = Array.from({ length: 30 }, (_, i) => clip(`c${i}.mp4`, each));
  const r = await move(moves);
  assert.equal(r.ok, false, '⚠⚠ thirty small folders on one disk are still one big run');
});

test('⚠ nothing was written before the refusal', async () => {
  // The guard exists so he does not half-fill the disk and then find out. A refusal that had already
  // started copying would be worse than no guard.
  const each = Math.floor(free * 0.6);
  await move([clip('a.mp4', each), clip('b.mp4', each)]);
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(root), [], '⚠ the projects tree is untouched');
});
