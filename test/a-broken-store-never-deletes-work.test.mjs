// Three caps/prunes that destroyed work when a store they depend on was unreadable. The shape is the
// same each time: **an empty store is indistinguishable from a store that failed to load**, and the
// code treats "I can't see any reference to this" as "nothing references this, delete it".
//
//   1. ⚠⚠ `_serializePending` drops a resolved (done/skipped) face cluster unless some group shot
//      still references it. If `faceScenes` is empty because the read THREW, or because main handed
//      back the empty default for a corrupt face-scenes.json, every resolved cluster looks
//      unreferenced and the next pending save strips the lot. The scenes file is protected by its own
//      write guard, so on the next good launch the group shots return with nothing left to resolve
//      them — the #45 vanishing, re-created from the other side.
//   2. ⚠ `gcFaceCrops` aborts if any of the three SIDECAR stores failed to read, on the stated
//      principle that an incomplete keep-set must abort the sweep. But the fourth reference store,
//      `config.ai.ignored`, lives in config.json — so an unreadable config meant `ignored` read `[]`
//      and the GC unlinked every ignored face's crop. Each entry carries the `from`/`fromName`
//      needed to restore a CONFIRMED enrolment face, so that is a one-way loss of confirmed work.
//   3. The `clipObs` cap sorted on `ts || 0`, pushing every record written before `ts` existed to the
//      front of the deletion list — evicted first for being undated, not for being old. It was also
//      the only cap in the codebase with no unconsumed-work exemption (`finalMeta` gates on `done`,
//      drafts exempt named entries), so an observation for a clip he had not named yet — the AI's
//      only memory of that clip — was shed like any other.
//
// The governing rule, which these all now follow: **keeping too much is recoverable; deleting his
// work is not.** When the evidence is untrustworthy, keep.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

const people = readFileSync(join(process.cwd(), 'src', 'mod', '08-people.js'), 'utf8').replace(/\/\/.*$/gm, '');
const feedback = readFileSync(join(process.cwd(), 'main-mod', '08-finalize-feedback.js'), 'utf8').replace(/\/\/.*$/gm, '');

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

test('⚠⚠ a resolved face cluster is only pruned when the scene list can be TRUSTED', () => {
  const at = people.indexOf('function _serializePending');
  assert.ok(at > -1, 'found _serializePending');
  const body = people.slice(at, people.indexOf('\n}', at));
  assert.match(body, /const scenesTrustworthy = _scenesLoaded && !_scenesLoadFailed;/,
    'trust is computed from BOTH flags — a never-loaded list is as untrustworthy as a failed one');
  assert.match(body, /!\(c\.done \|\| c\.skipped\) \|\| !scenesTrustworthy \|\| _clusterInAnyScene\(c\)/,
    '⚠ an untrusted scene list must KEEP resolved clusters, not prune them');
});

test('⚠⚠ a corrupt scenes file is distinguishable from having no scenes', () => {
  // The subtle half. A corrupt face-scenes.json does NOT throw — main returns the empty default and
  // the IPC succeeds, so _scenesLoadFailed stays false and `faceScenes` reads [] exactly as it would
  // for a user with no group shots. Without asking main which stores actually failed, the prune
  // cannot tell those apart and deletes his answers in the corrupt case.
  const at = people.indexOf('async function ensureFaceScenes');
  const body = people.slice(at, people.indexOf('\n}', at));
  assert.match(body, /storeReadFailures\(\)/, 'it asks main for read health');
  assert.match(body, /includes\('ai\.faceScenes'\)\) _scenesLoadFailed = true/,
    'and marks the list untrustworthy when that store failed to read');
});

test('the read-health bridge exists end to end', async () => {
  // A renderer guard that calls a handler nobody registered is a guard that silently never fires.
  const res = app.plain(await app.invoke('stores:readFailures'));
  assert.ok(Array.isArray(res), `the handler is registered and returns a list — got ${JSON.stringify(res)}`);
  const preload = readFileSync(join(process.cwd(), 'preload.js'), 'utf8');
  assert.match(preload, /storeReadFailures: \(\) => ipcRenderer\.invoke\('stores:readFailures'\)/,
    'and it is bridged to the renderer');
});

test('⚠ a healthy store reports no read failures', async () => {
  // The negative case: if this returned a non-empty list on a clean launch, the guard above would
  // permanently disable pruning and the pending store would grow without bound.
  const res = app.plain(await app.invoke('stores:readFailures'));
  assert.deepEqual(res, [], `a clean launch has no failed stores — got ${JSON.stringify(res)}`);
});

test('⚠⚠ the face-crop GC guards ALL FOUR reference stores, not just the sidecars', () => {
  const at = feedback.indexOf('function gcFaceCrops');
  assert.ok(at > -1, 'found gcFaceCrops');
  const body = feedback.slice(at, feedback.indexOf('\n    let removed = 0', at));
  assert.match(body, /for \(const k of \['ai\.people', 'ai\.facesPending', 'ai\.faceScenes'\]\)/,
    'the three sidecars are still guarded');
  assert.match(body, /if \(config_readFailed\)/,
    '⚠ and config.json too — config.ai.ignored is in the keep-set but is NOT a sidecar');
  // The guard is worthless if it runs after the sweep has already started.
  const guardAt = body.indexOf('config_readFailed');
  const keepAt = body.indexOf('const keep = new Set()');
  assert.ok(keepAt > -1 && guardAt < keepAt, 'and it aborts BEFORE the keep-set is built');
});

test('the ignored bin is genuinely part of the keep-set (or the guard guards nothing)', () => {
  // If `ignored` were not consulted here, the config guard above would be protecting nothing and
  // would pass vacuously forever.
  const at = feedback.indexOf('function gcFaceCrops');
  const body = feedback.slice(at, feedback.indexOf('\n    let removed = 0', at));
  assert.match(body, /config\.ai && config\.ai\.ignored/, 'ignored faces keep their crops');
});

test('⚠ an undated observation is not evicted first for being undated', () => {
  const src = readFileSync(join(process.cwd(), 'main-mod', '03-ai-ollama.js'), 'utf8').replace(/\/\/.*$/gm, '');
  const at = src.indexOf('if (keys.length > 4000)');
  assert.ok(at > -1, 'found the clipObs cap');
  const body = src.slice(at, src.indexOf('saveStore(\'ai.clipObs\')', at));
  assert.match(body, /Number\.isFinite\(ta\) && ta > 0 \? ta : Infinity/,
    '⚠ a missing ts sorts as RECENT (Infinity), not as epoch — || 0 evicted legacy records first');
  assert.doesNotMatch(body, /\(store\[a\]\.ts \|\| 0\) - \(store\[b\]\.ts \|\| 0\)/, 'the old sort is gone');
});

test('⚠ an observation for a clip he has NOT named yet outlives one already used', () => {
  // The unconsumed-work exemption every other cap in this app has. An observation whose clip has no
  // name is the AI's only memory of that clip.
  const src = readFileSync(join(process.cwd(), 'main-mod', '03-ai-ollama.js'), 'utf8').replace(/\/\/.*$/gm, '');
  const at = src.indexOf('if (keys.length > 4000)');
  const body = src.slice(at, src.indexOf('saveStore(\'ai.clipObs\')', at));
  assert.match(body, /if \(ca !== cb\) return ca \? -1 : 1;/, 'consumed observations shed before unconsumed');
  assert.match(body, /rec\.subject \|\| rec\.description/, 'and "consumed" means the clip carries a real name');
});
