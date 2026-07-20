// `core/` is the first step of the architecture in ARCHITECTURE.md: ordinary CommonJS modules that
// BOTH the bundled main.js and a future HTTP backend can require, so logic can be shared without
// un-concatenating the 11,000 lines of main-mod/ (which was estimated as the single largest cost in
// that plan, and turns out to be avoidable).
//
// ⚠⚠ THE FAILURE THIS FILE EXISTS TO PREVENT — and it is one NO OTHER TEST CAN SEE.
//
// package.json → build.files is an ALLOWLIST. A new top-level directory matches nothing in it, so
// electron-builder simply does not copy it into app.asar. Meanwhile `npm start`, `npm run check`,
// `npm run test:e2e` and every unit test run from the working tree, where core/ exists on disk — so
// they ALL PASS. The only symptom is that the installed app fails to boot with
//
//     Error: Cannot find module './core/clip-key'
//
// on HIS machine, after a deploy, with a green suite behind it. That is the worst failure shape this
// project can produce, and the repo already contains proof it is real: watch-drives.js sits at the
// repo root, is syntax-checked by `npm run check`, and is absent from the shipped app for exactly
// this reason.
//
// Verified once by hand against a real build (`electron-builder --dir`, then `asar list`), which
// showed `\core\clip-key.js` inside app.asar. This test is the permanent guard so the next module
// added to core/ cannot reintroduce it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('⚠⚠ core/ is in the packaging allowlist', () => {
  const files = (pkg.build && pkg.build.files) || [];
  assert.ok(files.length > 0, 'build.files exists and is an allowlist');
  const covered = files.some((f) => f === 'core/**/*' || f === '**/*');
  assert.ok(covered,
    `⚠ core/ would be DROPPED from app.asar. Every test still passes and the installed app fails to boot. build.files = ${JSON.stringify(files)}`);
});

test('⚠ every core/ module is required as ./core/, never ../core/', () => {
  // The require line is written inside a main-mod file but EXECUTES from the concatenated main.js at
  // the repo root, so the path resolves from there. `../core/` fails in tests and in production
  // alike — loudly, which is the one mercy — but pinning it stops the confusion recurring.
  const dir = join(root, 'main-mod');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    const bad = src.match(/require\(['"]\.\.\/core\//g) || [];
    assert.deepEqual(bad, [], `⚠ ${f} uses ../core/ — it must be ./core/, resolved from the bundled main.js at the root`);
  }
});

test('⚠⚠ core/ modules are STATELESS', () => {
  // Node's require cache is per-PROCESS, but the harness re-evaluates main.js in a fresh vm context
  // for every loadMain(). So a core/ module is evaluated ONCE per test file and shared by every
  // loadMain() in it — module-level mutable state would leak between tests, a failure mode this
  // codebase has never had and would waste a long time diagnosing.
  //
  // Checks for top-level `let`/`var` declarations, which are the way that state would appear.
  // `const` holding a frozen primitive or a pure function is fine.
  const dir = join(root, 'core');
  const mods = readdirSync(dir).filter((n) => n.endsWith('.js'));
  assert.ok(mods.length > 0, 'there is at least one core module to check');
  for (const f of mods) {
    const src = readFileSync(join(dir, f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const mutable = src.match(/^(?:let|var)\s+\w+/gm) || [];
    assert.deepEqual(mutable, [],
      `⚠ ${f} declares module-level mutable state (${mutable.join(', ')}) — it is shared across every loadMain() in a test file`);
  }
});

test('the pilot module really is what main-mod uses', () => {
  // Guard against the module existing but being dead — main-mod keeping its own copy would mean the
  // two drift, which is the exact "twin" failure this repo keeps producing.
  const fb = readFileSync(join(root, 'main-mod', '08-finalize-feedback.js'), 'utf8');
  assert.match(fb, /const \{ clipKeyStem, clipKeyHasMtime, clipKeyMatches, clipKeyFileName, finalMetaKeyMatches \} = require\('\.\/core\/clip-key'\);/,
    'it requires the shared module');
  for (const fn of ['clipKeyStem', 'clipKeyHasMtime', 'clipKeyMatches', 'clipKeyFileName', 'finalMetaKeyMatches']) {
    assert.ok(!fb.includes(`function ${fn}(`), `⚠ ${fn} still has a local definition in main-mod — that is a twin waiting to drift`);
  }
});

test('the module is importable on its own, with no Electron and no bundle', () => {
  // The whole point: a future HTTP server requires this directly. If it needed the bundle's shared
  // scope it would fail here, which is the cheapest possible early warning.
  const src = readFileSync(join(root, 'core', 'clip-key.js'), 'utf8');
  assert.doesNotMatch(src, /require\(['"]electron['"]\)/, 'no Electron dependency');
  assert.doesNotMatch(src, /\bconfig\b\s*[.[]/, 'no reach into the bundle’s shared config');
  assert.match(src, /module\.exports = \{/, 'and it exports properly');
});

test('the exported behaviour is correct when imported directly', async () => {
  // Not a re-test of clipKeyMatches (that is covered against the running app elsewhere) — this
  // proves the module WORKS STANDALONE, which is the property that makes it reusable.
  const m = await import(`file://${join(root, 'core', 'clip-key.js')}`);
  const { clipKeyMatches, finalMetaKeyMatches, clipKeyHasMtime } = m.default;
  const V2 = 'GX010042.MP4__1000__1700000000000';
  const V1 = 'GX010042.MP4__1000';
  assert.equal(clipKeyMatches(V2, V1), true, 'V2 matches its legacy form');
  assert.equal(clipKeyMatches(V2, 'GX010042.MP4__1000__1800000000000'), false,
    'two fully-qualified keys that differ are different clips — never fall through to the stem');
  assert.equal(clipKeyHasMtime(V2), true);
  assert.equal(clipKeyHasMtime(V1), false);
  assert.equal(finalMetaKeyMatches(V2, 'gx010042.mp4'), true, 'and it bridges to the name-keyed store');
  assert.equal(finalMetaKeyMatches(V2, 'other.mp4'), false);
  assert.equal(finalMetaKeyMatches('', 'gx010042.mp4'), false, 'an empty key matches nothing');
});
