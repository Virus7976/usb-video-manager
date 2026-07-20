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
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs';
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
      { ...a, rel: '2026 - Client Work/Gourgess Lawns/2026-07-12' },
      { ...b, rel: '2026 - Personal/Skiing' },
    ],
  });

  assert.equal(summary.ok, true, JSON.stringify(summary.errors));
  assert.equal(summary.moved, 2, 'both clips filed — this is the "0 moved" bug, dead');
  // His REAL folder names, verbatim — not `2026-client-work/gourgess-lawns`, which would be a brand
  // new folder sitting beside the one holding all his actual edits.
  assert.equal(existsSync(join(dest, '2026 - Client Work', 'Gourgess Lawns', '2026-07-12', 'a.mp4')), true, 'a.mp4 landed in his real folder');
  assert.equal(existsSync(join(dest, '2026 - Personal', 'Skiing', 'b.mp4')), true, 'b.mp4 landed in his real folder');

  // FILING COPIES, IT DOES NOT MOVE. His archive lives on L: (2.3 TB free); he files into projects on
  // C: (31 GB free, against a 73 GB archive). The project folder is a WORKING copy he can clear out
  // when C: fills — and the archive has to still be there when he does. A move would silently make
  // the C: copy the only copy, on the smaller and fuller disk. His call, 2026-07-13.
  assert.equal(existsSync(a.sourcePath), true, 'the archive copy STAYS — filing must never empty it');
  assert.equal(existsSync(b.sourcePath), true);
});

test('…and MOVE is still available for anyone who wants the folder to empty as they file', async () => {
  const dest = projects();
  const a = clip('mv.mp4');
  const summary = await app.invoke('finalize:run', {
    dir: join(dir, 'compressed'),
    organizeDest: dest,
    options: { organize: true, embed: false, csv: false, nas: false, copy: false },
    items: [{ ...a, rel: '2026 - Client Work/Gourgess Lawns' }],
  });
  assert.equal(summary.ok, true, JSON.stringify(summary.errors));
  assert.equal(existsSync(join(dest, '2026 - Client Work', 'Gourgess Lawns', 'mv.mp4')), true, 'it landed');
  assert.equal(existsSync(a.sourcePath), false, 'and the source is gone — an explicit move');
});

