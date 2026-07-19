// Photos filed through the phone/GoPro flow used to get copied bytes and NOTHING else — all the AI's
// subject/people/keywords/description were saved to a sidecar the photo never reached, so in
// digiKam/Lightroom they looked untagged. Videos got rich XMP via finalize:run; photos got none.
// phone:distribute now embeds the AI record into each unique SOURCE photo once (so every copy
// inherits it) before copying. These tests pin that behavior with a stubbed exiftool.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let dir;
before(() => { app = loadMain(); dir = mkdtempSync(join(tmpdir(), 'photometa-')); });
after(() => { try { app.dispose(); } catch { /* ignore */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

// Install a fake exiftool into the module-scoped `_exiftool` binding (getExifTool() returns it when set).
// app.get(expr) runs the expression IN the vm context, so the assignment hits the real lexical binding.
function installFakeExif(mode = 'record') {
  app.get('globalThis.__exifWrites = []');
  if (mode === 'throw') {
    app.get("_exiftool = { write: async () => { throw new Error('exiftool boom'); }, end: async () => {} }");
  } else {
    app.get("_exiftool = { write: async (p, tags) => { globalThis.__exifWrites.push({ path: p, tags: JSON.parse(JSON.stringify(tags)) }); }, end: async () => {} }");
  }
}
const writes = () => app.getJSON('globalThis.__exifWrites') || [];
function srcPhoto(name) { const p = join(dir, name); writeFileSync(p, `jpeg-bytes-${name}`); return p; }

test('a photo job carrying meta embeds the AI record into the source, then copies', async () => {
  installFakeExif();
  const src = srcPhoto('a.jpg');
  const destDir = join(dir, 'NAS'); mkdirSync(destDir, { recursive: true });
  const meta = { subject: 'skiing', description: 'ridge', people: ['Liam'], keywords: ['skiing'], date: '2026-02-21' };
  const r = await app.invoke('phone:distribute', { jobs: [{ src, dest: join(destDir, 'a.jpg'), meta }] });

  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.copied, 1, 'the copy still ran');
  assert.equal(r.tagged, 1, 'the source photo was tagged once');
  const w = writes();
  assert.equal(w.length, 1, 'exactly one exiftool write (source embedded once)');
  assert.equal(w[0].path, src, 'embedded the SOURCE so every copy inherits it');
  assert.ok((w[0].tags['XMP-dc:Subject'] || []).some((k) => /skiing/.test(k)), 'subject/keyword written');
  assert.deepEqual(w[0].tags['XMP-iptcExt:PersonInImage'], ['Liam'], 'the recognized person is written');
});

test('the SAME source across multiple dest jobs is embedded only once', async () => {
  installFakeExif();
  const src = srcPhoto('b.jpg');
  const d1 = join(dir, 'NAS2'); mkdirSync(d1, { recursive: true });
  const d2 = join(dir, 'Proj'); mkdirSync(d2, { recursive: true });
  const meta = { subject: 'vlog', people: [], keywords: ['vlog'] };
  const r = await app.invoke('phone:distribute', { jobs: [
    { src, dest: join(d1, 'b.jpg'), meta },
    { src, dest: join(d2, 'b.jpg'), meta },
  ] });
  assert.equal(r.copied, 2, 'both copies ran');
  assert.equal(writes().length, 1, 'source tagged once, not per-dest');
});

test('a tag failure never blocks the backup', async () => {
  installFakeExif('throw');
  const src = srcPhoto('c.jpg');
  const r = await app.invoke('phone:distribute', { jobs: [{ src, dest: join(dir, 'c-out.jpg'), meta: { subject: 'x', keywords: ['x'] } }] });
  assert.equal(r.ok, true, 'copy success is not gated by a tag failure');
  assert.equal(r.copied, 1, 'the photo still copied');
  assert.equal(r.tagFailed, 1, 'the tag failure is reported, not swallowed silently');
});

test('jobs with no meta (legacy) still copy and write nothing', async () => {
  installFakeExif();
  const src = srcPhoto('d.jpg');
  const r = await app.invoke('phone:distribute', { jobs: [{ src, dest: join(dir, 'd-out.jpg') }] });
  assert.equal(r.copied, 1);
  assert.equal(r.tagged, 0);
  assert.equal(writes().length, 0, 'no meta → no embed');
});
