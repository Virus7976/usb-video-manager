// ⚠⚠ FIXING IT SILENTLY IS STILL A LIE BY OMISSION.
//
// `resolveFolderPath` now repairs a filing rule whose destination re-prefixes the Projects root's own
// name, so his 117 routed clips no longer fork his tree (see
// `route-dest-does-not-fork-his-tree.test.mjs`). That fixes the FILING. It does not fix the RULE:
//
//   · his stored rule still says `2026/2026 - Client Work/Gourgess Lawns`,
//   · the Filing-rules screen still shows him that stale text, and
//   · the next thing he saves from that screen writes the stale value straight back.
//
// A repair that never tells him is how a configuration drifts permanently. So the health check
// reports it, and an explicit control rewrites the stored rules — his configuration, so he asks.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let base; let root;
before(() => { app = loadMain(); });
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});

// His real layout: the root IS the year folder, with the project directly under it. The root's own
// folder must literally be named `2026` — that is the entire premise of the bug.
beforeEach(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  base = mkdtempSync(join(tmpdir(), 'uvd-rules-'));
  root = join(base, '02 - Projects', '2026');
  mkdirSync(join(root, '2026 - Client Work', 'Gourgess Lawns'), { recursive: true });
  const cfg = app.get('config');
  cfg.projectsRoot = root;
  cfg.ai = cfg.ai || {};
  // Both of his real rules, verbatim in shape: a dest relative to a root that has since moved.
  cfg.ai.routes = [
    { id: 'r1', name: 'Lawn care (Gourgess Lawns)', kind: 'route', match: ['lawn'], byDay: false,
      dest: '2026/2026 - Client Work/Gourgess Lawns' },
  ];
});

// The validator has no IPC handler by design (see the last test), so drive the real function.
const validate = async () => app.plain(await app.call('validateRouteDests'));

test('⚠⚠ a rule whose folder moved is reported as stale, not silently tolerated', async () => {
  const r = await validate();
  assert.equal(r.ok, true);
  assert.equal(r.stale, 1, '⚠⚠ the stale rule must be counted');
  assert.equal(r.routes[0].status, 'stale');
  assert.equal(r.routes[0].suggest, '2026 - Client Work/Gourgess Lawns',
    '⚠ and it must suggest the dest RELATIVE to the root, which is the form the rule stores');
});

test('⚠ a rule pointing at a folder that really exists is left alone', async () => {
  app.get('config').ai.routes = [
    { id: 'r1', name: 'ok', kind: 'route', match: ['lawn'], dest: '2026 - Client Work/Gourgess Lawns' },
  ];
  const r = await validate();
  assert.equal(r.stale, 0, '⚠ a correct rule is not "fixed"');
  assert.equal(r.routes[0].status, 'ok');
});

test('⚠⚠ a folder that simply does not exist yet is NOT called stale', async () => {
  // "This folder doesn't exist yet" is a perfectly normal thing for a rule to say — filing creates
  // it. Calling that broken would nag him about every new project he plans ahead of shooting it.
  app.get('config').ai.routes = [
    { id: 'r1', name: 'future', kind: 'route', match: ['x'], dest: 'Brand New Client/Shoot One' },
  ];
  const r = await validate();
  assert.equal(r.stale, 0, '⚠⚠ missing is not stale');
  assert.equal(r.routes[0].status, 'missing');
  assert.equal(r.routes[0].suggest, '', '⚠ and nothing is suggested, because there is nothing to prefer');
});

test('⚠ descriptor rules have no destination and are skipped', async () => {
  app.get('config').ai.routes = [
    { id: 'd1', name: 'vlog', kind: 'descriptor', match: ['vlog'], joinProject: true },
  ];
  const r = await validate();
  assert.equal(r.routes.length, 0, '⚠ a descriptor has no dest to validate');
  assert.equal(r.stale, 0);
});

test('⚠⚠ the repair rewrites the stored rule, and reports the REAL count', async () => {
  // "Fixed 2 rules" when it fixed none is the exact failure this project has had before.
  const before0 = app.get('config').ai.routes[0].dest;
  assert.equal(before0, '2026/2026 - Client Work/Gourgess Lawns', 'setup');

  const r = app.plain(await app.invoke('routes:repairDests'));
  assert.equal(r.ok, true);
  assert.equal(r.repaired, 1, '⚠⚠ it must report what it actually changed');
  assert.equal(app.get('config').ai.routes[0].dest, '2026 - Client Work/Gourgess Lawns',
    '⚠⚠ the STORED rule now says what it means');
});

