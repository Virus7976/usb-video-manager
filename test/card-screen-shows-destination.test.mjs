// Tier 1 item 8, on the screen it actually names: "show, ON THE CARD SCREEN, where each clip WILL go
// before he commits."
//
// The card screen already answered *"what will this clip be called"* — a final-name pill under every
// row. It never answered *"and where does it end up"*, which is the question he has before committing
// a whole card, and the one whose absence makes filing feel like something to check afterwards rather
// than something he decided.
//
// **The card screen must never compute this itself.** The clips are not filed yet, so it would be
// trivial to re-derive "subject/date" here from the fields on screen — and that second implementation
// would drift from `finalize:run` the first time either changed. That drift is the bug class that
// cost four separate days in this repo, most recently a badge naming a folder that did not exist. So
// it asks main (`organize:previewDest` → `destinationParts`), which is the same ladder that files.
//
// Debounced, because `refreshNames()` runs on every keystroke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const strip = (s) => s.replace(/\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
const rename = strip(readFileSync(join(process.cwd(), 'src', 'mod', '03-rename.js'), 'utf8'));
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

const fnBody = (src, name) => {
  const i = src.indexOf(`function ${name}`);
  assert.ok(i > -1, `found ${name}`);
  return src.slice(i, src.indexOf('\n}', i));
};

test('⚠ every card has a place to show its destination', () => {
  assert.match(rename, /data-dest="\$\{i\}"/, 'each row carries a destination cell');
  assert.match(rename, /class="final-dest"/, 'with its own class');
});

test('⚠⚠ the destination comes from MAIN, not from a copy of the rules here', () => {
  const fn = fnBody(rename, 'refreshWillFile');
  assert.match(fn, /window\.api\.organizePreviewDest\(/, 'it asks the one ladder');
  // The tell-tale of a second implementation: deciding a folder locally.
  assert.doesNotMatch(fn, /_unsorted|safeFolderName|\bsubject\b\s*\+/, 'it never derives a folder itself');
});

test('it sends the fields the ladder actually needs', () => {
  // subject + date are what the ladder reads. Sending the whole clip would ship face descriptors and
  // thumbnails across IPC on every keystroke.
  const fn = fnBody(rename, 'refreshWillFile');
  assert.match(fn, /meta: \{ subject: c\.subject \|\| '', date: c\.date \|\| '' \}/, 'just subject and date');
});

test('⚠ it is debounced — refreshNames runs on every keystroke', () => {
  const sched = fnBody(rename, 'scheduleWillFileRefresh');
  assert.match(sched, /clearTimeout\(_willFileTimer\)/, 'the previous request is cancelled');
  assert.match(sched, /setTimeout\(refreshWillFile, \d+\)/, 'and the new one waits');
  assert.match(fnBody(rename, 'refreshNames'), /scheduleWillFileRefresh\(\)/, 'naming triggers it');
});

test('⚠ a stale answer cannot land on a recycled row', () => {
  // The list re-renders while typing. Writing into the cells captured BEFORE the await would put one
  // clip's destination under another clip's name — a confident, wrong answer, which is worse than
  // none. It re-queries the DOM and re-reads the clip for each cell.
  const fn = fnBody(rename, 'refreshWillFile');
  const awaitAt = fn.indexOf('await window.api.organizePreviewDest');
  const requeryAt = fn.indexOf("document.querySelectorAll('[data-dest]')", awaitAt);
  assert.ok(awaitAt > -1 && requeryAt > awaitAt, 'the cells are re-queried after the answer arrives');
  assert.match(fn.slice(requeryAt), /const c = state\.scannedFiles\[Number\(el\.dataset\.dest\)\]/,
    'and each cell re-reads its own clip');
});

test('a clip with no answer shows nothing rather than something wrong', () => {
  const fn = fnBody(rename, 'refreshWillFile');
  assert.match(fn, /if \(!rel\) \{ el\.hidden = true; continue; \}/, 'no destination → no line');
});

test('a failure leaves naming completely usable', () => {
  // Main may be busy, or the AI may be off. Naming a card must never depend on this.
  const fn = fnBody(rename, 'refreshWillFile');
  assert.match(fn, /catch \{ return; \}/, 'advisory only');
});

test('it reads as an annotation, not as a second title', () => {
  // It sits directly under the final-name pill. If it competed visually, every row would look like it
  // had two headings.
  const rule = css.slice(css.indexOf('.final-dest {'), css.indexOf('.final-dest[hidden]'));
  assert.ok(rule.length > 0, 'found the rule');
  assert.match(rule, /color: var\(--text-3\)/, 'muted');
  assert.match(rule, /text-overflow: ellipsis/, 'and a long path truncates rather than wrapping the row');
});
