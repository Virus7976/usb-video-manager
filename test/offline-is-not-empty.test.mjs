// ⚠⚠ AN UNPLUGGED DRIVE LOOKED EXACTLY LIKE AN EMPTY ONE.
//
// His archive lives on `L:`, which is not always connected. `listVideosShallow` catches its own
// errors and returns `[]`, so every layer above it saw "no files" and reported success. Measured,
// with a control run first so the harness is known to work:
//
//     folder present :  pending:work ready=5   ·  finalize:scan ok=true  total=5
//     folder gone    :  pending:work ready=0   ·  finalize:scan ok=true  total=0  error=none
//
// So the app would have told him he had nothing to organize while it simply could not see 310 clips.
// Worse on Home: `ready: 0` meant the card DISAPPEARED — no footage waiting, no explanation, nothing
// to click. A wrong number is bad; a silently missing card is worse, because there is nothing to
// question.
//
// This is his own rule, quoted in FEATURES.md from the Android app this one is measured against:
// *"offline" and "empty" are different states. A fetch that failed must never render as "you have
// nothing" — so a crew member with no signal isn't told their data doesn't exist.*
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let base; let comp;
before(() => { app = loadMain(); });
after(() => {
  try { app.dispose(); } catch { /* ignore */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  base = mkdtempSync(join(tmpdir(), 'offline-'));
  comp = join(base, '02 - Compressed');
  mkdirSync(comp, { recursive: true });
  for (let i = 0; i < 5; i += 1) writeFileSync(join(comp, `2026-06-0${i + 1}_lawn-mowing_p${i}_v1.mp4`), 'x'.repeat(64));
  const cfg = app.get('config');
  cfg.compressedFolder = comp; cfg.finalizeSource = ''; cfg.organizeDest = '';
  cfg.projectsRoot = join(base, '02 - Projects', '2026');
});

const unplug = () => rmSync(comp, { recursive: true, force: true });
const scan = async () => app.plain(await app.invoke('finalize:scan', {}));
const pending = async () => app.plain(await app.invoke('pending:work'));

test('⚠ CONTROL — with the drive connected, both report the footage', async () => {
  // Without this, "reports unreachable" could pass because the harness never saw the files at all.
  const s = await scan();
  assert.equal(s.ok, true);
  assert.equal(s.total, 5, '⚠ the scan finds the clips');
  const p = await pending();
  assert.equal(p.ready, 5, '⚠ and so does the Home counter');
  assert.equal(p.readyUnreachable, false, 'and it is not claiming to be offline');
});

test('⚠⚠⚠ an unreachable folder is NOT reported as empty', async () => {
  unplug();
  const s = await scan();
  assert.equal(s.ok, false, '⚠⚠⚠ it must not report success with zero files');
  assert.equal(s.unreachable, true, 'it says WHY');
  assert.match(s.error, /still there/i, '⚠⚠ and reassures him the footage is not lost');
  assert.match(s.error, /unplugged|offline/i, 'naming the likely cause');
});

test('⚠⚠⚠ Home knows the difference too, so the card does not silently vanish', async () => {
  unplug();
  const p = await pending();
  assert.equal(p.readyUnreachable, true, '⚠⚠⚠ the Home data distinguishes offline from empty');
  assert.ok(p.readyDir, 'and still names the folder, so the card can say which one');
});

test('⚠⚠ a genuinely EMPTY folder is still just empty', async () => {
  // The over-correction that would be worse than the bug: crying "unreachable" at a folder he has
  // simply already cleared would make the warning meaningless.
  rmSync(comp, { recursive: true, force: true });
  mkdirSync(comp, { recursive: true });
  const s = await scan();
  assert.equal(s.ok, true, '⚠⚠ an empty folder is not an error');
  assert.equal(s.total, 0);
  assert.ok(!s.unreachable, '⚠⚠ and is never called unreachable');
  const p = await pending();
  assert.equal(p.readyUnreachable, false, 'nor on Home');
});

test('⚠⚠ Home renders a card for it, leading with the reassurance', async () => {
  const core = readFileSync(new URL('../src/mod/01-core.js', import.meta.url), 'utf8');
  assert.match(core, /w\.readyUnreachable/, 'the card is driven by the real flag');
  assert.match(core, /id="pwOffline"/, 'and exists');
  assert.match(core, /Nothing is lost/, '⚠⚠ leading with what he actually wants to know');
  const at = core.indexOf('id="pwOffline"');
  const goAt = core.indexOf('id="pwGo"');
  assert.ok(at < goAt, '⚠ and it appears where the filing card would have been');
  assert.match(core, /querySelector\('#pwOffline'\)/, '⚠⚠ the card is clickable');
  assert.match(core, /showFoldersAndSetup\(\)/, 'and leads somewhere he can fix it');
});
