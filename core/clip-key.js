// THE IDENTITY OF A CLIP — the first module in `core/`, and the pattern for everything that follows.
//
// ---------------------------------------------------------------------------------------------
// WHY core/ EXISTS, AND THE RULES FOR IT
// ---------------------------------------------------------------------------------------------
// `main-mod/*.js` is not a set of modules: scripts/bundle.mjs CONCATENATES the ten files into
// main.js, so they share one lexical scope and nothing can be `require`d out of them. That is fine
// for the desktop app and useless for anything else — a future HTTP backend (see ARCHITECTURE.md)
// cannot import a single line of it.
//
// The obvious fix — un-concatenate 11,000 lines — was estimated as the largest single cost in the
// whole plan. It turns out not to be necessary. The bundler only reads `main-mod/*.js`, so a
// SEPARATE `core/` of ordinary CommonJS modules can be required BY the bundled main.js and, later,
// by a Node server, with no restructuring of main-mod at all. Logic moves here one piece at a time.
//
// Three rules, each learned rather than assumed:
//
//  1. ⚠ REQUIRE IT AS `./core/...`, NOT `../core/...`. The require line is written inside a
//     main-mod file but EXECUTES from the concatenated main.js at the repo root, so the path
//     resolves relative to the root. `../core/` fails identically in tests and in production —
//     loudly, which is the one mercy.
//
//  2. ⚠⚠ `core/**/*` MUST BE IN package.json → build.files. That list is an ALLOWLIST, and a new
//     top-level directory matches nothing in it. Every test, `npm start`, and the e2e suite all run
//     from the working tree where core/ exists on disk, so they ALL pass — and the packaged app
//     fails to boot with "Cannot find module ./core/clip-key" only after an install, on his machine.
//     No test in the suite can catch that. (Proof it is real: watch-drives.js sits at the repo root,
//     is syntax-checked by `npm run check`, and is already absent from the shipped app.)
//
//  3. ⚠ core/ MODULES MUST BE STATELESS. The test harness re-evaluates main.js in a fresh vm context
//     for every loadMain(), but Node's require cache is per-PROCESS — so a core/ module is evaluated
//     ONCE per test file and shared by every loadMain() in it. Module-level mutable state would leak
//     between tests, which is a genuinely new failure mode this codebase has never had. Pure
//     functions, or factories that take their dependencies as arguments. That constraint is also
//     exactly what makes these usable from a server, so it costs nothing.
//
// Also note: scripts/check-primitives.mjs scans `main-mod/` only. Code moved here escapes the bare
// `spawn`/`copyFile`/`mkdir` guard, so its directory list must be extended BEFORE any I/O logic
// moves. Pure functions like these are unaffected.
//
// ---------------------------------------------------------------------------------------------
// WHAT THIS MODULE IS
// ---------------------------------------------------------------------------------------------
// A clip is identified two ways, and telling them apart is the difference between finding his
// footage and silently losing track of it:
//
//   legacy (V1) `name__size`              — NOT unique. Two GoPro GX010042.MP4 of identical size
//                                           from different cards collide, and their drafts, people
//                                           and observations bleed into each other (audit #8).
//   current (V2) `name__size__mtime`      — collision-free. Every NEW write uses this.
//
// Nothing on disk is ever rewritten: reads try V2, then fall back to legacy. These matchers are what
// make that migration safe, which is why they are the first thing an HTTP server would need too.
'use strict';

// The `name__size` prefix of a key. '' when there is no `__` at all — i.e. not a clip key.
function clipKeyStem(k) {
  const s = String(k || '');
  const i = s.indexOf('__');
  if (i < 0) return '';
  const j = s.indexOf('__', i + 2);
  return j < 0 ? s : s.slice(0, j);
}

// True when the key carries an mtime, i.e. it is fully qualified (V2).
function clipKeyHasMtime(k) { return clipKeyStem(k) !== '' && String(k || '') !== clipKeyStem(k); }

// Do two CLIP keys refer to the same clip, across key forms?
function clipKeyMatches(a, b) {
  const x = String(a || ''); const y = String(b || '');
  if (!x || !y) return false;
  if (x === y) return true;
  // Both fully qualified and not equal → genuinely different clips. Never fall through to the stem.
  if (clipKeyHasMtime(x) && clipKeyHasMtime(y)) return false;
  const sx = clipKeyStem(x); const sy = clipKeyStem(y);
  return !!sx && sx === sy;
}

// The FILE NAME portion of a key, lower-cased. A bare filename passes through unchanged.
function clipKeyFileName(k) {
  const s = String(k || '');
  const i = s.indexOf('__');
  return (i < 0 ? s : s.slice(0, i)).toLowerCase();
}

// finalMeta is keyed by lower-cased FILE NAME, not by a clip key, so clipKeyMatches can never bridge
// to it: a bare filename has no `__`, clipKeyStem returns '', and every comparison is false. That is
// why confirming a face tagged nothing on already-filed clips until 2026-07-20.
//
// ⚠ Deliberately NOT folded into clipKeyMatches: that function also drives two DELETE paths (drafts
// and copiedLog), and loosening it to accept bare names would widen those deletes — trading a
// tagging bug for data loss. Name-only is as precise as finalMeta's own data allows.
function finalMetaKeyMatches(clipKeyOrName, storeKey) {
  const a = clipKeyFileName(clipKeyOrName);
  return !!a && a === clipKeyFileName(storeKey);
}

module.exports = { clipKeyStem, clipKeyHasMtime, clipKeyMatches, clipKeyFileName, finalMetaKeyMatches };
