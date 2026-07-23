// ⚠⚠ A TEMPLATE THAT NAMES SOMETHING THAT DOES NOT EXIST TAKES OUT THE WHOLE SCREEN.
//
// Shipped in 0.7.1: a Home card interpolated `${CHEV}`, an identifier I invented. `renderPendingWork()`
// threw on the first card it built, so the entire pending-work area rendered EMPTY — no offline
// warning, no "footage ready to organize", nothing. One typo, a blank screen.
//
// Its unit test passed the whole time. `assert.match(core, /Nothing is lost/)` is true of code that
// never runs, and every structural assertion in this repo is that kind of claim.
//
// The e2e caught it, but only because I happened to be adding a card next to it. This is the standing
// version: it sweeps the WHOLE bundled renderer, so the next ghost fails on the next `npm run check`
// rather than after a release.
//
// ⚠ It is a source check, and that is a real limitation — it proves the name resolves, not that the
// screen looks right. It is worth having because the failure it catches is catastrophic and silent,
// and because it is the one property of a template a grep genuinely CAN decide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'src/renderer.js'), 'utf8');

// Things that exist without being declared in this file.
const AMBIENT = new Set([
  'undefined', 'null', 'true', 'false', 'window', 'document', 'console', 'navigator', 'screen',
  'String', 'Number', 'Math', 'JSON', 'Date', 'Array', 'Object', 'Boolean', 'Set', 'Map', 'Promise',
  'location', 'performance', 'requestAnimationFrame', 'setTimeout', 'clearTimeout',
]);

// Is `name` bound anywhere in the bundle? Deliberately generous — a false NEGATIVE here is a missed
// bug, but a false POSITIVE is a red suite over working code, and the second kind gets tests deleted.
// Destructuring counts, including renamed (`{ total: homelessN }`) which the first draft of this
// sweep missed and reported as a ghost.
const isBound = (n) => new RegExp(
  `(?:const|let|var|function|class)\\s+${n}\\b`          // plain declaration
  + `|(?:const|let|var)\\s*[{[][^}\\]]*\\b${n}\\b[^}\\]]*[}\\]]`  // destructured, incl. renamed
  + `|\\b${n}\\s*=>`                                      // single-arg arrow
  + `|\\([^)]*\\b${n}\\b[^)]*\\)\\s*(?:=>|\\{)`           // parameter
  + `|\\bfor\\s*\\(\\s*(?:const|let|var)\\s+${n}\\b`      // loop binding
  + `|\\bcatch\\s*\\(\\s*${n}\\b`,                        // catch binding
).test(src);

test('⚠⚠⚠ every identifier interpolated into a template actually exists', () => {
  const used = new Set([...src.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]));
  const ghosts = [...used].filter((n) => !AMBIENT.has(n) && !isBound(n));
  assert.deepEqual(ghosts, [],
    `⚠⚠⚠ interpolated but never defined — the render throws and the screen goes BLANK: ${ghosts.join(', ')}`);
});

test('⚠ the sweep is actually looking at something', () => {
  // Guards the failure mode this repo produces most: a scan that quietly matches nothing and reports
  // a clean result forever. If the bundle changes shape, this fails rather than passing vacuously.
  const used = [...src.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
  assert.ok(used.length > 100, `⚠ found the interpolations (${used.length})`);
  assert.ok(src.length > 100000, '⚠ and the real bundled renderer');
});

test('⚠⚠ a ghost WOULD be caught — the check can fail', () => {
  // The sweep above passes today, which proves nothing on its own. Run the same logic over a sample
  // containing a known ghost and confirm it is found.
  const sample = 'const real = 1; const html = `<b>${real}</b><i>${GHOST_NAME}</i>`;';
  const used = new Set([...sample.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]));
  const bound = (n) => new RegExp(`(?:const|let|var|function|class)\\s+${n}\\b`).test(sample);
  const ghosts = [...used].filter((n) => !AMBIENT.has(n) && !bound(n));
  assert.deepEqual(ghosts, ['GHOST_NAME'], '⚠⚠ the detector really detects');
});
