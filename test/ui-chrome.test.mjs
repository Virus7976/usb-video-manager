// Home-screen chrome. These are structural CSS/markup guards — they can't judge taste, but they can
// stop a specific, identified visual defect from silently coming back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(ROOT, 'src', 'styles.css'), 'utf8');
const html = readFileSync(join(ROOT, 'src', 'index.html'), 'utf8');
const core = readFileSync(join(ROOT, 'src', 'mod', '01-core.js'), 'utf8');

// --- the Auto-mode switch is a SWITCH, not a checkbox ------------------------------------

test('the Auto-mode switch does not also draw a checkmark', () => {
  // The global `input[type="checkbox"]::after` rule draws a tick inside every checkbox. The Auto-mode
  // control overrides ::before (the knob) but never turned the tick off — so it rendered a checkmark
  // AND a knob stacked on top of each other inside one 40px control. The knob's position is the only
  // indicator a switch needs.
  assert.match(css, /\.am-toggle input\[type="checkbox"\]::after \{ content: none; \}/,
    'the inherited tick is explicitly cancelled for the switch');
});

test('…but a REAL checkbox still gets its tick', () => {
  // The fix must be scoped to .am-toggle. Killing the global ::after would silently turn every
  // checkbox in the app into a blank square.
  assert.match(css, /input\[type="checkbox"\]:checked::after \{ transform: rotate\(45deg\) scale\(1\); \}/,
    'the global tick rule is intact');
  // And the cancel is scoped — it must not be a bare `input[type="checkbox"]::after { content: none }`.
  const bare = css.split('\n').some((l) => /^\s*input\[type="checkbox"\]::after\s*\{[^}]*content:\s*none/.test(l));
  assert.equal(bare, false, 'the tick is never cancelled globally');
});

// --- the "work waiting" cards use the house language ---------------------------------------

test('the pending-work cards are settings-cards — which is what fixes the black text', () => {
  // They used to be bare <button>s that never set `color`, so they inherited the UA default: BLACK
  // text on a dark card. .settings-card sets `color: var(--text)`, so adopting it fixes the text, the
  // padding, the hover and the border in one move.
  assert.match(core, /class="settings-card action pw-card" id="pwPhone"/);
  assert.match(core, /class="settings-card action pw-card" id="pwGo"/);
  assert.match(css, /\.settings-card \{[^}]*color: var\(--text\)/s, 'settings-card is what supplies the text colour');
});

test('the cards are not washed in accent any more', () => {
  // Each card was flooded with accent-14% behind an accent-40% border, so two stacked read as two
  // competing alert boxes drowning the Devices list beneath them. The accent is now a slim rail plus
  // the CTA pill — enough to say "this needs you" without shouting.
  // Prove the anchors resolved. Renaming `.pw-card` would make this `slice(-1)` — one character —
  // and the "no accent wash" check below would then pass while looking at nothing, silently. A length
  // guard does not catch it; the index must be. See test/assertions-cannot-pass-vacuously.test.mjs.
  const start = css.indexOf('.pw-card {');
  const end = css.indexOf('.pw-cta {');
  assert.ok(start > -1, 'found the .pw-card rule');
  assert.ok(end > start, 'and .pw-cta after it');
  const rule = css.slice(start, end);
  assert.equal(/background:\s*color-mix\(in srgb, var\(--accent\) 1[0-9]%/.test(rule), false,
    'no full-card accent wash');
  assert.match(css, /\.pw-card::before \{[\s\S]*?background: var\(--accent\);/, 'a slim accent rail instead');
});

// --- icons are line icons, not emoji --------------------------------------------------------

test('the home screen uses line icons, not colour emoji', () => {
  // 📱 / 🎬 / ⚡ rendered as full-colour clip-art beside monochrome SVG icons.
  const strip = (s) => s.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('<!--')).join('\n');
  const coreCode = strip(core);
  const pending = coreCode.slice(coreCode.indexOf('async function renderPendingWork'));
  const body = pending.slice(0, pending.indexOf('\n}\n'));
  assert.equal(/[\u{1F300}-\u{1FAFF}]/u.test(body), false, 'no emoji in the pending-work cards');
  assert.match(body, /\$\{DL_ICON_PHONE\}/);
  assert.match(body, /\$\{PW_ICON_FILM\}/);
  assert.match(html, /class="am-bolt"/, 'the Auto-mode bolt is an SVG');
});

test('the footage icon is not mistakable for the SD-card icon', () => {
  // A clapperboard was the obvious choice and it was WRONG: at the 19px the chip renders it at, its
  // diagonals disappear and it collapses into "rounded rect with a horizontal line" — which is
  // exactly the SD-card icon sitting a few pixels below it in the Devices list.
  const iconOf = (name) => {
    const m = core.match(new RegExp('const ' + name + " = `([^`]*)`"));
    return m ? m[1] : '';
  };
  const film = iconOf('PW_ICON_FILM');
  const card = iconOf('DL_ICON_CARD');
  assert.ok(film && card);
  assert.notEqual(film, card);
  assert.match(film, /M7\.5 5v14M16\.5 5v14/, 'the film strip has vertical sprocket rails — legible at 19px');
  assert.equal(/M7\.5 6 6 10\.5/.test(film), false, 'the clapper diagonals are gone');
});
