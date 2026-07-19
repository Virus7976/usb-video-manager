// #8 fallout: drafts are WRITTEN under the V2 key and CLEARED under the legacy one, so they never
// actually clear.
//
// `buildDraftMap` (src/mod/01-core.js) keys every draft with `clipKeyV2` — `name__size__mtime` —
// and card-scanned clips always carry an mtime (main-mod/02-media.js stats them), so 100% of drafts
// from a card import land under the 3-part key. But the post-copy cleanup in
// src/mod/09-phone-finalize.js hand-built the OLD 2-part key:
//
//     window.api.clearDrafts(verifiedClips.map((f) => `${f.name}__${f.size}`));
//
// …and `drafts:clear` deletes by exact key. So nothing matched and nothing was cleared. This is the
// opposite direction from the by-design "read V2, fall back to V1" fallback: here a V1 key is used
// to ADDRESS a V2-written entry, with no fallback on either side. `copied:forget` was taught to
// match across the migration boundary with `clipKeyMatches`; `drafts:clear` never was.
//
// Two harms, and the second got worse when named drafts were exempted from the age prune:
//   1. re-inserting the card re-offers names for clips the user already imported and dealt with;
//   2. drafts.json grows without bound until DRAFTS_CAP starts evicting — at which point genuinely
//      pending, not-yet-copied named drafts are what gets thrown away.
//
// Direction of risk, checked before choosing cross-form matching: a MISS leaves a stale draft (the
// bug above); a BLEED would delete a different clip's typed name. A bleed can only happen between
// two clips that share name AND size — which under the legacy key were already ONE entry, so there
// is nothing to bleed between. Fully-qualified keys that differ never match (clipKeyMatches).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

test('drafts:clear removes a draft written under the V2 key', async () => {
  await app.invoke('drafts:save', {
    'GX010042.MP4__4096__1700000000000': { subject: 'mowing', description: 'front lawn' },
  });
  await app.invoke('drafts:clear', ['GX010042.MP4__4096__1700000000000']);
  const left = app.plain(app.get('config').renameDrafts);
  assert.equal(left['GX010042.MP4__4096__1700000000000'], undefined, 'the copied clip\'s draft is gone');
});

test('a LEGACY-keyed draft still clears when asked with the V2 key', async () => {
  // Everything already on disk predates the migration. If the cleanup only matched exact keys, every
  // pre-migration draft would be permanently unclearable.
  await app.invoke('drafts:save', { 'OLD001.MP4__2048': { subject: 'skating', description: '' } });
  // drafts:save re-keys nothing, so plant is exact; ask with the fully-qualified form the renderer
  // now sends.
  await app.invoke('drafts:clear', ['OLD001.MP4__2048__1700000000000']);
  const left = app.plain(app.get('config').renameDrafts);
  assert.equal(left['OLD001.MP4__2048'], undefined, 'the legacy draft cleared via cross-form match');
});

test('clearing one clip does NOT clear a different clip\'s typed name', async () => {
  // The bleed direction. These differ in size, so they were never the same key even legacy-side.
  await app.invoke('drafts:save', {
    'KEEP.MP4__9999__1700000000000': { subject: 'keep me', description: 'not copied yet' },
    'GONE.MP4__1111__1700000000000': { subject: 'gone', description: '' },
  });
  await app.invoke('drafts:clear', ['GONE.MP4__1111__1700000000000']);
  const left = app.plain(app.get('config').renameDrafts);
  assert.equal(left['GONE.MP4__1111__1700000000000'], undefined, 'the asked-for draft cleared');
  assert.ok(left['KEEP.MP4__9999__1700000000000'], 'the untouched clip keeps its typed name');
  assert.equal(left['KEEP.MP4__9999__1700000000000'].subject, 'keep me');
});

test('two fully-qualified keys that differ never match each other', async () => {
  // The #8 collision itself: same name, same size, different shoots. Clearing one must not clear the
  // other, or importing one card wipes the names typed for another.
  await app.invoke('drafts:save', {
    'GX010042.MP4__4096__1700000000000': { subject: 'shoot A', description: '' },
    'GX010042.MP4__4096__1700000999000': { subject: 'shoot B', description: '' },
  });
  await app.invoke('drafts:clear', ['GX010042.MP4__4096__1700000000000']);
  const left = app.plain(app.get('config').renameDrafts);
  assert.equal(left['GX010042.MP4__4096__1700000000000'], undefined, 'shoot A cleared');
  assert.ok(left['GX010042.MP4__4096__1700000999000'], 'shoot B survived — different mtime, different clip');
});

test('the renderer sends the SAME key form it wrote', async () => {
  // Positive assertion (it fails if the call is reverted), unlike a "the old text is absent" check,
  // which stays green when a rule is disabled without restoring the old spelling.
  const src = readFileSync(join(process.cwd(), 'src', 'mod', '09-phone-finalize.js'), 'utf8');
  const call = src.slice(src.indexOf('window.api.clearDrafts('));
  const arg = call.slice(0, call.indexOf('\n'));
  assert.match(arg, /clipKeyV2/, 'the post-copy cleanup keys by clipKeyV2, matching buildDraftMap');
  assert.doesNotMatch(arg, /\$\{f\.name\}__\$\{f\.size\}/, 'and no longer hand-builds the legacy key');
});
