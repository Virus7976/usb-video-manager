// Photos never entered the import index and never had their drafts cleared, so re-inserting a card
// re-offered and re-copied every still.
//
// The video path does both, immediately after verification (src/mod/09-phone-finalize.js):
//     const keys = verifiedClips.map(importKey);
//     if (keys.length) { window.api.importsAdd(keys); keys.forEach((k) => importedSet.add(k)); }
//     window.api.clearDrafts(verifiedClips.map((f) => clipKeyV2(f)));
// with the comment "A clip that failed verification stays un-imported and keeps its draft, so
// re-inserting the card re-offers it — never trust (or forget the name of) a bad copy."
//
// `clips` there is `filesToCopy()`, which strips photos. So a still was never marked imported and its
// draft never cleared, while `distributeFlowPhotos` already computes exactly the set that should be:
// `safePhotos`, the photos with at least one VERIFIED destination — it just used it for
// `state.copied`, `recordCopied` and `saveFlowFinalMeta` and stopped there.
//
// SEVERITY, stated honestly: this is the least harmful thing in the photo-parity sweep. Re-copying
// costs time, not data — the collision guard in `phone:distribute` full-hashes and skips a
// byte-identical destination. The draft half is slightly worse: an uncleared photo draft counts
// against DRAFTS_CAP forever (see 2026-07-19aa/ac for why that matters), and re-offers a name the
// user already dealt with.
//
// ⚠ LIMITATION OF THIS TEST, stated rather than glossed: `distributeFlowPhotos` is a renderer
// function that drives real IPC, and `window.api` cannot be stubbed (contextBridge properties are
// non-writable), so there is no way to observe the calls behaviourally from either harness. These are
// source assertions — comments stripped, exact expressions named, sliced to the real block, and each
// part broken separately. A behavioural test would be better and is not available here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const raw = readFileSync(join(process.cwd(), 'src', 'mod', '09-phone-finalize.js'), 'utf8');
const src = raw.replace(/\/\/.*$/gm, '');
// The `if (safePhotos.length)` block, sliced to its closing brace — the photos that have at least one
// verified destination, which is precisely the set that may be marked imported.
const start = src.indexOf('if (safePhotos.length)');
const block = src.slice(start, src.indexOf('\n  }', start));

test('verified photos are added to the import index', () => {
  assert.ok(start > 0, 'found the safePhotos block');
  assert.match(block, /importsAdd\(/, 'the same call the video path makes');
  // `importKey` is passed as a function reference (`.map(importKey)`), so don't demand a paren after
  // it — my first version did, and failed against correct code.
  assert.match(block, /map\(importKey\)|importKey\(/, 'keyed the same way (name+size, lower-cased)');
});

test('the in-memory set is updated too, so the current session sees it', () => {
  // The video path does both — without the local add, the ⤓ "skip already imported" toggle would not
  // reflect this import until the next launch.
  assert.match(block, /importedSet\.add\(/, 'the live set is kept in step with the persisted one');
});

test('their drafts are cleared, under the V2 key', () => {
  // #8: drafts are WRITTEN under clipKeyV2, so clearing them under any other form is a no-op — that
  // exact bug cost a fix in 2026-07-19ac. An uncleared draft also counts against DRAFTS_CAP forever.
  assert.match(block, /clearDrafts\(/, 'drafts are cleared');
  // `[^)]*` cannot cross the arrow function's own parens in `map((p) => clipKeyV2(p))` — use a
  // bounded any-char span instead.
  assert.match(block, /clearDrafts\([\s\S]{0,80}clipKeyV2/, 'and keyed the way buildDraftMap wrote them');
});

test('only VERIFIED photos are marked — a failed copy is never trusted', () => {
  // The whole point of the video comment: a photo that did not verify must stay un-imported and keep
  // its draft, so re-inserting the card re-offers it. That property comes from operating on
  // safePhotos, which is built from `landed` (ok results only).
  const landed = src.indexOf('const landed = new Map()');
  assert.ok(landed > 0 && landed < start, 'safePhotos is derived from verified results before this');
  assert.match(src.slice(landed, start), /r\.ok/, 'and `landed` only records ok rows');
});

test('the existing photo bookkeeping is untouched', () => {
  // Guard the other direction: this must add to the block, not replace what it already does.
  assert.match(block, /state\.copied\.push\(/, 'photos still enter state.copied');
  assert.match(block, /recordCopied\(/, 'and the copied log');
  assert.match(block, /saveFlowFinalMeta\(safePhotos\)/, 'and their AI record still carries forward');
});
