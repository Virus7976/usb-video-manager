// Re-runs used to re-embed every clip with a FULL-file exiftool rewrite (minutes per multi-GB video),
// even when the identical metadata was already embedded. finalize:run now reads the file's lossless
// record and SKIPS the write when it already matches. Stateful fake exiftool counts writes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let dir;
before(() => { app = loadMain(); dir = mkdtempSync(join(tmpdir(), 'reembed-')); });
after(() => { try { app.dispose(); } catch { /* ignore */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

// Fake exiftool that remembers what was written per path and returns it on read.
function installStatefulExif() {
  app.get('globalThis.__exifStore = {}; globalThis.__ewCount = 0;');
  app.get("_exiftool = { write: async (p, tags) => { globalThis.__ewCount += 1; globalThis.__exifStore[p] = tags['XMP-dc:Identifier'] || null; }, read: async (p) => ({ Identifier: globalThis.__exifStore[p] }), end: async () => {} }");
}
const writes = () => app.get('globalThis.__ewCount');

function clip(name, meta) { const s = join(dir, 'src'); mkdirSync(s, { recursive: true }); const p = join(s, name); writeFileSync(p, name); return { name, sourcePath: p, meta }; }

test('first embed writes; a second identical run SKIPS the rewrite', async () => {
  installStatefulExif();
  const c = clip('a.mp4', { subject: 'skiing', description: 'ridge', date: '2026-02-14' });
  const r1 = await app.invoke('finalize:run', { dir: join(dir, 'src'), options: { organize: false, embed: true, csv: false, nas: false }, items: [c] });
  assert.equal(r1.embedded, 1);
  assert.equal(writes(), 1, 'written once on the first run');

  const r2 = await app.invoke('finalize:run', { dir: join(dir, 'src'), options: { organize: false, embed: true, csv: false, nas: false }, items: [c] });
  assert.equal(r2.embedded, 1, 'still reported embedded (it IS)');
  assert.equal(writes(), 1, 'NOT rewritten — the identical record was already embedded');
});

test('a CHANGED record does re-write', async () => {
  installStatefulExif();
  const c = clip('b.mp4', { subject: 'skiing', date: '2026-02-14' });
  await app.invoke('finalize:run', { dir: join(dir, 'src'), options: { organize: false, embed: true, csv: false, nas: false }, items: [c] });
  assert.equal(writes(), 1);
  const c2 = { ...c, meta: { subject: 'lawn-mowing', date: '2026-02-14' } };   // different subject
  await app.invoke('finalize:run', { dir: join(dir, 'src'), options: { organize: false, embed: true, csv: false, nas: false }, items: [c2] });
  assert.equal(writes(), 2, 'a real metadata change is written');
});
