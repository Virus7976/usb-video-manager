// A rebuild-the-whole-list render must not throw away the user's scroll position.
//
// WHY THIS EXISTS. The owner, mid-review of a 4594-clip card with 4263 left:
//   "if I click a face it shoots me up randomly to a random spot near the top of the list…
//    every click takes forever to register… it all glitches… stuff shifts around."
// The cause was one line: `scroll.innerHTML = …` inside render(), called on EVERY interaction.
// Assigning innerHTML empties the container, so the browser clamps scrollTop to 0; the position is
// never restored. At 4500 clips that is the difference between a usable pass and an unusable one.
//
// The deeper problem is that this class of bug was INVISIBLE to the test suite. Renderer fixes were
// "inspection-verified", and nothing drove a list screen at volume — so scroll reset, replayed
// entrance animations and re-render cost could never fail a test. Green said nothing about feel.
// This file makes the structural half enforceable, the same way renderer-async-cleanup.test.mjs
// made "cleanup must be in a finally" enforceable after that bug class bit repeatedly.
//
// THE RULE: if a function rebuilds a container by assigning `.innerHTML`, and that function is a
// re-render (it is called again on user interaction), it must preserve scrollTop across the rebuild.
// If this trips, FIX THE CODE — capture `scrollTop` before the assignment and restore it after.
// Do not loosen the rule; the whole point is that the failure is silent and only shows up as "the
// app feels broken" on a card big enough to matter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MOD_DIR = join(process.cwd(), 'src', 'mod');
const files = readdirSync(MOD_DIR).filter((f) => f.endsWith('.js')).sort();

/** Every function body in `src`, as {start,end} spans (brace-matched). */
function functionSpans(src) {
  const spans = [];
  const header = /(?:\basync\s+)?\bfunction\b[^(]*\([^)]*\)\s*\{|\([^()]*\)\s*=>\s*\{|\b[A-Za-z_$][\w$]*\s*=>\s*\{/g;
  let m;
  while ((m = header.exec(src))) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    if (open < 0) continue;
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') { depth -= 1; if (depth === 0) { spans.push({ start: m.index, end: i + 1 }); break; } }
    }
  }
  return spans;
}

/** The smallest function body containing `idx`. */
function owningFn(src, spans, idx) {
  const containing = spans
    .filter((s) => s.start <= idx && idx < s.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start));
  return containing.length ? containing[0] : null;
}

test('a re-render that rebuilds innerHTML preserves the scroll position', () => {
  const offenders = [];
  for (const file of files) {
    const src = readFileSync(join(MOD_DIR, file), 'utf8');
    const spans = functionSpans(src);
    // Only containers that are plausibly the scrolling element. `scroll`/`list`/`grid`-ish names are
    // where this bug lives; guarding literally every innerHTML (chips, a label, a modal built once)
    // would be noise, and noise is how a guard gets switched off.
    const re = /\b(scroll|list|grid|body|container|wrap)\w*\.innerHTML\s*=/gi;
    let m;
    while ((m = re.exec(src))) {
      const fn = owningFn(src, spans, m.index);
      if (!fn) continue;
      const body = src.slice(fn.start, fn.end);
      // A re-render is a function that gets called again on interaction. The reliable signal without
      // running the app: the file calls it from an event handler, i.e. its name appears as a bare
      // `name()` call elsewhere. `render` is the established name for these in this codebase.
      const isRerender = /\bfunction\s+render\b/.test(body) || /^\s*function\s+render\s*\(/m.test(body);
      if (!isRerender) continue;
      // Deliberate exemption, e.g. a filtered list where jumping to the top IS the right behaviour
      // (type a new query in the command palette and you want result #1, not your old offset).
      // It must be stated in the code with a reason — the point is that the choice is visible in
      // review, not that the guard can be quietly switched off.
      if (/\/\/\s*scroll-reset-ok:/.test(body)) continue;
      if (!/\.scrollTop\b/.test(body)) {
        offenders.push(`${file}: ${m[0].trim()} — rebuilds a scroll container without preserving scrollTop`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `A re-render rebuilt a scrolling container and dropped the user's place.\n`
    + `Capture scrollTop before the innerHTML assignment and restore it straight after.\n`
    + offenders.join('\n'));
});

test('list items that are rebuilt on every render carry no entrance animation', () => {
  // Second half of the same bug. Because innerHTML recreates every node, a CSS entrance animation on
  // a list item REPLAYS across the whole list on every click — a fade+translate+scale of hundreds of
  // cards per interaction. That was the dominant source of "it all glitches / stuff shifts around",
  // and it also violates the documented motion policy (restrained; no delight flourishes) that the
  // calm-motion pass applied everywhere except here.
  const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
  const REBUILT = ['.face-grid-card-item', '.face-scene'];
  for (const sel of REBUILT) {
    const rule = new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`).exec(css);
    if (!rule) continue;
    assert.equal(/animation:\s*fgc-in/.test(rule[1]), false,
      `${sel} is recreated on every render — an entrance animation here replays across the whole list on every click`);
  }
});