test('the copy is VERIFIED, byte for byte, not just written', async () => {
  // He will later trust the project copy instead of the archive. A copy nobody checked is a rumour.
  const dest = projects();
  const a = clip('verify.mp4');
  await app.invoke('finalize:run', {
    dir: join(dir, 'compressed'),
    organizeDest: dest,
    options: { organize: true, embed: false, csv: false, nas: false },
    items: [{ ...a, rel: 'Client/X' }],
  });
  const landed = join(dest, 'Client', 'X', 'verify.mp4');
  assert.deepEqual(readFileSync(landed), readFileSync(a.sourcePath), 'byte-for-byte identical');

  // …and organizeMove routes BOTH modes through the one staged+verified writer, so a copy can never
  // become a second, unchecked implementation of "write the footage somewhere".
  const src = readFileSync(join(ROOT, 'main-mod', '02-media.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function organizeMove('));
  assert.match(fn.slice(0, 400), /const place = copy \? copyFileVerified : moveFileCrossDevice;/);
  const staged = src.slice(src.indexOf('async function stageVerifiedCopy('));
  assert.match(staged.slice(0, 600), /fingerprintsMatch\(src, tmp, \{ full: true \}\)/, 'full verify, not sampled');
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

test('the shape that used to move nothing now files by date', async () => {
  // THIS TEST USED TO LOCK IN A BUG AS DOCUMENTATION. Empty category/project (the normal case) + no
  // plan → subdirParts is [], the file is already in `dest`, organizeMove says in-place, and Run
  // reported "skipped" — which looked like a no-op because it was one. It was captured deliberately,
  // to show why the destination map became the source of truth.
  //
  // That no-op is now fixed (2026-07-19bo): a clip we cannot place goes to `<date>/_unsorted` rather
  // than nowhere. It matters far beyond tidiness — once the destination defaults to his real Projects
  // tree, "no computed folder" means "loose in the root of C:\...\2026", and on his machine that is
  // 310 clips. So the assertion is inverted on purpose: the shape that moved nothing now moves,
  // predictably, somewhere he can find it.
  //
  // In "organize in place" mode (dest === src, as here) that means dated subfolders INSIDE the
  // Compressed folder — which is exactly what that mode's own label promises.
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

  assert.equal(summary.moved, 1, 'it is filed now, instead of silently going nowhere');
  assert.equal(summary.skipped, 0, 'and no longer reported as a no-op');
  // Filing COPIES by default, so the original stays put — his standing rule.
  assert.equal(existsSync(sourcePath), true, 'the source is untouched');
  // The contract is "a folder, never the bare root" — WHICH folder depends on the fallback ladder:
  // the record's own subject first (this clip has subject 'x'), then its date, then `<date>/_unsorted`.
  // Asserting specifically on a dated folder pinned the wrong rung and broke when the subject rung
  // landed; the property that matters is that it is no longer sitting loose where it started.
  const filed = readdirSync(src, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.ok(filed.length > 0, `it landed in a subfolder rather than the root — found ${JSON.stringify(filed)}`);
  // ...and then this line pinned the leaf ANYWAY, which is how it broke again when clips started
  // grouping by shoot date under the subject (2026-07-19cd). The comment above had the right idea and
  // the assertion did not follow it. Assert the subject FOLDER exists and the clip is somewhere
  // beneath it — the depth is the ladder's business.
  assert.equal(existsSync(join(src, 'x')), true, 'under its own subject, which is the best field it has');
  const under = readdirSync(join(src, 'x'), { withFileTypes: true });
  const here = under.some((e) => e.isFile() && e.name === 'nowhere.mp4');
  const nested = under.filter((e) => e.isDirectory())
    .some((d) => readdirSync(join(src, 'x', d.name)).includes('nowhere.mp4'));
  assert.ok(here || nested, `the clip is under its subject — found ${JSON.stringify(under.map((e) => e.name))}`);
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

// --- WILL IT EVEN FIT? --------------------------------------------------------------------------
//
// This is not hypothetical on his machine: C: has 31 GB free and the compressed archive is 73 GB.
// Copying adds bytes to the destination, and C: is the tight disk AND the system disk. Discovering
// that 40 clips into a run — half a shoot filed, system disk full — is the worst possible moment.

test('a run that will not fit is refused BEFORE a single byte is written', async () => {
  const dest = projects();
  const a = clip('huge.mp4');

  // Pretend the destination volume is nearly full.
  const g = app.get('globalThis');
  const realStatfs = g.__statfsPatch;
  const fsp = app.get('fsp');
  const orig = fsp.statfs;
  fsp.statfs = async () => ({ bavail: 1, bsize: 1024, blocks: 1000, files: 0 });   // ~1 KB free
  try {
    const summary = await app.invoke('finalize:run', {
      dir: join(dir, 'compressed'),
      organizeDest: dest,
      options: { organize: true, embed: false, csv: false, nas: false },
      items: [{ ...a, rel: 'Client/X' }],
    });
    assert.equal(summary.ok, false, 'it must refuse rather than half-file the shoot');
    assert.match(summary.error, /Not enough room/);
    assert.match(summary.error, /free on that drive/);
    assert.equal(existsSync(join(dest, 'client', 'x', 'huge.mp4')), false, 'nothing was written');
    assert.equal(existsSync(a.sourcePath), true, 'and the archive is untouched');
  } finally { fsp.statfs = orig; void realStatfs; }
});

test('a run that DOES fit is not blocked by the guard', async () => {
  const dest = projects();
  const a = clip('small.mp4');
  const fsp = app.get('fsp');
  const orig = fsp.statfs;
  fsp.statfs = async () => ({ bavail: 1e9, bsize: 1024, blocks: 2e9, files: 0 });   // ~1 TB free
  try {
    const summary = await app.invoke('finalize:run', {
      dir: join(dir, 'compressed'),
      organizeDest: dest,
      options: { organize: true, embed: false, csv: false, nas: false },
      items: [{ ...a, rel: 'Client/Y' }],
    });
    assert.equal(summary.ok, true, JSON.stringify(summary.errors));
    assert.equal(existsSync(join(dest, 'Client', 'Y', 'small.mp4')), true);
  } finally { fsp.statfs = orig; }
});

test('the guard keeps headroom — it never fills a system disk to the last byte', () => {
  // C: is his SYSTEM disk. Filling it completely breaks the machine, not just this app.
  const src = readFileSync(join(ROOT, 'main-mod', '09-ipc-boot.js'), 'utf8');
  const fn = src.slice(src.indexOf('WILL IT EVEN FIT'));
  assert.match(fn.slice(0, 900), /need \+ 2e9 > free/, '2 GB of headroom');
});

test('a MOVE within the same volume is not blocked by a space check it does not need', async () => {
  // Moving doesn't consume space. Applying the copy guard to it would refuse a legitimate run.
  const src = readFileSync(join(ROOT, 'main-mod', '09-ipc-boot.js'), 'utf8');
  const fn = src.slice(src.indexOf('WILL IT EVEN FIT'));
  assert.match(fn.slice(0, 900), /if \(opts\.organize && dest && copyMode\)/, 'the space check is copy-only');
});

test('the Organize screen shows what is coming back, and whether it fits', () => {
  // "I would like to be able to select what footage goes back here onto my computer." That is a real
  // decision on his machine — 73 GB archive, 31 GB free on C: — so the two numbers that decide it must
  // be on screen BEFORE he presses Run. finalize:run refuses a run that won't fit, but a refusal at the
  // end of a long think is a worse answer than a number he could see all along.
  const src = readFileSync(join(ROOT, 'src', 'mod', '09-phone-finalize.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function renderFinSpace('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  assert.match(body, /sel\.reduce\(\(n, f\) => n \+ \(f\.size \|\| 0\), 0\)/, 'how much he selected');
  assert.match(body, /window\.api\.freeSpace\(dest\)/, 'how much room is left');
  assert.match(body, /need \+ 2e9 > free/, 'and the same 2 GB headroom the run itself enforces');

  // A MOVE consumes no space on the destination. Warning about a problem he has just solved by
  // switching to move would be noise.
  assert.match(body, /const copying = \$\('finKeepSource'\)/, 'only a COPY can run out of room');
  assert.match(body, /const tight = copying && free !== null/);

  const boot = readFileSync(join(ROOT, 'src', 'mod', '10-boot.js'), 'utf8');
  assert.match(boot, /\$\('finKeepSource'\)\.addEventListener\('change', \(\) => \{ renderFinMap\(\); \}\)/,
    'and it recomputes when he switches copy/move');
});

// --- IT MUST FILE INTO THE FOLDER HE ALREADY HAS ------------------------------------------------
//
// His tree: C:\Users\jakeg\Videos\02 - Projects\2026\{2026 - Client Work\Gourgess Lawns, ...}
//
// The old code ran every folder name through slugFolder(). "2026 - Client Work/Gourgess Lawns" became
// "2026-client-work/gourgess-lawns" — a BRAND NEW folder, created right beside the real one, holding
// the new footage while every edit he has ever made sits in the other. Silently forking his project
// tree, a little more on every single run. Filing a clip into a folder that merely RESEMBLES the one
// he picked is not organizing.

test('an EXISTING folder is reused, whatever case the plan asks for', async () => {
  const dest = projects();
  mkdirSync(join(dest, '2026 - Client Work', 'Gourgess Lawns'), { recursive: true });
  const a = clip('reuse.mp4');

  // The AI answered in lower case; the folder on disk is Title Case. On Windows these are ONE folder,
  // and his file browser must keep showing the name HE gave it.
  await app.invoke('finalize:run', {
    dir: join(dir, 'compressed'),
    organizeDest: dest,
    options: { organize: true, embed: false, csv: false, nas: false },
    items: [{ ...a, rel: '2026 - client work/gourgess lawns' }],
  });

  assert.equal(existsSync(join(dest, '2026 - Client Work', 'Gourgess Lawns', 'reuse.mp4')), true,
    'it landed in the folder he already had');
  assert.equal(existsSync(join(dest, '2026 - client work')), false,
    'AND IT DID NOT FORK HIS TREE with a second, lower-case folder');
});

test('a genuinely new project folder is created with the name as given, not slugged', async () => {
  const dest = projects();
  const a = clip('newproj.mp4');
  await app.invoke('finalize:run', {
    dir: join(dir, 'compressed'),
    organizeDest: dest,
    options: { organize: true, embed: false, csv: false, nas: false },
    items: [{ ...a, rel: '2026 - Client Work/Charles Wedding' }],
  });
  assert.equal(existsSync(join(dest, '2026 - Client Work', 'Charles Wedding', 'newproj.mp4')), true,
    'a new folder keeps its capitals and spaces, so it sits beside his others without looking foreign');
});

test('a plan can never escape the Projects root', async () => {
  // rel comes from a model and from a text box. Neither gets to write outside the tree.
  const dest = projects();
  const a = clip('escape.mp4');
  await app.invoke('finalize:run', {
    dir: join(dir, 'compressed'),
    organizeDest: dest,
    options: { organize: true, embed: false, csv: false, nas: false },
    items: [{ ...a, rel: '../../../Windows/System32' }],
  });
  assert.equal(existsSync(join(dest, '..', '..', '..', 'Windows')), false, 'no traversal');
  // '..' sanitizes to nothing, so the clip has no destination and is left alone rather than dumped.
  assert.equal(existsSync(a.sourcePath), true);
});
