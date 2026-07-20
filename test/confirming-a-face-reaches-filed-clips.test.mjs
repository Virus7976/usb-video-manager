// Two features that were fully wired, shipped, and could never once fire. Both are on the Organize
// path — the one most of his library actually goes through.
//
//   1. ⚠⚠ `clips:tagPerson` could not match a single finalMeta record. finalMeta is keyed by
//      lower-cased FILE NAME (`store[name.toLowerCase()]`), but every key the face code sends is a
//      clipKeyV2 (`name__size__mtime`). `clipKeyMatches` bridges V1↔V2 clip keys — it cannot bridge
//      to a bare filename: no `__` means `clipKeyStem` returns '' and the comparison is false every
//      time. So the finalMeta half was dead code, and the finalMeta half is exactly what the
//      feature's own comment says it exists for: "a cluster restored from faces-pending.json
//      legitimately references clips from EARLIER sessions — already renamed, already filed."
//      Net effect: confirming a face tagged nothing durable for any clip he had already filed.
//
//   2. ⚠⚠ The shoot question could never fire on Organize. `askAboutShoots` read `c.date`, but
//      `finalize:scan` returns the date at `f.meta.date` and only card-flow clips carry a top-level
//      one. `dates` was always empty → `ai:shootsToAsk([])` → `{shoots:[]}` → early return before
//      anything rendered. That is why his shootMemory reads 0 entries with the feature fully built,
//      and why `get_shoot_context` never receives `he_told_you_this_shoot_is`.
//
// Measured stakes for #1: 200 of his 4594 drafts hold a face confirmation, and 0 projects are filed —
// the pipeline stalls at review, so the "already filed" case is the one that has to work.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const FILED = '2026-06-01_vlog_josiah-talking-head_v1.mp4';
const CLIP_KEY = `${FILED}__104857600__1769900000000`;   // what the face code sends

beforeEach(() => {
  const c = app.get('config');
  c.finalMeta = { [FILED.toLowerCase()]: { subject: 'vlog', description: 'talking head', done: true } };
  c.renameDrafts = {};
});

test('⚠⚠ confirming a face tags a clip that is ALREADY FILED', async () => {
  const r = app.plain(await app.invoke('clips:tagPerson', { name: 'Josiah', keys: [CLIP_KEY] }));
  assert.equal(r.ok, true, 'the handler ran');
  assert.equal(r.tagged, 1, `⚠ the filed clip was tagged — got ${r.tagged}. 0 means finalMeta is unreachable again.`);
  const rec = app.plain(app.get('config.finalMeta'))[FILED.toLowerCase()];
  assert.deepEqual(rec.people, ['Josiah'], 'and the name is persisted on the record');
});

test('the tag survives as metadata, not just a count', async () => {
  // `tagged` is a return value nothing in the UI surfaces, so a handler could report success while
  // writing nowhere. Assert on the store.
  await app.invoke('clips:tagPerson', { name: 'Josiah', keys: [CLIP_KEY] });
  const rec = app.plain(app.get('config.finalMeta'))[FILED.toLowerCase()];
  assert.equal(rec.subject, 'vlog', 'the existing record is edited, not replaced');
  assert.equal(rec.done, true, 'and its other fields survive');
});

test('⚠ re-confirming the same face does not duplicate the name', async () => {
  await app.invoke('clips:tagPerson', { name: 'Josiah', keys: [CLIP_KEY] });
  const again = app.plain(await app.invoke('clips:tagPerson', { name: 'Josiah', keys: [CLIP_KEY] }));
  assert.equal(again.tagged, 0, 'the second confirm is a visible no-op');
  const rec = app.plain(app.get('config.finalMeta'))[FILED.toLowerCase()];
  assert.deepEqual(rec.people, ['Josiah'], 'still one entry');
});

test('⚠⚠ Undo reaches the filed clip too', async () => {
  // The asymmetry that would otherwise strand a tag on his footage with no way to remove it: tag
  // reaches finalMeta, untag does not.
  await app.invoke('clips:tagPerson', { name: 'Josiah', keys: [CLIP_KEY] });
  const u = app.plain(await app.invoke('clips:untagPerson', { name: 'Josiah', keys: [CLIP_KEY] }));
  assert.equal(u.untagged, 1, `⚠ undo must reach whatever tag reached — got ${u.untagged}`);
  const rec = app.plain(app.get('config.finalMeta'))[FILED.toLowerCase()];
  assert.deepEqual(rec.people, [], 'the name is gone');
});