test('⚠⚠ repairing twice is a no-op that says so', async () => {
  await app.invoke('routes:repairDests');
  const again = app.plain(await app.invoke('routes:repairDests'));
  assert.equal(again.repaired, 0, '⚠⚠ a second run changed nothing and must not claim otherwise');
});

test('⚠⚠ the repair NEVER touches a rule that is merely missing its folder', async () => {
  // The dangerous over-reach: rewriting a rule for a shoot he has not filed yet, to some other
  // folder that happens to exist. Only rules the validator independently classified `stale` move.
  app.get('config').ai.routes = [
    { id: 'r1', name: 'stale', kind: 'route', match: ['lawn'], dest: '2026/2026 - Client Work/Gourgess Lawns' },
    { id: 'r2', name: 'future', kind: 'route', match: ['x'], dest: 'Not Yet/Shoot One' },
  ];
  const r = app.plain(await app.invoke('routes:repairDests'));
  assert.equal(r.repaired, 1);
  assert.equal(app.get('config').ai.routes[1].dest, 'Not Yet/Shoot One',
    '⚠⚠ a rule whose folder does not exist yet is left exactly as he typed it');
  // ⚠ WHAT ACTUALLY PROTECTS IT is the EMPTY `suggest` on a `missing` route (asserted directly in
  // the "does not exist yet" test above), not the `status === 'stale'` filter — removing that filter
  // alone changes nothing and fails no test. Verified by breaking both. Recorded so nobody reads the
  // filter as the guard and then "simplifies" the emptiness check away, which would be the real one.
});

test('⚠ repairing an explicit subset only touches those ids', async () => {
  app.get('config').ai.routes.push(
    { id: 'r2', name: 'other', kind: 'route', match: ['y'], dest: '2026/2026 - Client Work/Gourgess Lawns' },
  );
  const r = app.plain(await app.invoke('routes:repairDests', ['r2']));
  assert.equal(r.repaired, 1);
  assert.equal(app.get('config').ai.routes[0].dest, '2026/2026 - Client Work/Gourgess Lawns',
    '⚠ the rule he did not pick is untouched');
});

// --- and it has to be REACHABLE, or none of the above is worth anything --------------------------

const src = (p) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\/\/.*$/gm, '');

test('⚠⚠ the health check surfaces it, with a one-click fix', () => {
  const tools = src('main-mod/10-ai-tools.js');
  assert.match(tools, /id: 'stale-route-dest'/, 'the health check reports it');
  assert.match(tools, /fix: 'repairRouteDests'/, 'and offers the repair as a one-click fix');
  assert.match(tools, /await validateRouteDests\(\)/, 'driven by the real validator, not a guess');

  const core = src('src/mod/01-core.js');
  assert.match(core, /p\.fix === 'repairRouteDests'/, 'the renderer handles that fix');
  assert.match(core, /window\.api\.repairRouteDests\(\)/, '⚠⚠ and really invokes it');
});

test('⚠ the fix card reports what happened, including nothing', () => {
  const core = src('src/mod/01-core.js');
  const at = core.indexOf("p.fix === 'repairRouteDests'");
  const body = core.slice(at, at + 900);
  assert.match(body, /r\.repaired/, 'it reads the real count');
  assert.match(body, /Nothing needed fixing/, '⚠ and says so when it changed nothing');
});

test('⚠⚠ there is deliberately no routes:validate IPC handler', () => {
  // The validator is consumed by ai:health INSIDE main. An ipcMain handler for it would be main-side
  // code nothing can invoke — which this app's own reachability guard refuses, correctly. Pinned so
  // nobody "helpfully" adds it back without a renderer caller in the same change.
  const ai = src('main-mod/03-ai-ollama.js');
  assert.ok(!/ipcMain\.handle\('routes:validate'/.test(ai),
    '⚠⚠ no handler without a caller — add it WITH the Filing-rules screen that uses it');
  assert.match(ai, /async function validateRouteDests/, 'the function itself exists');
});
