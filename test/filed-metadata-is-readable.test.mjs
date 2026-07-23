// FEATURES.md item 84 — "read filed metadata back" — was marked **dead**, because `finalMeta:get`
// has no caller in the app.
//
// The handler is dead. The CAPABILITY never was, and the two are different claims. Probed all the
// routes that matter before changing the roadmap entry, because "we shipped something nobody can
// use" is a serious thing to say and it was not true here:
//
//     Organize row : meta = {subject, description, people, location, done, ts}, matchType 'saved'
//     Ctrl+K       : query 'dennis' → the filed clip, matched on name + description
//
// So the roadmap said he paid for something he cannot use, when in fact he can, two ways. That
// mattered: an inaccurate "dead" entry sends a future session to wire up a handler nothing needs.
//
// ⚠ AND A PROBE THAT LIED ON THE WAY. My first search probe passed `{ q: 'dennis' }` and got
// `query: "", total: 0` — which reads exactly like a broken search. The handler wants `query`. Same
// class as the `items`/`moves` mistake: a wrong payload key looks identical to a broken feature.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let base; let comp;
before(() => { app = loadMain(); });
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});

const NAME = '2026-06-01_lawn-mowing_dennis_v1.mp4';
const REC = {
  subject: 'lawn-mowing', description: 'dennis front yard', people: ['Dennis'],
  location: 'Ottawa', done: true, ts: 1,
};

beforeEach(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  base = mkdtempSync(join(tmpdir(), 'f84-'));
  comp = join(base, '02 - Compressed'); mkdirSync(comp, { recursive: true });
  writeFileSync(join(comp, NAME), 'x'.repeat(64));
  const cfg = app.get('config');
  cfg.compressedFolder = comp; cfg.finalizeSource = ''; cfg.projectsRoot = join(base, 'p');
  cfg.finalMeta = { [NAME]: { ...REC } };
});

test('⚠⚠ Organize shows the saved record on the row, without any extra call', async () => {
  const s = app.plain(await app.invoke('finalize:scan', {}));
  const f = (s.files || [])[0];
  assert.ok(f, 'the clip is listed');
  assert.equal(f.matched, true, 'and recognised as already described');
  assert.equal(f.matchType, 'saved', 'from the SAVED record, not a filename guess');
  assert.equal(f.meta.subject, 'lawn-mowing');
  assert.equal(f.meta.description, 'dennis front yard');
  assert.deepEqual(f.meta.people, ['Dennis'], '⚠⚠ including who is in it');
  assert.equal(f.meta.location, 'Ottawa');
});

test('⚠⚠ a filed clip is findable by what was written about it', async () => {
  // The payload key is `query`. `q` returns an empty result that reads like a broken search.
  const r = app.plain(await app.invoke('library:search', { query: 'dennis' }));
  assert.equal(r.ok, true);
  assert.equal(r.total, 1, `⚠⚠ the filed clip is found — got ${r.total}`);
  assert.equal(r.results[0].name, NAME);
  assert.ok(r.results[0].matched.includes('description'),
    '⚠ matched on the DESCRIPTION, i.e. the filed metadata was really read');
});

test('⚠ CONTROL — with no saved record, the row is not claimed as described', async () => {
  // Without this, "the record is shown" could pass on a row that always reports meta.
  app.get('config').finalMeta = {};
  const s = app.plain(await app.invoke('finalize:scan', {}));
  const f = (s.files || [])[0];
  assert.notEqual(f.matchType, 'saved', '⚠ nothing saved means nothing claimed as saved');
});

test('⚠ a record stored under a differently-cased key is still found', async () => {
  // `finalMeta:save` lower-cases its keys; the scan matches by name, stem and token score. A clip
  // whose record was written by a different path must not read as undescribed.
  app.get('config').finalMeta = { [NAME.toUpperCase()]: { ...REC } };
  const s = app.plain(await app.invoke('finalize:scan', {}));
  const f = (s.files || [])[0];
  assert.equal(f.matched, true, '⚠ case is not what decides whether his work is visible');
});
