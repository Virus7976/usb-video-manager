// Audit metadata fixes: date accepts a trailing time (#56), xmp:Label misuse dropped (#53), and the
// Resolve CSV MERGES by File Name across runs instead of overwriting (#47).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let dir;
before(() => { app = loadMain(); dir = mkdtempSync(join(tmpdir(), 'metab-')); });
after(() => { try { app.dispose(); } catch { /* ignore */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

test('#56 a date with a trailing time still writes DateCreated (the date portion)', () => {
  const t = app.call('buildEmbedTags', { subject: 'x', date: '2026-02-14 13:57:25' }, [], 'f.mp4');
  assert.equal(t['XMP-photoshop:DateCreated'], '2026-02-14', 'date extracted, not dropped');
});
test('#56 a plain YYYY-MM-DD date still works', () => {
  const t = app.call('buildEmbedTags', { subject: 'x', date: '2026-02-14' }, [], 'f.mp4');
  assert.equal(t['XMP-photoshop:DateCreated'], '2026-02-14');
});
test('#53 shotType no longer pollutes XMP:Label (but stays a searchable keyword)', () => {
  const t = app.call('buildEmbedTags', { subject: 'skiing', shotType: 'pov', date: '2026-02-14' }, [], 'f.mp4');
  assert.equal(t['XMP-xmp:Label'], undefined, 'no garbage colour label');
  assert.ok((t['XMP-dc:Subject'] || []).includes('pov'), 'shotType still findable in keywords');
});

async function runCsv(items, dest) {
  const r = await app.invoke('finalize:run', { dir: join(dir, 'src'), organizeDest: dest,
    options: { organize: true, embed: false, csv: true, nas: false }, items });
  return r;
}
function clip(name) { const s = join(dir, 'src'); mkdirSync(s, { recursive: true }); const p = join(s, name); writeFileSync(p, name); return p; }

test('#47 a second organize run MERGES into the CSV, keeping the first run\'s rows', async () => {
  const dest = join(dir, 'Projects'); mkdirSync(dest, { recursive: true });
  await runCsv([{ name: 'a.mp4', sourcePath: clip('a.mp4'), meta: { subject: 'ski', description: 'ridge' }, rel: '2026 - Personal/Ski' }], dest);
  await runCsv([{ name: 'b.mp4', sourcePath: clip('b.mp4'), meta: { subject: 'vlog', description: 'kitchen' }, rel: '2026 - Personal/Vlog' }], dest);
  const csv = readFileSync(join(dest, 'resolve-metadata.csv'), 'utf8');
  assert.match(csv, /^File Name,Description,Shot,Scene,Keywords,Comments/, 'one header');
  assert.ok(csv.includes('a.mp4'), 'first batch row survived the second run');
  assert.ok(csv.includes('b.mp4'), 'second batch row present');
  assert.equal((csv.match(/File Name,Description/g) || []).length, 1, 'header written exactly once (not duplicated)');
});

test('#32 native capture date: photo gets EXIF, video gets QuickTime (gated by type)', () => {
  const photo = app.call('buildEmbedTags', { subject: 'x', date: '2026-02-14 13:57:25' }, [], 'IMG_1.jpg');
  assert.equal(photo['EXIF:DateTimeOriginal'], '2026:02:14 00:00:00', 'photo EXIF DateTimeOriginal');
  assert.equal(photo['EXIF:CreateDate'], '2026:02:14 00:00:00');
  assert.equal(photo['QuickTime:CreateDate'], undefined, 'no QuickTime tag on a photo');

  const video = app.call('buildEmbedTags', { subject: 'x', date: '2026-02-14' }, [], 'clip.mp4');
  assert.equal(video['QuickTime:CreateDate'], '2026:02:14 00:00:00', 'video QuickTime CreateDate');
  assert.equal(video['EXIF:DateTimeOriginal'], undefined, 'no EXIF tag on a video');
});

test('#54 people: PersonInImage written, invalid MWG Region* tags dropped', () => {
  const t = app.call('buildEmbedTags', { subject: 'x', people: ['Liam', 'Josiah'] }, [], 'f.mp4');
  assert.deepEqual(app.plain(t['XMP-iptcExt:PersonInImage']), ['Liam', 'Josiah'], 'PersonInImage kept');
  assert.equal(t['XMP-mwg-rs:RegionPersonDisplayName'], undefined, 'invalid region tags dropped');
  assert.equal(t['XMP-mwg-rs:RegionName'], undefined);
  assert.equal(t['XMP-mwg-rs:RegionType'], undefined);
  assert.ok((t['XMP-digiKam:TagsList'] || []).some((x) => /People\/Liam/.test(x)), 'People tag tree still written');
});

test('#48 CSV Scene under a plan uses the leaf folder, not the empty level field', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'csvscene-'));
  const dest = join(d2, 'Projects'); mkdirSync(dest, { recursive: true });
  const src = join(d2, 'src'); mkdirSync(src, { recursive: true });
  const from = join(src, 'a.mp4'); writeFileSync(from, 'a');
  await app.invoke('finalize:run', { dir: src, organizeDest: dest,
    options: { organize: true, embed: false, csv: true, nas: false },
    items: [{ name: 'a.mp4', sourcePath: from, meta: { subject: 'ski' }, rel: '2026 - Personal/Ski Trip' }] });
  const csv = readFileSync(join(dest, 'resolve-metadata.csv'), 'utf8');
  const row = csv.split(/\r?\n/).find((l) => l.startsWith('a.mp4'));
  assert.ok(/Ski Trip/.test(row), `Scene column carries the plan folder: ${row}`);
  rmSync(d2, { recursive: true, force: true });
});
