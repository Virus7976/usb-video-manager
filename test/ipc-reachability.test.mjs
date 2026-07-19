// Reachability as an INVARIANT — every IPC handler must be reachable from the renderer.
//
// Written after I shipped audit #64 reading a settings flag (`s.gpu`) that NOTHING ever set: the
// feature was complete, tested, and unreachable. That is the same shape as audit #40 (a warning whose
// condition could never be true) and the dead `autoMatched` flag. Dead code that LOOKS wired is the
// recurring failure here, so the check belongs in the suite rather than in someone's memory.
//
// Two directions, because they fail differently:
//   • an ipcMain handler with no preload binding is main-side code no user can ever run;
//   • a preload method the renderer never calls is dead BRIDGE surface — and in a `webSecurity:false`
//     renderer every exposed method is reachable by injected script, so this is attack surface too
//     (see audit #95).
//
// NOTE this would NOT have caught #64 itself (that was an unset settings FIELD, not an unbound
// channel). It catches the neighbouring class. Said plainly so nobody trusts it for more than it does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readAll = (dir, ext = '.js') => fs.readdirSync(path.join(ROOT, dir))
  .filter((f) => f.endsWith(ext))
  .map((f) => fs.readFileSync(path.join(ROOT, dir, f), 'utf8'))
  .join('\n');

const mainSrc = readAll('main-mod');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const rendererSrc = readAll('src/mod') + fs.readFileSync(path.join(ROOT, 'src/preview.html'), 'utf8');
const testSrc = ['test', 'test/e2e']
  .flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.mjs')).map((f) => path.join(ROOT, d, f)))
  .map((f) => fs.readFileSync(f, 'utf8')).join('\n');

const mainChannels = new Set([...mainSrc.matchAll(/ipcMain\.(?:handle|on)\('([^']+)'/g)].map((m) => m[1]));
const preloadChannels = new Set([...preloadSrc.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)].map((m) => m[1]));
const preloadMethods = [...preloadSrc.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*\(/gm)].map((m) => m[1]);

// Dead bridge methods as of 2026-07-18. Pinned so NEW ones fail rather than quietly joining the pile.
// Deliberately not deleted in that pass: several belong to phone/AI features that cannot be exercised
// from WSL, and removing an API because a grep didn't find a caller is exactly the kind of "tidy" this
// codebase's own lessons warn about. Trimming them is a good deliberate follow-up — each one removed
// is one less thing an injected script can call in a webSecurity:false renderer.
const KNOWN_UNUSED = [
  'adbDisable', 'aiBackfillLedger', 'aiLoaded', 'aiRecallShoot', 'aiVisionAdvice', 'applyRename',
  'clearPhoneBackupFolder', 'facesImage', 'feedbackList', 'getIntake', 'removeFieldHistory',
];
// `aiBackfillLedger` is on that list even though a test mentions backfilling: the test calls the
// INTERNAL function (`backfillLedgerFromTree`) directly, never the bridge method. A looser scan
// counted it as used — this stricter one caught the false positive, which is the check earning its
// keep on its first run. `getFinalMeta` by contrast IS a genuine test seam: the e2e calls
// `window.api.getFinalMeta()` through the real bridge, so it stays off the list.

test('every ipcMain handler is reachable — no main-side code a user can never run', () => {
  const orphans = [...mainChannels].filter((c) => !preloadChannels.has(c)).sort();
  assert.deepEqual(orphans, [],
    'these channels have no preload binding, so nothing in the app can invoke them');
});

test('no NEW dead bridge methods', () => {
  const used = (m) => rendererSrc.includes(`api.${m}`) || rendererSrc.includes(`.${m}(`)
    || testSrc.includes(`api.${m}`) || testSrc.includes(`'${m}'`);
  const unused = preloadMethods.filter((m) => !used(m)).sort();
  const added = unused.filter((m) => !KNOWN_UNUSED.includes(m));
  assert.deepEqual(added, [],
    'a preload method nothing calls is dead bridge surface — wire it up, or do not expose it');
});

test('the reachability scan is actually finding things (cannot pass vacuously)', () => {
  // If a refactor changes how handlers or the bridge are declared, both checks above would pass on
  // empty sets forever. Prove the parser still sees a realistic app.
  assert.ok(mainChannels.size > 100, `found the IPC handlers (${mainChannels.size})`);
  assert.ok(preloadMethods.length > 100, `found the bridge methods (${preloadMethods.length})`);
  assert.ok(rendererSrc.length > 100000, 'and the renderer source');
});
