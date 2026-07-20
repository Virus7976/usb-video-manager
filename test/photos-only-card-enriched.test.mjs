// A THIRD entry point to the same work, inheriting neither of the other two's fixes.
//
// `runCopy()` has an early branch for a card with stills and no video:
//
//     if (!files.length) { if (clipPhotos().length) { await distributeFlowPhotos(); … } return; }
//
// It returns before the line at the bottom of the function whose own comment records the bug it was
// written to fix: *"Photos are analysable — getContactSheet feeds the vision model the photo ITSELF
// rather than an ffmpeg frame grid… on a card they were silently never enriched: no observation, no
// people, no tags, nothing for Organize to place them by."*
//
// That fix was applied to the mixed-card path and to the phone path (`autoBackgroundEnrich` runs in
// runPhoneCopy too). The photos-only branch was added separately, for a different bug (photos
// dead-ended and could never be cleared off the card), and it never got it. So a GoPro stills card
// is backed up, recorded, imported, drafts cleared — and arrives at Organize with nothing known
// about it. `distributeFlowPhotos` already writes their finalMeta, so enrichment was the only piece
// missing.
//
// SECOND, in the phone flow: the photo distribute read only `copied` and swallowed the throw —
//     try { const r2 = await window.api.distributePhotos({ jobs: pjobs }); distributed = (r2 && r2.copied) || 0; } catch { }
// so a distribute that failed outright reported "0 photo copies → computer + NAS ✓". That reads
// like a routing setting was off, not like a backup that did not happen. The card path has read
// `failed` and appended "⚠ N failed to copy" since it was written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(process.cwd(), 'src', 'mod', '09-phone-finalize.js'), 'utf8').replace(/\/\/.*$/gm, '');

// The photos-only branch, sliced to its own `return` — NOT the whole function, which contains the
// mixed-card enrich call and would make any assertion here pass regardless.
const photosOnly = (() => {
  const i = src.indexOf('if (!files.length) {');
  return src.slice(i, src.indexOf('\n    return;', i));
})();

test('the photos-only branch is a real, isolated slice', () => {
  assert.ok(photosOnly.length > 0 && photosOnly.length < 1500, `sliced the branch (${photosOnly.length} chars)`);
  assert.match(photosOnly, /distributeFlowPhotos\(\)/, 'it is the branch that backs the photos up');
  assert.doesNotMatch(photosOnly, /\.\.\.clips/, 'and it does NOT reach the mixed-card call site');
});

test('a photos-only card is analysed, not just backed up', () => {
  assert.match(photosOnly, /autoBackgroundEnrich\(/, 'the stills are enriched like every other path');
});

test('it enriches the PHOTOS — the only clips it has', () => {
  // `clips` here is filesToCopy(), which is empty in this branch by definition. Passing it would be
  // a call that runs and does nothing, which is worse than no call: it looks fixed.
  assert.match(photosOnly, /autoBackgroundEnrich\(clipPhotos\(\)\)/, 'the photo list, not the empty video list');
});

test('the mixed-card path still enriches both', () => {
  // Guard the other direction: the path that already worked must keep passing photos too, since
  // that was itself a fix.
  assert.match(src, /autoBackgroundEnrich\(\[\.\.\.clips, \.\.\.clipPhotos\(\)\]\)/, 'unchanged');
});

// --- the phone flow's silent photo failure ---
const phoneDistribute = (() => {
  const i = src.indexOf('const r2 = await window.api.distributePhotos');
  return src.slice(src.lastIndexOf('try {', i), src.indexOf('\n    }', i));
})();

test('the phone flow reads the failure count, not just the success count', () => {
  assert.match(phoneDistribute, /photoFailed = \(r2 && r2\.failed\) \|\| 0;/, 'failures are captured');
});

test('a thrown distribute is counted as a failure, not as zero copies', () => {
  // The old `catch { }` left photoFailed at 0 AND distributed at 0 — indistinguishable from
  // "no destinations configured", which is the one case that legitimately copies nothing.
  assert.match(phoneDistribute, /catch \(e\) \{[\s\S]*photoFailed = photos\.length;/, 'the throw sets the count');
  assert.match(phoneDistribute, /logIssue\('Phone'/, 'and it reaches the issue log');
});

test('the summary line actually shows the warning', () => {
  // Counting failures and then not printing them is the same bug one layer in.
  assert.match(src, /const photoWarn = photoFailed \? ` — ⚠ \$\{photoFailed\} failed to copy` : '';/,
    'the warning is built');
  // Search for the end marker FROM the start marker: `const nVid` also appears in an earlier
  // function, so a bare indexOf returns a position BEFORE this one and slices to ''.
  const at = src.indexOf('const photoLine =');
  assert.ok(at > 0, 'found the summary line');
  const line = src.slice(at, src.indexOf('const nVid', at));
  assert.ok(line.length > 0, 'and sliced it to a non-empty string');
  assert.equal((line.match(/\$\{photoWarn\}/g) || []).length, 2,
    'and appended to BOTH arms — the destinations arm and the Photos-Temp arm');
});

test('the card flow still warns, in the same words', () => {
  assert.match(src, /const warn = failed \? ` — ⚠ \$\{failed\} failed to copy` : '';/, 'unchanged');
});
