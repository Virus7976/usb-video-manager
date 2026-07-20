// Tier 1 item 7 — "make the payoff visible, not buried."
//
// Every card on the Home screen is a DEMAND: footage waiting, faces waiting, clips to organize.
// Nothing there has ever shown him what the work produced. That asymmetry is the measured problem in
// one line — **267 face decisions, 354 typed fields, and a project ledger that read 0** — because an
// app that only ever says "you still have things to do" is one you stop opening.
//
// The ledger is the only honest source for this. It gains an entry when a clip really landed in his
// Projects tree, so the number cannot flatter him: it was 0 for months precisely because nothing had
// been filed, and it would have been wrong to show anything else.
//
// Deliberately quiet, and deliberately last. A reward card that shouts competes with the work that
// still needs him — and on a fresh install, with nothing filed, it must not appear at all rather than
// greet a new user with a zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const strip = (s) => s.replace(/\/\/.*$/gm, '');
const core = strip(readFileSync(join(process.cwd(), 'src', 'mod', '01-core.js'), 'utf8'));
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');

const fn = (() => {
  const i = core.indexOf('async function renderPendingWork');
  assert.ok(i > -1, 'found renderPendingWork');
  const body = core.slice(i, core.indexOf('\n}', i));
  assert.ok(body.length > 200, 'and sliced a real body');
  return body;
})();

test('⚠ Home shows what he has FINISHED, not only what is outstanding', () => {
  assert.match(fn, /id="pwFiled"/, 'there is a filed card');
  assert.match(fn, /Filed and findable/, 'named for the outcome, not the mechanism');
});

test('⚠ the count comes from the LEDGER — the one source that cannot flatter him', () => {
  // Counting anything else (drafts, scanned clips, finalMeta records) would report work he has not
  // actually finished. The ledger only gains an entry when a clip really landed in his tree.
  assert.match(fn, /await window\.api\.ledgerGet\(\)/, 'asks the ledger');
  assert.match(fn, /led\.reduce\(\(n, p\) => n \+ \(Number\(p && p\.clips\) \|\| 0\), 0\)/, 'sums real filed clips');
  // Scope to the LEDGER BLOCK, not the rest of the function. renderPendingWork legitimately touches
  // other state further down; my first version scanned everything after the ledgerGet call and failed
  // on unrelated code — the assertion being too broad, not the code being wrong. Same shape as banning
  // /compress/i and matching the folder NAME "Uncompressed" (2026-07-20m).
  // Assert the INDEX, not the slice length — a collapsed slice is one character long and would
  // satisfy a length check while the doesNotMatch below proved nothing. My own meta-test
  // (assertions-cannot-pass-vacuously) failed this file for exactly that, one iteration after I
  // wrote the rule. It was right.
  const ledAt = fn.indexOf('const led =');
  const catchAt = fn.indexOf('} catch', ledAt);
  assert.ok(ledAt > -1, 'found the ledger block');
  assert.ok(catchAt > ledAt, 'and its closing catch');
  const block = fn.slice(ledAt, catchAt);
  assert.doesNotMatch(block, /renameDrafts|scannedFiles|finalMeta/, 'the count is not derived from anything softer');
});

test('⚠ nothing filed → no card at all, not a zero', () => {
  // A brand-new install must not open on "0 clips filed". That is a scoreboard for a game he has not
  // started, and it is exactly the kind of thing that makes an app feel like a chore.
  assert.match(fn, /if \(clips > 0\) \{/, 'only rendered when there is something to show');
});

test('it reports projects as well as clips', () => {
  // "1354 clips" alone is a pile. "in 39 projects" is the thing he was trying to build.
  assert.match(fn, /const projects = led\.length;/, 'projects counted');
  assert.match(fn, /project\$\{projects !== 1 \? 's' : ''\}/, 'and pluralised honestly');
});

test('⚠ a ledger failure never hides the work cards', () => {
  // The demands above are the functional part of this screen. A reward that can break them is a bad
  // trade — so the whole block is wrapped and the cards render regardless.
  // Scoped to the block, for the second time in this file: renderPendingWork has other try/catch
  // pairs further down, so "is there a catch somewhere after ledgerGet" is satisfied by unrelated
  // code — removing this block's own catch left the test green. Bound to the lines around the call.
  const at = fn.indexOf('const led =');
  assert.ok(at > -1, 'found the ledger block');
  const opensTry = fn.slice(Math.max(0, at - 120), at);
  assert.match(opensTry, /try \{\s*$/, 'the block opens inside a try');
  const closes = fn.slice(at, at + 900);
  assert.match(closes, /\} catch \{[^\n]*\}/, 'and closes with its own catch');
});

test('it is rendered LAST, after everything that still needs him', () => {
  // Order is the message: outstanding work first, receipt at the bottom.
  const facesAt = fn.indexOf('pwFaces');
  const filedAt = fn.indexOf('pwFiled');
  assert.ok(facesAt > -1 && filedAt > facesAt, 'the reward card comes after the work cards');
});

test('the button opens the real folder', () => {
  // The entire claim is "it is in your Projects tree". The card has to be able to prove that.
  assert.match(core, /filedBtn\.addEventListener\('click'/, 'the card is clickable');
  assert.match(core, /getProjectsRoot\(\)/, 'and opens the tree itself');
});

test('it is styled quieter than the work cards', () => {
  // Index-guarded, per the same rule — a renamed selector would collapse this slice and the
  // "no accent rail" check below would pass while looking at one character.
  const from = css.indexOf('.pw-card.pw-done::before');
  const to = css.indexOf('.final-dest {', from);
  assert.ok(from > -1, 'found the reward-card rule');
  assert.ok(to > from, 'and the rule after it');
  const rule = css.slice(from, to);
  assert.doesNotMatch(rule, /var\(--accent\)\s*;/, 'no accent rail — that is reserved for work that needs him');
});
