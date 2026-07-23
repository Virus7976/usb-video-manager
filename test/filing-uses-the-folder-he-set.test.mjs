// ⚠⚠ HE SETS HIS PROJECTS FOLDER, AND FILING SAYS "No destination folder set".
//
// `organizeDest` and `projectsRoot` are two settings for one concept — "where filed footage goes" —
// and setting one does not set the other. Every route that asks him to configure a destination
// writes `projectsRoot`: the AI health card's "Use that folder", the setup wizard, `projects:setRoot`.
// `finalize:run` read only `organizeDest`. Measured:
//
//     projects:setRoot    -> config.projectsRoot = "…/02 - Projects/2026"
//     config.organizeDest = ""
//     finalize:run        -> {"ok":false,"error":"No destination folder set. Choose one in
//                             Edit → “Organizing & folders…”."}
//
// So he does the thing the app asked, presses the button that finishes the job, and is told to go
// somewhere else and say it again. This matters more as of the same day the Home card that leads
// here was moved to the top of the pending-work list: it is the very next wall.
//
// `config:get` has always resolved the pair as `projectsRoot || organizeDest || default`. This is the
// same resolution on the path that actually files.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let base; let comp; let root;
before(() => { app = loadMain(); });
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  base = mkdtempSync(join(tmpdir(), 'dest-'));
  comp = join(base, '02 - Compressed'); mkdirSync(comp, { recursive: true });
  root = join(base, '02 - Projects', '2026'); mkdirSync(root, { recursive: true });
  writeFileSync(join(comp, '2026-06-01_lawn-mowing_a_v1.mp4'), 'x'.repeat(64));
  const cfg = app.get('config');
  cfg.compressedFolder = comp; cfg.finalizeSource = '';
  cfg.organizeDest = ''; cfg.projectsRoot = '';
});

const runAll = async () => {
  const scan = app.plain(await app.invoke('finalize:scan', {}));
  const items = (scan.files || []).map((f) => ({ sourcePath: f.sourcePath, name: f.name, meta: f.meta || null }));
  return app.plain(await app.invoke('finalize:run', { items, options: { organize: true, copy: true }, dir: scan.dir }));
};

test('⚠ CONTROL — with organizeDest set, filing works as it always did', async () => {
  app.get('config').organizeDest = root;
  const r = await runAll();
  assert.equal(r.ok, true, `⚠ the original path still files — got ${r.error}`);
  assert.equal(r.moved, 1);
});

test('⚠⚠⚠ setting only the PROJECTS folder is enough to file', async () => {
  // The realistic state after using any of the app's own "point me at your projects" routes.
  const set = app.plain(await app.invoke('projects:setRoot', root));
  assert.ok(set, 'setup: the root was set');
  assert.equal(app.get('config').organizeDest, '', 'setup: and organizeDest is still empty');

  const r = await runAll();
  assert.equal(r.ok, true, `⚠⚠⚠ filing must not refuse when he has already said where — got ${r.error}`);
  assert.equal(r.moved, 1, 'and the clip really moves');
});

test('⚠⚠ organizeDest still WINS when both are set — this is a fallback, not a takeover', async () => {
  // If he has deliberately pointed filing somewhere other than his projects root, that choice stands.
  const other = join(base, 'Somewhere Else'); mkdirSync(other, { recursive: true });
  const cfg = app.get('config');
  cfg.projectsRoot = root;
  cfg.organizeDest = other;
  const r = await runAll();
  assert.equal(r.ok, true);
  assert.ok(readdirSync(other).length > 0, '⚠⚠ his explicit destination is used');
  assert.equal(readdirSync(root).length, 0, '⚠⚠ and the projects root is left alone');
});

test('⚠ an explicit payload destination beats both', async () => {
  const chosen = join(base, 'Chosen'); mkdirSync(chosen, { recursive: true });
  const cfg = app.get('config');
  cfg.projectsRoot = root; cfg.organizeDest = join(base, 'Somewhere Else');
  const scan = app.plain(await app.invoke('finalize:scan', {}));
  const items = (scan.files || []).map((f) => ({ sourcePath: f.sourcePath, name: f.name, meta: f.meta || null }));
  const r = app.plain(await app.invoke('finalize:run', {
    items, options: { organize: true, copy: true }, dir: scan.dir, organizeDest: chosen,
  }));
  assert.equal(r.ok, true);
  assert.ok(readdirSync(chosen).length > 0, '⚠ the per-run choice wins');
});

test('⚠⚠ with NOTHING set anywhere it still refuses, and says where to go', async () => {
  // The fallback must not turn a genuine "you have not told me anything" into a confusing success.
  const r = await runAll();
  assert.equal(r.ok, false, '⚠⚠ still an honest refusal');
  assert.match(r.error, /No destination folder set/i, 'with the same message');
});
