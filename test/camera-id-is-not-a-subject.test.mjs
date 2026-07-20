// A camera counter became a folder in his Projects tree.
//
// MEASURED, dry-filing his real 310-clip backlog: one clip filed into a folder called `gx046724/`.
// `2026-05-06_gx046724_v1.mp4` leads with a date and carries a `_v#` tag, so `parseNamedClip`
// correctly recognises it as app-named — and then takes the next token as the subject. That token is
// a raw GoPro counter.
//
// The result is worse than an obviously-broken folder, because it looks like a real grouping: a
// directory sitting beside `vlog/` and `lawn-mowing/` that will never gain a second clip and that
// nothing flags. Dropping the subject lets the clip fall through to `<date>/_unsorted`, which is the
// honest answer for "we know when this was shot, not what it is".
//
// The match is deliberately STRICT — a camera prefix followed by digits only. The camera-junk filter
// used for fuzzy token matching elsewhere is `/^(gx|gopro|hero|dji|img|dsc|mvi|...)\w*$/i`, which
// would also eat a genuine subject like `dji-crash-compilation`. Reusing it here would have quietly
// unfiled real work, so this one cannot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app; let parse;
before(() => { app = loadMain(); parse = app.get('parseNamedClip'); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const p = (n) => app.plain(parse(n));

test('a GoPro counter does not become a subject', () => {
  const r = p('2026-05-06_gx046724_v1.mp4');
  assert.ok(r, 'still recognised as app-named — it leads with a date');
  assert.equal(r.subject, '', `no subject invented from a camera ID — got ${JSON.stringify(r.subject)}`);
  assert.equal(r.date, '2026-05-06', 'and the date it DOES know is kept');
});

test('the other camera prefixes too', () => {
  for (const n of ['2026-01-01_GH016805_v1.mp4', '2026-01-01_dsc00123_v1.mp4', '2026-01-01_MVI_4410_v1.mp4']) {
    const r = p(n);
    assert.equal(r && r.subject, '', `${n} -> ${JSON.stringify(r && r.subject)}`);
  }
});

test('⚠ a REAL subject that merely starts with those letters is untouched', () => {
  // The direction that would do damage: unfiling work he actually named. `dji-crash-compilation` is
  // a perfectly good subject and the loose `\w*` filter used elsewhere would have eaten it.
  for (const [n, want] of [
    ['2026-01-01_dji-crash-compilation_x_v1.mp4', 'dji-crash-compilation'],
    ['2026-01-01_gxvlog_x_v1.mp4', 'gxvlog'],
    ['2026-01-01_imgur-review_x_v1.mp4', 'imgur-review'],
  ]) {
    const r = p(n);
    assert.equal(r && r.subject, want, `${n} keeps its subject — got ${JSON.stringify(r && r.subject)}`);
  }
});

test('the SPLIT camera shape is caught too (MVI_4410, DSC_0912)', () => {
  // Canon/Sony/DJI put an underscore between the prefix and the counter, so after the date is
  // shifted off the stem splits into subject `mvi` + description `4410`. The single-token check
  // cannot see that — my first version missed it and the test caught it, which is the whole point of
  // listing the real camera families rather than just the one I found in his folder.
  for (const n of ['2026-01-01_MVI_4410_v1.mp4', '2026-01-01_DSC_0912_v1.mp4', '2026-01-01_DJI_0043_v1.mp4']) {
    const r = p(n);
    assert.equal(r && r.subject, '', `${n} subject -> ${JSON.stringify(r && r.subject)}`);
    assert.equal(r && r.description, '', `${n} description is not a bare counter -> ${JSON.stringify(r && r.description)}`);
  }
});

test('⚠ but a prefix followed by REAL WORDS keeps both halves', () => {
  // The damaging direction for the split branch: `dsc_kitchen-build` is a subject he chose. Only an
  // all-digits description makes the pair camera junk.
  const r = p('2026-01-01_dsc_kitchen-build_v1.mp4');
  assert.equal(r.subject, 'dsc', `kept — got ${JSON.stringify(r.subject)}`);
  assert.equal(r.description, 'kitchen-build', `and its description — got ${JSON.stringify(r.description)}`);
});

test('his ordinary clips are completely unaffected', () => {
  const r = p('2026-05-31_lawn-mowing_dennis_v1.mp4');
  assert.equal(r.subject, 'lawn-mowing', 'subject');
  assert.equal(r.description, 'dennis', 'description');
  assert.equal(r.date, '2026-05-31', 'date');
});

test('a bare camera file is still not app-named at all', () => {
  // Guard the boundary the parser already had: no date and no _v# means "not ours". 37 of his 310
  // clips are exactly this, and they must keep falling straight through.
  assert.equal(p('GX016607.mp4'), null, 'unchanged — not app-named');
});

test('a clip whose subject was dropped files to the dated pen, not the root', async () => {
  // The behaviour that actually matters: the parse change must land the clip somewhere findable.
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const base = mkdtempSync(join(tmpdir(), 'uvd-camid-'));
  const dir = join(base, 'Compressed'); const dest = join(base, 'Projects');
  mkdirSync(dir, { recursive: true }); mkdirSync(dest, { recursive: true });
  const name = '2026-05-06_gx046724_v1.mp4';
  writeFileSync(join(dir, name), 'FOOTAGE');
  const cfg = app.get('config');
  cfg.projectsRoot = dest; cfg.projectLedger = []; cfg.finalMeta = {};
  try {
    const scan = await app.invoke('finalize:scan', dir, { includePhotos: false });
    const items = Array.from((scan && scan.files) || []).map((f) => ({ ...f }));
    const s = await app.invoke('finalize:run', {
      dir, items,
      options: { embed: false, csv: false, organize: true, nas: false, copy: true },
      organizeDest: dest, folderLevels: ['category', 'project'], nasPath: '',
    });
    assert.equal(s.moved, 1, 'it is still filed');
    const rel = String((Array.from(s.filedRels || [])[0] || {}).rel || '');
    assert.doesNotMatch(rel, /gx046724/i, `no camera-ID folder — got ${rel}`);
    assert.match(rel, /_unsorted/, `the honest dated pen — got ${rel}`);
    assert.equal(existsSync(join(dest, name)), false, 'and never loose in the root');
  } finally { rmSync(base, { recursive: true, force: true }); }
});