test('⚠ a DIFFERENT clip is never tagged by mistake', async () => {
  // The bound on the fix. finalMeta is keyed by name alone, so name is the finest granularity the
  // store has — but a different name must still never match.
  const c = app.get('config');
  c.finalMeta = {
    [FILED.toLowerCase()]: { subject: 'vlog' },
    '2026-06-01_lawn-mowing_dennis-front-yard_v1.mp4': { subject: 'lawn-mowing' },
  };
  const r = app.plain(await app.invoke('clips:tagPerson', { name: 'Josiah', keys: [CLIP_KEY] }));
  assert.equal(r.tagged, 1, 'exactly one record matched');
  const store = app.plain(app.get('config.finalMeta'));
  assert.equal(store['2026-06-01_lawn-mowing_dennis-front-yard_v1.mp4'].people, undefined,
    '⚠ the unrelated clip was not touched');
});

test('an empty key matches nothing', async () => {
  const c = app.get('config');
  c.finalMeta = { '': { subject: 'x' }, [FILED.toLowerCase()]: { subject: 'vlog' } };
  const r = app.plain(await app.invoke('clips:tagPerson', { name: 'Josiah', keys: [CLIP_KEY] }));
  assert.equal(r.tagged, 1, 'the empty-keyed record is not swept up');
});

test('the clip-keyed store still matches across key forms', async () => {
  // The fix must not cost the #8 behaviour on drafts: a record written before the migration carries
  // `name__size` while the caller now asks with `name__size__mtime`.
  const c = app.get('config');
  c.finalMeta = {};
  c.renameDrafts = { [`${FILED}__104857600`]: { subject: 'vlog' } };   // legacy key
  const r = app.plain(await app.invoke('clips:tagPerson', { name: 'Josiah', keys: [CLIP_KEY] }));
  assert.equal(r.tagged, 1, 'the legacy-keyed draft still matches a V2 request');
});

// --- the shoot question, pinned against source (it is a modal driven by a long async flow) ---
const tasks = readFileSync(join(process.cwd(), 'src', 'mod', '04-tasks-ai.js'), 'utf8').replace(/\/\/.*$/gm, '');

test('⚠⚠ the shoot question reads the date from BOTH clip shapes', () => {
  assert.match(tasks, /const clipShootDate = \(c\) => \(c && \(c\.date \|\| \(c\.meta && c\.meta\.date\)\)\) \|\| '';/,
    'card clips use c.date, Organize clips use c.meta.date');
  assert.match(tasks, /const dates = list\.map\(clipShootDate\)\.filter\(Boolean\);/,
    '⚠ reading c.date alone is why this never fired on Organize');
  assert.match(tasks, /list\.filter\(\(c\) => clipShootDate\(c\) === date\)/,
    'and the grouping uses the same accessor — otherwise it returns before rendering anyway');
});

test('⚠⚠ the answer is written to the field that screen actually PERSISTS', () => {
  // On Organize the authoritative field is f.meta.subject via saveFinalMeta; f.subject is only the
  // caption mirror. Writing the mirror alone changed nothing visible and nothing durable.
  assert.match(tasks, /const isOrganizeClip = \(c\) => !!\(c && c\.sourcePath && 'meta' in c\);/,
    "discriminates on key PRESENCE — finalize:scan sets meta:null on a total miss, so !!c.meta is wrong");
  assert.match(tasks, /c\.meta\.subject = v;/, 'the persisted field is written');
  assert.match(tasks, /window\.api\.saveFinalMeta\(\{ \[c\.name\]: \{ \.\.\.c\.meta \} \}\)/, 'and saved');
});

test('⚠ it is still a DEFAULT and never an overwrite, on both paths', () => {
  // The property that makes answering safe. A name he typed must outrank anything inferred.
  assert.match(tasks, /const cur = organize \? \(\(c\.meta && c\.meta\.subject\) \|\| ''\) : \(c\.subject \|\| ''\);/,
    'the existing value is read from the right field per path');
  assert.match(tasks, /if \(cur\.trim\(\)\) continue;/, 'a filled subject is skipped');
});

test('the repaint matches the screen that was actually touched', () => {
  // refreshNames/scheduleDraftSave both walk state.scannedFiles — the CARD array — so on the
  // Organize path they either no-op or re-save the previous card batch's drafts.
  assert.match(tasks, /if \(touchedCard\) \{/, 'card repaint is gated');
  assert.match(tasks, /if \(touchedOrganize && typeof finRenderList === 'function'\)/, 'Organize repaint is gated');
});
