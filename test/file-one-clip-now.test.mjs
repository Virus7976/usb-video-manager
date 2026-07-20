// TIER 1 item 3 — "a one-clip end-to-end path. Prove the whole pipeline in 10 seconds."
//
// His project ledger is 0 after months of use. The measured reason is not that filing is broken —
// it is that filing is only reachable at the END of a chain (scan → tick → map → options → Run), so
// he has never once watched it succeed. A capability nobody has seen work is indistinguishable from
// one that doesn't exist.
//
// So: right-click any row on the Organize list → "File this clip now". One clip, immediately, and
// the toast says which folder it landed in.
//
// The implementation deliberately routes through the SAME `finalize:run` the Run button uses. A
// second filing implementation is precisely the "second entry point inherits none of the first's
// fixes" shape that has produced a confirmed bug on three separate days in this repo — including one
// where the pop-out map guessed at the embed setting and shipped `meta: null` for months. So this
// reads the real checkboxes rather than hardcoding what it assumes they say.
//
// It also needed something from main that did not exist: `finalize:run` counted moves but never said
// WHERE, so the only way to answer "filed where?" was to go and look in the Projects tree — the
// re-check-its-work loop the whole effort exists to remove. It now returns `filedRels`, the folder
// each clip actually landed in, which for an unnamed clip is the ladder's `<date>/_unsorted` and NOT
// the empty `rel` the caller sent.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

let box;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'uvd-fileone-'));
  const dir = join(base, 'compressed');
  const dest = join(base, 'Projects');
  mkdirSync(dir, { recursive: true });
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dir, 'clip-a.mp4'), 'FOOTAGE-A');
  const cfg = app.get('config');
  cfg.projectsRoot = dest;
  cfg.projectLedger = [];
  box = { base, dir, dest, cleanup: () => rmSync(base, { recursive: true, force: true }) };
});

const walk = (root) => {
  const out = [];
  const rec = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(join(d, e.name), r); else out.push(r);
    }
  };
  rec(root, '');
  return out;
};

test('filing ONE clip really files it', async () => {
  try {
    const s = await app.invoke('finalize:run', {
      dir: box.dir,
      items: [{ name: 'clip-a.mp4', sourcePath: join(box.dir, 'clip-a.mp4'), meta: { subject: 'liam', date: '2026-03-14' } }],
      options: { embed: false, csv: false, organize: true, nas: false, copy: true },
      organizeDest: box.dest, folderLevels: [], nasPath: '',
    });
    assert.ok(s && s.ok, `the run succeeded: ${JSON.stringify(s)}`);
    assert.equal(s.moved, 1, 'one clip moved');
    const landed = walk(box.dest);
    assert.equal(landed.length, 1, `exactly one file arrived — got ${JSON.stringify(landed)}`);
  } finally { box.cleanup(); }
});

test('it reports WHERE it landed, not just that it landed', async () => {
  // The whole point of a 10-second proof is that he can see the result without going to look.
  try {
    const s = await app.invoke('finalize:run', {
      dir: box.dir,
      items: [{ name: 'clip-a.mp4', sourcePath: join(box.dir, 'clip-a.mp4'), meta: { subject: 'liam', date: '2026-03-14' } }],
      options: { embed: false, csv: false, organize: true, nas: false, copy: true },
      organizeDest: box.dest, folderLevels: [], nasPath: '',
    });
    assert.ok(Array.isArray(s.filedRels), 'the summary carries per-clip destinations');
    const rec = s.filedRels.find((x) => x && x.name === 'clip-a.mp4');
    assert.ok(rec, `the clip is named in the report — got ${JSON.stringify(s.filedRels)}`);
    assert.ok(rec.rel && rec.rel.length, `and its folder is non-empty — got ${JSON.stringify(rec)}`);
    // It must match the folder actually on disk, or the toast is a plausible lie.
    assert.ok(walk(box.dest)[0].startsWith(rec.rel), `the reported folder is the real one — reported ${rec.rel}, on disk ${walk(box.dest)[0]}`);
  } finally { box.cleanup(); }
});

