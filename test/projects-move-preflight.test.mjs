// Two bugs on the SAME path — the destination map's "Apply — file clips" (`projects:move`).
//
// (1) THE PREFLIGHT COULD NEVER FIRE. `projects:move` sums caller-supplied `mv.size`:
//         const need = moves.reduce((sum, mv) => sum + (Number(mv && mv.size) || 0), 0);
//         if (need > 0) { … }
//     …but its ONLY caller (src/mod/07-organize-map.js) builds each move as
//     `{ from, toDir, rel, name, meta }` — no `size`, and the clips it is built from don't carry one
//     either. So `need` was always 0 and the whole check was unreachable. Same shape as the
//     `cardIsGone` guard that sat on the non-default loop: present, commented, and dead.
//     The twin doesn't trust the caller — `finalize:run` stats the files itself
//     (main-mod/09-ipc-boot.js:578). This does too now.
//
// (2) THE REFUSAL WAS INVISIBLE. Both refusals return `{ ok: false, error }` with no `results`, and
//     the renderer read neither `r.ok` nor `r.error` — it counted `(r.results || [])`, got 0 and 0,
//     and reported "Filed 0 into your Projects tree ✓" **with a tick**, then closed the map. Main
//     composes a precise actionable sentence ("Point 'Compressed' at a folder on your computer
//     first") and it was thrown away. Note this is not a NEW refusal — the guard already refused;
//     it just lied about it afterwards, which is the worst of both worlds.
//
// Harm: filing onto the tight C: drive can fill the system disk mid-batch, leaving a half-filed
// shoot and a truncated file in the project tree — the exact case the preflight was written for.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

// A real source file with real bytes, so the handler's own stat is what decides.
function stage(bytes) {
  const base = mkdtempSync(join(tmpdir(), 'uvd-move-'));
  const src = join(base, 'src'); const dest = join(base, 'Projects');
  mkdirSync(src, { recursive: true }); mkdirSync(dest, { recursive: true });
  const from = join(src, 'GX010042.MP4');
  writeFileSync(from, Buffer.alloc(bytes, 7));
  return { base, from, dest, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// Force the free-space answer; the real volume has whatever it has.
function withFreeBytes(free, fn) {
  const fsp = app.get('fsp');
  const real = fsp.statfs;
  fsp.statfs = async () => ({ bavail: free, bsize: 1 });
  return fn().finally(() => { fsp.statfs = real; });
}

test('the preflight fires even though the caller sends no size', async () => {
  const s = stage(4 * 1024 * 1024);
  try {
    const r = await withFreeBytes(1024, () => app.invoke('projects:move', {
      // Exactly the shape src/mod/07-organize-map.js builds — note there is NO `size` field.
      moves: [{ from: s.from, toDir: join(s.dest, '2026 - test'), rel: '2026 - test', name: 'GX010042.MP4' }],
      root: s.dest,
      copy: true,
    }));
    assert.equal(r.ok, false, 'refused rather than filling the disk');
    assert.match(String(r.error), /Not enough room/, 'and said why, in the actionable sentence main composes');
  } finally { s.cleanup(); }
});

test('a run that DOES fit is not blocked', async () => {
  // The preflight is advisory and must never refuse a real filing run. If this ever fails, the fix
  // has become a liability rather than a guard.
  const s = stage(1024);
  try {
    const r = await withFreeBytes(500e9, () => app.invoke('projects:move', {
      moves: [{ from: s.from, toDir: join(s.dest, '2026 - test'), rel: '2026 - test', name: 'GX010042.MP4' }],
      root: s.dest,
      copy: true,
    }));
    assert.notEqual(r.ok, false, 'a run with plenty of room proceeds');
  } finally { s.cleanup(); }
});

test('a MOVE within a volume is never blocked on free space', async () => {
  // Moving consumes no new bytes, so gating it would be nonsense — the twin gates on copyMode too.
  // copy:false also triggers the removable-volume check, which fails closed on an unreadable volume;
  // a temp dir on a fixed disk is not removable, so this exercises the free-space gate specifically.
  const s = stage(4 * 1024 * 1024);
  try {
    const r = await withFreeBytes(1024, () => app.invoke('projects:move', {
      moves: [{ from: s.from, toDir: join(s.dest, '2026 - test'), rel: '2026 - test', name: 'GX010042.MP4' }],
      root: s.dest,
      copy: false,
    }));
    assert.ok(!(r.ok === false && /Not enough room/.test(String(r.error))), 'a move is not refused for space');
  } finally { s.cleanup(); }
});

test('an unreadable volume does not block the run', async () => {
  // Fail OPEN here, deliberately: this is advisory. Refusing to file because statfs threw would turn
  // a diagnostic into an outage.
  const s = stage(1024);
  try {
    const fsp = app.get('fsp');
    const real = fsp.statfs;
    fsp.statfs = async () => { throw new Error('ENOTSUP'); };
    try {
      const r = await app.invoke('projects:move', {
        moves: [{ from: s.from, toDir: join(s.dest, '2026 - test'), rel: '2026 - test', name: 'GX010042.MP4' }],
        root: s.dest,
        copy: true,
      });
      assert.notEqual(r.ok, false, 'an unreadable volume is not a refusal');
    } finally { fsp.statfs = real; }
  } finally { s.cleanup(); }
});

test('the renderer surfaces a refusal instead of reporting a tick', async () => {
  // Asserted positively against the source (the renderer callback is unreachable from the vm
  // harness): the caller must check `r.ok` and show `r.error` BEFORE it counts results, and must not
  // close the map out from under a run that never happened.
  const src = readFileSync(join(process.cwd(), 'src', 'mod', '07-organize-map.js'), 'utf8');
  const i = src.indexOf('const okN = (r && r.results || [])');
  assert.ok(i > 0, 'found the results-counting block');
  // Slice to the START of the counting block — the check has to come before it, or the "Filed 0 ✓"
  // line has already been emitted.
  const before = src.slice(src.indexOf('projectsMove'), i);
  assert.match(before, /r\.ok === false|!r\.ok/, 'the caller checks r.ok before counting results');
  assert.match(before, /r\.error/, 'and surfaces the message main composed');
});
