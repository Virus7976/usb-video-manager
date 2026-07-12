// Organize used to run TWO filing systems that disagreed, and the one the user could see lost.
//
// Step 2 IS the destination map (rendered inline into #finMapHost): you plan a whole tree, and
// its Apply files into your Projects root. But the step-3 "Run" button called finalize:run, which
// ignored the map completely and filed by [category, project] into the Compressed folder. Those
// two fields are normally EMPTY — the rename grid hides them by default, and the AI only sets a
// category that already exists — so subdirParts() returned [], organizeMove() found the file
// already sitting in the destination, and Run reported "N skipped, 0 moved".
//
// You planned everything, pressed Run, and it did nothing while looking like it had worked.
//
// There is now ONE plan: the map is the source of truth and Run executes it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let app; let dir;

before(() => { app = loadMain(); dir = mkdtempSync(join(tmpdir(), 'orgplan-')); });
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** A compressed clip sitting in the "Compressed" folder, ready to organize. */
function clip(name, meta = {}) {
  const src = join(dir, 'compressed');
  mkdirSync(src, { recursive: true });
  const sourcePath = join(src, name);
  writeFileSync(sourcePath, `bytes-of-${name}`);
  return { name, sourcePath, meta: { subject: 'snow-walking', description: 'ridge', ...meta } };
}

const projects = () => { const p = join(dir, 'Projects'); mkdirSync(p, { recursive: true }); return p; };

test('Run files clips exactly where the MAP put them', async () => {
  const dest = projects();
  const a = clip('a.mp4');
  const b = clip('b.mp4');

  const summary = await app.invoke('finalize:run', {
    dir: join(dir, 'compressed'),
    organizeDest: dest,
    options: { organize: true, embed: false, csv: false, nas: false },
    items: [
      { ...a, rel: 'Client/Alps-2026/2026-07-12' },
      { ...b, rel: 'Personal/Skiing' },
    ],
  });

  assert.equal(summary.ok, true, JSON.stringify(summary.errors));
  assert.equal(summary.moved, 2, 'both clips moved — this is the "0 moved" bug, dead');
  assert.equal(existsSync(join(dest, 'client', 'alps-2026', '2026-07-12', 'a.mp4')), true, 'a.mp4 landed in its planned folder');
  assert.equal(existsSync(join(dest, 'personal', 'skiing', 'b.mp4')), true, 'b.mp4 landed in its planned folder');
  assert.equal(existsSync(a.sourcePath), false, 'and left the Compressed folder');
});

test('a clip with NO place on the map is left alone — NOT dumped in the Projects root', async () => {
  // The dangerous near-miss. An unplanned clip sends rel:'' → the old code would fall through to
  // subdirParts() → [] → path.join(dest) → the ROOT of the user's Projects tree. Scattering
  // unplaced clips across the top of someone's project library is worse than doing nothing.
  const dest = projects();
  const placed = clip('placed.mp4');
  const orphan = clip('orphan.mp4');

  const summary = await app.invoke('finalize:run', {
    dir: join(dir, 'compressed'),
    organizeDest: dest,
    options: { organize: true, embed: false, csv: false, nas: false },
    items: [{ ...placed, rel: 'Client/Alps-2026' }, { ...orphan, rel: '' }],
  });

  assert.equal(summary.moved, 1, 'only the planned clip moved');
  assert.equal(summary.unplanned, 1, 'the unplanned one is REPORTED, not silently skipped');
  assert.equal(existsSync(join(dest, 'orphan.mp4')), false, 'it did NOT land in the Projects root');
  assert.equal(existsSync(orphan.sourcePath), true, 'it stayed put, where the user can still find it');
});

test('with no plan at all, the old [category, project] behaviour still works', async () => {
  // Back-compat: any caller that sends no `rel` gets exactly what it got before.
  const dest = projects();
  const c = clip('legacy.mp4', { category: 'work', project: 'acme' });

  const summary = await app.invoke('finalize:run', {
    dir: join(dir, 'compressed'),
    organizeDest: dest,
    folderLevels: ['category', 'project'],
    options: { organize: true, embed: false, csv: false, nas: false },
    items: [c],
  });

  assert.equal(summary.moved, 1);
  assert.equal(summary.unplanned, 0, 'no plan in play → nothing is "unplanned"');
  assert.equal(existsSync(join(dest, 'work', 'acme', 'legacy.mp4')), true);
});

test('this is the exact shape that used to move nothing', async () => {
  // Empty category/project (the normal case) + no plan → subdirParts is [], the file is already
  // in `dest`, organizeMove says in-place, and Run reports skipped. Locking the old behaviour in
  // so it's unmistakable WHY the plan is now the source of truth.
  const src = join(dir, 'inplace');
  mkdirSync(src, { recursive: true });
  const sourcePath = join(src, 'nowhere.mp4');
  writeFileSync(sourcePath, 'bytes');

  const summary = await app.invoke('finalize:run', {
    dir: src,
    organizeDest: src,                       // "organize in place" — the default finDestMode
    folderLevels: ['category', 'project'],
    options: { organize: true, embed: false, csv: false, nas: false },
    items: [{ name: 'nowhere.mp4', sourcePath, meta: { subject: 'x', description: 'y' } }],   // no category/project
  });

  assert.equal(summary.moved, 0, 'THIS is what the user saw: nothing moved');
  assert.equal(summary.skipped, 1, 'reported as "skipped" — which looked like a no-op, because it was');
  assert.equal(existsSync(sourcePath), true);
});

// --- the wiring that makes Run see the plan ---------------------------------------------

test('the map publishes its plan, and Run reads it', () => {
  const map = readFileSync(join(ROOT, 'src', 'mod', '07-organize-map.js'), 'utf8');
  assert.match(map, /function currentDestPlan\(\)/, 'the plan is exposed');
  assert.match(map, /function render\(\) \{ publishPlan\(\);/, 'it is republished on every render — so it never goes stale against what the user sees');

  const boot = readFileSync(join(ROOT, 'src', 'mod', '10-boot.js'), 'utf8');
  const run = boot.slice(boot.indexOf("$('finRunBtn').addEventListener"));
  const body = run.slice(0, run.indexOf('\n});'));
  assert.match(body, /const plan = currentDestPlan\(\)/, 'Run reads the plan');
  assert.match(body, /rel: planned\(c\)/, 'and sends each clip the folder the map chose for it');
  assert.match(body, /usePlan \? plan\.root : finEffectiveDest\(\)/, 'and files into the Projects root the map is showing');
});

test('Organize step 2 has a visible way forward', () => {
  // finNext2Btn was class="hidden" and nothing un-hid it — Back was the ONLY visible control,
  // so reaching Run meant guessing that the step-3 pill was clickable.
  const html = readFileSync(join(ROOT, 'src', 'index.html'), 'utf8');
  const btn = html.split('\n').find((l) => l.includes('id="finNext2Btn"'));
  assert.ok(btn, 'the Continue button exists');
  assert.equal(/class="[^"]*\bhidden\b/.test(btn), false, 'and it is no longer hidden');
});