test('an UNNAMED clip reports the ladder\'s folder, not the empty rel it was sent', async () => {
  // This is the case that makes the report worth having: the caller sends no `rel`, the ladder
  // invents `<date>/_unsorted`, and reporting the request rather than the result would say ''.
  try {
    const s = await app.invoke('finalize:run', {
      dir: box.dir,
      items: [{ name: 'clip-a.mp4', sourcePath: join(box.dir, 'clip-a.mp4') }],
      options: { embed: false, csv: false, organize: true, nas: false, copy: true },
      organizeDest: box.dest, folderLevels: [], nasPath: '',
    });
    assert.equal(s.moved, 1, 'an unnamed clip is still fileable');
    const rec = (s.filedRels || []).find((x) => x && x.name === 'clip-a.mp4');
    assert.ok(rec && rec.rel, `it reports a folder — got ${JSON.stringify(s.filedRels)}`);
    assert.match(rec.rel, /_unsorted/, `the ladder's folder, reported honestly — got ${rec.rel}`);
  } finally { box.cleanup(); }
});

test('a one-clip run still leaves the original where it was', async () => {
  // Organize COPIES. A "prove it works" button that MOVED his only copy would be the worst possible
  // first impression of filing, and the copy default is the standing rule for this app.
  try {
    await app.invoke('finalize:run', {
      dir: box.dir,
      items: [{ name: 'clip-a.mp4', sourcePath: join(box.dir, 'clip-a.mp4'), meta: { subject: 'liam', date: '2026-03-14' } }],
      options: { embed: false, csv: false, organize: true, nas: false, copy: true },
      organizeDest: box.dest, folderLevels: [], nasPath: '',
    });
    assert.equal(existsSync(join(box.dir, 'clip-a.mp4')), true, 'the source is untouched');
  } finally { box.cleanup(); }
});

test('a one-clip run teaches the ledger, like a batch run', async () => {
  // The ledger is the thing measured at zero. If the 10-second path did not write it, the proof
  // would not compound into anything.
  try {
    await app.invoke('finalize:run', {
      dir: box.dir,
      items: [{ name: 'clip-a.mp4', sourcePath: join(box.dir, 'clip-a.mp4'), meta: { subject: 'liam', date: '2026-03-14' } }],
      options: { embed: false, csv: false, organize: true, nas: false, copy: true },
      organizeDest: box.dest, folderLevels: [], nasPath: '',
    });
    const led = app.plain(app.get('config').projectLedger) || [];
    assert.ok(led.length >= 1, `the ledger learned from one clip — got ${led.length}`);
  } finally { box.cleanup(); }
});

// --- the renderer side ---
const ui = readFileSync(join(process.cwd(), 'src', 'mod', '09-phone-finalize.js'), 'utf8').replace(/\/\/.*$/gm, '');
const fileOne = (() => {
  const i = ui.indexOf('async function fileOneClipNow');
  return ui.slice(i, ui.indexOf('\n}', i));
})();

test('the row menu offers it', () => {
  assert.ok(fileOne.length > 0, 'the handler exists');
  assert.match(ui, /label: f\.filed \? 'File this clip again' : 'File this clip now'/, 'on every row');
  assert.match(ui, /action: \(\) => fileOneClipNow\(f\)/, 'wired to the clip the menu opened on');
});

test('it reads the SAME controls the Run button reads', () => {
  // The lesson from the pop-out map, which guessed `embed` and shipped meta: null for months.
  assert.match(fileOne, /embed: \$\('finEmbed'\)\.checked/, 'the real embed checkbox');
  assert.match(fileOne, /copy: \$\('finKeepSource'\)\.checked/, 'the real keep-originals checkbox');
});

test('it never files into a bare root', () => {
  // Sending no rel is correct — finalize:run's ladder then picks subject or <date>/_unsorted. What
  // would be wrong is inventing a destination here, in a second place, that the ladder does not know.
  assert.match(fileOne, /const rel = \(plan && plan\.byPath && plan\.byPath\[f\.sourcePath\]\) \|\| '';/,
    'the map placement if there is one');
  assert.match(fileOne, /const item = rel \? \{ \.\.\.f, rel \} : \{ \.\.\.f \};/,
    'and no rel at all otherwise — the ladder decides, not this function');
});

test('a run that moves NOTHING is not reported as success', () => {
  // ok:true with moved:0 is exactly how the batch button taught him not to trust it.
  assert.match(fileOne, /if \(!summary\.moved\) \{/, 'zero moves is handled separately');
  assert.match(fileOne, /was not filed/, 'and says so plainly');
});

test('the toast names the folder the run actually chose', () => {
  assert.match(fileOne, /summary\.filedRels \|\| \[\]\)\.find\(/, 'reads the per-clip destination back');
  assert.doesNotMatch(fileOne, /f\.filedIn = rel \|\|/, 'not the rel it sent, which is empty for an unnamed clip');
});
