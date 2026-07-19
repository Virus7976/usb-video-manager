// The map's "Apply" (projects:move) filed at a verbatim joined path, forking the tree on any case
// drift — an AI/typed path "2026 - client work" made a NEW folder beside the real "2026 - Client Work".
// It now resolves each folder against the disk (like finalize:run), reusing the existing one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let dir;
before(() => { app = loadMain(); dir = mkdtempSync(join(tmpdir(), 'mapres-')); });
after(() => { try { app.dispose(); } catch { /* ignore */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('a case-different plan path files into the EXISTING folder, not a forked duplicate', async () => {
  const root = join(dir, 'Projects');
  mkdirSync(join(root, '2026 - Client Work'), { recursive: true });   // his real folder, proper case
  const from = join(dir, 'archive', 'a.mp4'); mkdirSync(join(dir, 'archive'), { recursive: true }); writeFileSync(from, 'x');

  // rel uses a DIFFERENT case than the folder on disk.
  const r = await app.invoke('projects:move', {
    root,
    moves: [{ from, toDir: `${root}/2026 - client work/Gourgess Lawns`, rel: '2026 - client work/Gourgess Lawns', name: 'a.mp4' }],
    embed: false, copy: true,
  });
  assert.equal(r.ok, true, JSON.stringify(r));

  const top = readdirSync(root);
  assert.deepEqual(top.sort(), ['2026 - Client Work'], 'no forked "2026 - client work" sibling was created');
  assert.equal(existsSync(join(root, '2026 - Client Work', 'Gourgess Lawns', 'a.mp4')), true, 'filed into the existing folder');
});
