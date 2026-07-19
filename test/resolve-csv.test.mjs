// The Resolve metadata CSV was dropping two things the AI had already worked out for every clip:
// the SHOT type (wide/close/pov…) and the full visual OBSERVATION. DaVinci Resolve's Import
// Metadata maps a "Shot" column and a "Comments" column directly onto clip fields, so an editor
// can sort a bin by shot type and full-text-search the media pool for what was in each clip.
// These tests pin the CSV shape (header + row) so those columns can't silently regress.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let dir;
before(() => { app = loadMain(); dir = mkdtempSync(join(tmpdir(), 'resolvecsv-')); });
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function clip(name, meta = {}) {
  const src = join(dir, 'compressed');
  mkdirSync(src, { recursive: true });
  const sourcePath = join(src, name);
  writeFileSync(sourcePath, `bytes-of-${name}`);
  return { name, sourcePath, meta };
}
const projects = () => { const p = join(dir, 'Projects'); mkdirSync(p, { recursive: true }); return p; };

async function runCsv(items, dest) {
  const summary = await app.invoke('finalize:run', {
    dir: join(dir, 'compressed'),
    organizeDest: dest,
    options: { organize: true, embed: false, csv: true, nas: false },
    items,
  });
  assert.ok(summary.csvPath, `a CSV should have been written: ${JSON.stringify(summary.errors)}`);
  return readFileSync(summary.csvPath, 'utf8').split('\r\n');
}

test('CSV header carries Shot and Comments columns', async () => {
  const dest = projects();
  const a = clip('a.mp4', { subject: 'lawn-mowing', description: 'front-yard', shotType: 'wide', observation: 'two men on a ride-on mower' });
  const [header] = await runCsv([{ ...a, rel: '2026 - Client Work/Gourgess Lawns' }], dest);
  assert.equal(header, 'File Name,Description,Shot,Scene,Keywords,Comments');
});

test('a clip row emits its shot type and its full observation as Comments', async () => {
  const dest = projects();
  const a = clip('b.mp4', {
    subject: 'lawn-mowing', description: 'ridge', shotType: 'pov',
    // A comma inside the observation MUST be RFC-4180 quoted or it would split into extra columns.
    observation: 'two men repairing a mower, sitting on the grass',
  });
  const lines = await runCsv([{ ...a, rel: '2026 - Client Work/Gourgess Lawns' }], dest);
  const row = lines.find((l) => l.startsWith('b.mp4'));
  assert.ok(row, 'the clip should have a row');
  // Shot column present, unquoted single word.
  const cells = row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);   // split on commas outside quotes
  assert.equal(cells[2], 'pov', 'Shot column = the shot type');
  // Comments column present and correctly quoted (contains a comma).
  assert.equal(cells[5], '"two men repairing a mower, sitting on the grass"', 'Comments = quoted observation');
});

test('missing shot/observation leave those cells empty, not "undefined"', async () => {
  const dest = projects();
  const a = clip('c.mp4', { subject: 'vlog', description: 'kitchen' });   // no shotType, no observation
  const lines = await runCsv([{ ...a, rel: '2026 - Personal/Vlog' }], dest);
  const row = lines.find((l) => l.startsWith('c.mp4'));
  const cells = row.split(',');
  assert.equal(cells[2], '', 'Shot empty, not "undefined"');
  assert.equal(cells[cells.length - 1], '', 'Comments empty, not "undefined"');
});
