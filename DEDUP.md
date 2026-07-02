# DEDUP.md — de-duplication tracker

> **Living document. Update it on every dedup change** (same discipline as
> [`AGENTS.md`](AGENTS.md) / [`CHANGELOG.md`](CHANGELOG.md)). It is the running log of the
> "one source of truth" cleanup of `main.js` / `src/renderer.js` that started with the
> module split (v0.4.14–0.4.15) and the dedup rounds (v0.4.16–0.4.18).

## How this cleanup works

`main.js` and `src/renderer.js` are **generated** — never edit them directly. Edit the
module sources and re-bundle:

- renderer ← `src/mod/01-core … 10-boot.js` (10 files)
- main ← `main-mod/01-core … 09-ipc-boot.js` (9 files)
- `node scripts/bundle.mjs` concatenates each folder (filename order) into the single
  script the app loads. **One script = one shared top-level scope**, so:
  - a top-level `function foo` is **hoisted** and callable from any module, even one
    bundled earlier (this is why a helper defined in `07-*` can be called from `06-*`);
  - **two modules must never declare the same top-level `const`/`let`/`function` name**
    — that's a duplicate-declaration SyntaxError in the bundled file. Grep the whole
    `src/mod/**` (or `main-mod/**`) before adding a new top-level name.

Verify order for every dedup change:
1. `node scripts/bundle.mjs`
2. `node --check main.js && node --check src/renderer.js`
3. build + install to Windows (per the build/deploy policy), CDP-verify the touched flow.

## Classes of duplicate

- **Mechanical** (safe to merge on sight): byte-identical or trivially-identical logic
  differing only in a literal. Rounds 1–3 were mostly these.
- **Behavioral-divergence** (⚠ merging = *choosing* a behavior): two copies that actually
  differ in what they do. **Do NOT blind-merge.** Pick the correct/safer behavior, prove
  both call-sites still behave, then collapse. This file records the choice + rationale so
  the decision isn't re-litigated.

---

## Round 4 — behavioral-divergence merges (v0.4.19, 2026-07-01) — DONE + VERIFIED

Target: the three divergent dupes flagged at the end of round 3. "Safely" = pick the
**safer** behavior each time and keep both call-sites behavior-compatible. All three
merged; `node scripts/bundle.mjs` + `node --check` pass; bundle has a single top-level
`val` (no duplicate-decl). **Built + installed 0.4.19; CDP-verified on the live app**
(port 9333 — the ghost socket squatting :9222 forced a fresh debug port): version reads
0.4.19; the Edit→AI **menu-bar submenu** renders through the shared builder (3 headers,
7 desc lines, 9 items) and a synthetic **context submenu** renders `danger` + `disabled`
+ a lazy `()=>` label — both paths through the one `buildSubmenuFlyout`.

### #14 — unsafe vs safe cross-device MOVE  ·  status: DONE
- **Safe copy:** `moveFileCrossDevice(src, dest)` in `main-mod/02-media.js` —
  rename-first, and on `EXDEV` copy→**fingerprint-verify**→atomic-rename→**then** unlink
  source. A crash at any step leaves the SOURCE intact and never leaves a half-written
  file at the real destination.
- **Unsafe copies:** `main-mod/05-windows-phone.js` `phone:copyVideos` (two sites, ~L548
  and ~L567) fall back to `copyFile(src,dest)` then `rm(src)` with **no verify** — a
  truncated cross-drive copy would delete the only good source. Aligns with
  [[auto-flow-never-deletes]]: never destroy source without proof it's safely copied.
- **Decision:** route both sites through `moveFileCrossDevice`; keep the per-item
  `try/catch → failed += 1` counting + `prog()` so the batch loop is unchanged.

### #21 — spawn-capture sentinel `''` vs `null`  ·  status: DONE
- `runCapture(cmd,args,timeoutMs)` in `main-mod/07-naming-organize.js` returns the
  captured **stdout string**, `''` on spawn-throw / timeout / error, `out` on close
  (any exit code).
- `runFfprobeJson(srcPath)` in `main-mod/06-copy-transfer.js` is the same spawn-capture
  boilerplate but returns `null` on error and `code===0 ? out : null` on close (discards
  output on a non-zero exit).
- **Decision:** standardize on the **`''` sentinel** (empty string). Give `runCapture` an
  `onlyOnSuccess` option that returns `''` on a non-zero exit, and have `runFfprobeJson`
  delegate to it. `probeMeta` only tests `if (out)` — `''` is falsy, so behavior is
  identical AND the "trust output only on success" gate is preserved. `runAdb` returns
  `{code,out,err}` (needs stderr + code) — **legitimately different shape, left alone.**

### #19 — two right-click/menu-bar SUBMENU builders  ·  status: DONE
- `openSubmenu` (inside `openMenu`) and `openSub` (inside `showContextMenu`) in
  `src/mod/06-menus.js` are ~55 lines of near-identical DOM build + fixed-position math.
  They diverge only in feature set: menu-bar uses `header` + `desc` (two-line items);
  context uses `danger` + `disabled` + `val()` (functional label/checked).
- **Confirmed compatible:** menu-bar submenu items use **plain-boolean** `checked` (never
  functional) and never set `danger`/`disabled`; context items never set `header`/`desc`.
  So a single **superset** renderer (all of header/desc/danger/disabled + `val()`) emits
  identical DOM for both callers.
- **Decision:** extract module-level `buildSubmenuFlyout(opts, anchorBtn, menuEl,
  cancelCloseSub, scheduleCloseSub) → subEl`; both wrappers keep their own
  `activeSub`/close-timer closure and just assign its return. Add one module-level `val`
  helper (remove the function-local copy).

---

## Deferred / not-a-dupe (don't "fix")

- `runAdb` vs `runCapture`/`runFfprobeJson` — different return shape (`{code,out,err}`).
- `listRemovableDrives` PowerShell spawn — domain-specific parse (returns drive array),
  not a general capture helper.
- `moveFileCrossDevice` long-job spawns (compression 4300) intentionally NOT wrapped in
  `killAfter` — long jobs must not self-kill.

## Done (earlier rounds, for context)

- **R1 (0.4.16):** video-ext list single-sourced (`VIDEO_EXT_LIST`); `addUnique`;
  `extractFrame` replaced 5 ffmpeg frame-grab copies; shared consts.
- **R2 (0.4.17):** `canon`, `phoneVisibleMedia`, `personThumbHTML`, Ollama endpoint const.
- **R3 (0.4.18):** one `pctOf()` integer-clamped progress formula (was round-vs-clamp #17).
