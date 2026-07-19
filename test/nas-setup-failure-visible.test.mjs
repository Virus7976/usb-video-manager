// A NAS that went offline silently disabled the second copy, and the import reported full success.
//
// `copy:start` resolves the NAS ONCE, at the top:
//     if (config.nasBackup && config.nasBackup.enabled && config.nasBackup.path) {
//       nasRoot = config.nasBackup.path;
//       try { await ensureDir(nasRoot); }
//       catch (err) { nasSummary.setupError = err.message; nasRoot = ''; }
//     }
// With `nasRoot = ''` the per-file mirror is skipped for the WHOLE card, and `nasNote` is built as
// `nasRoot ? … : ''` — so the completion notification reads a plain "Copied N clips to intake."
//
// And `setupError` is read NOWHERE. The renderer's only NAS check is:
//     if (res.nas && res.nas.failed) logIssue('NAS backup', …);
// which is 0, because nothing was ever attempted.
//
// WHY THIS IS A FOOTAGE-SAFETY BUG AND NOT A COSMETIC ONE: the user turned on "Keep a second copy on
// a NAS or external drive". The share drops — undocked, VPN down, drive unplugged, folder renamed —
// and the next import makes ZERO NAS copies while reporting success. The user then runs Delete, which
// verifies card↔intake ONLY (`verifyCopyPair` knows nothing about the NAS), and clears the card. They
// are left with one copy where the app implied two. The delete gate did its job correctly; it was
// asked the wrong question.
//
// The sibling gets this right: `finalize:run` has no upfront `ensureDir`, so each file's NAS failure
// lands in `summary.errors` and the Organize screen renders it.
//
// FAIL OPEN, BUT LOUD. The copy to intake is still worth doing, so a missing NAS must not refuse the
// import — it must not be able to pass for success either.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

function stage() {
  const base = mkdtempSync(join(tmpdir(), 'uvd-nas-'));
  const card = join(base, 'DCIM'); const intake = join(base, 'Intake');
  mkdirSync(card, { recursive: true }); mkdirSync(intake, { recursive: true });
  const clip = join(card, 'GX010042.MP4');
  writeFileSync(clip, 'FOOTAGE');
  const cfg = app.get('config');
  cfg.nasBackup = { enabled: true, path: join(base, 'NAS') };
  // Capture what the user is actually told.
  app.get('__notices = [];');
  app.get('notify = function (title, body) { __notices.push(`${title}: ${body}`); };');
  return { base, clip, intake, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// The NAS folder cannot be created — exactly what an offline share looks like.
function withDeadNas(fn) {
  const real = app.get('ensureDir');
  app.get(`ensureDir = function (d) {
    if (String(d).includes('NAS')) return Promise.reject(new Error('ENOENT: network path not found'));
    return __realEnsureDir(d);
  }`);
  app.get(`__realEnsureDir = ${String(real)}`);
  return fn().finally(() => { app.get(`ensureDir = ${String(real)}`); });
}

const copy = (s) => app.invoke('copy:start', {
  files: [{ name: 'GX010042.MP4', sourcePath: s.clip, size: 8, ext: 'mp4' }],
  intakeFolder: s.intake,
});
const notices = () => (app.plain(app.get('__notices')) || []).join(' | ');

test('a NAS that cannot be reached is reported in the result', async () => {
  const s = stage();
  try {
    const r = await withDeadNas(() => copy(s));
    assert.ok(r.nas, 'the NAS summary is returned');
    assert.match(String(r.nas.setupError || ''), /network path not found/, 'carrying the real reason');
  } finally { s.cleanup(); }
});

test('the completion notice does NOT imply a second copy exists', async () => {
  // "Copied 1 clip to intake." with no mention of the NAS is what let a user delete a card believing
  // there were two copies.
  const s = stage();
  try {
    await withDeadNas(() => copy(s));
    assert.match(notices(), /NAS/i, 'the notice mentions the NAS at all');
    assert.match(notices(), /not backed up|couldn|failed|unavailable/i, 'and says it did NOT happen');
  } finally { s.cleanup(); }
});

test('the import still succeeds — a missing NAS never blocks the copy', async () => {
  // Fail open. Refusing the import would be a worse outcome than one copy.
  const s = stage();
  try {
    const r = await withDeadNas(() => copy(s));
    assert.notEqual(r.ok, false, 'the copy went ahead');
    assert.equal((r.copied || []).length, 1, 'and the clip really landed in intake');
  } finally { s.cleanup(); }
});

test('a healthy NAS reports normally and says nothing alarming', async () => {
  // Guard the other direction: this must not cry wolf on every successful import.
  const s = stage();
  try {
    const r = await copy(s);
    assert.equal(String(r.nas.setupError || ''), '', 'no setup error');
    assert.doesNotMatch(notices(), /not backed up|couldn|unavailable/i, 'and no false alarm');
  } finally { s.cleanup(); }
});

test('NAS backup switched OFF reports nothing about a NAS', async () => {
  const s = stage();
  try {
    app.get('config').nasBackup = { enabled: false, path: '' };
    const r = await copy(s);
    assert.equal(String(r.nas.setupError || ''), '', 'nothing to report');
    assert.doesNotMatch(notices(), /NAS/i, 'and the notice does not mention one');
  } finally { s.cleanup(); }
});

test('the renderer surfaces the setup failure, not just per-file failures', async () => {
  // res.nas.failed is 0 when nothing was attempted, so the existing check cannot see this.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(process.cwd(), 'src', 'mod', '09-phone-finalize.js'), 'utf8')
    .replace(/\/\/.*$/gm, '');
  // Bind to the GUARD, not any mention: the message template also interpolates `res.nas.setupError`,
  // so replacing the condition with `if (false)` left a looser assertion green.
  assert.match(src, /if \(res\.nas && res\.nas\.setupError\)/, 'the renderer checks the setup error');
  // Slice the BLOCK to its closing brace — the body is multi-line, so checking the line that holds
  // the first `setupError` only ever sees the `if (…)` itself.
  const i = src.indexOf('res.nas.setupError');
  const block = src.slice(i, src.indexOf('\n  }', i));
  assert.match(block, /showToast\(/, 'the user is told');
  assert.match(block, /logIssue\(/, 'and it is recorded where they can find it later');
});
