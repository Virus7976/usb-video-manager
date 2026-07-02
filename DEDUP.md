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

## Component architecture roadmap (single source of truth) — 2026-07-01

**The principle (why bugs feel like whack-a-mole):** a bug recurs when *the same decision
is encoded in N places*. When "is this file safely copied?" is written 5 different ways,
fixing one leaves four wrong — and they drift. The cure is **one function owns one
decision; every site calls it.** Dedup (collapsing copies) is half of it; the other half
is **extracting the primitive that should have existed** and routing all call sites
through it. A backend audit (3 parallel passes, 2026-07-01) mapped where we're not there.

**Target shape — 3 layers, dependencies point DOWN only:**
- **L0 core primitives** (no domain knowledge): `ConfigStore`, fs-safe
  (`copyFileVerified`/`moveFileCrossDevice`/`scanDir`/`ensureDir`), spawn
  (`runCapture` buffered + `streamSpawn` streaming), `pathsEqual`/`relCanon`,
  result-convention `{ok:!failed, copied, failed, errors[]}`, `shortId`.
- **L1 domain components:** `ai-client` (Ollama — currently mis-buried in 06-copy),
  `media` (probe/poster/thumb — in 06), `ledger`, `people-db`, `memory-store`.
- **L2 IPC handlers:** THIN — validate input → call L1/L0 → return the result convention.
  (Today `finalize:run`/`copy:start` are ~120 lines doing everything inline.)

**Known inversions to fix:** `ai-client` lives inside `06-copy-transfer` but is called by
03/07/08; `01-core` calls feature code (`confirmQuitIfCopying` in 06); `config` is mutated
from 8 modules with no accessor boundary.

**Missing/bypassed primitives (ranked by bugs prevented):**
| # | Primitive | Kills (concrete bug) |
|---|-----------|----------------------|
| P1 | `copyFileVerified(src,dest,{size})` — copy→fingerprint→1 retry→throw | silent corrupt NAS/phone backups + the two divergent NAS-mirror copies (06:426 vs 09:360) + unverified `phone:distribute` (05:586) / sim pull (05:254) |
| P2 | result convention `{ok:!failed,…}` + `logWarn` (no bare `catch{}`) | `phone:distribute` returns `ok:true` on partial failure (05:591) → UI shows success on a dropped-photo backup |
| P3 | `ConfigStore`: `patchConfig`/`saveKeys` + split append-stores into own files | ~60 whole-file rewrites per toggle (write-amplification); dup reload-merge that can clobber in-memory edits (08:502 == 08:595) |
| P4 | `streamSpawn(cmd,args,{onLine,timeoutMs,watchdog})` | MTP `CopyHere` has **no timeout** → hung phone = orphan process forever (05:508); compress capture boilerplate (09:80) |
| P5 | `scanDir(dir,{exts,recursive,dirsOnly,skipJunk})` + PS/ADB regex generated from `VIDEO_EXT_LIST` | 4 hand-rolled scanners drift (02:270/287, 05:597, 02:309, 03:127); `PS_PHONE_SCAN $rx` (05:104) still hardcodes exts → latent drift |
| P6 | `pathsEqual(a,b)` (case-correct) + `relCanon(p)` | compress collision check misses case-dup on Windows (09:66/70 lacks `.toLowerCase()`); 6× inlined rel-canon (03) |
| P7 | route remaining raw `mkdir` → `ensureDir` | ~9 swallowed mkdir failures hide the real error |

**Also queued (from the dedup hunt, "Round 5"):** the "already-present" resume gate has
5 copies with 4 strictness levels (unify as `alreadyPresent(dest,size,{verify})`); AI
memory "dedup+push+cap+save+notify" written 4× (07:580/644/681/791 → `addMemories()`);
`aiExtractRules` unwrap 7× (07:573… → `extractRulesFrom`, folds the 07:678 divergence);
route `subjects`/`locations` through the existing `makeListHandlers` factory; small id/
cacheTag/err-msg helpers.

**Staged plan — each stage independently ships + CDP-verifies; ordered by bug-prevention:**
1. **P1 + P2 — DONE + VERIFIED (v0.4.21, 2026-07-01).** Added `copyFileVerified(src,dest)`
   in 02-media.js (ensureDir → skip-if-fingerprint-identical → copy → verify → 1 retry →
   throw; returns 'copied'|'skipped'). Routed the import NAS mirror (06:429), the finalize
   NAS mirror (09:365), and `phone:distribute` (05:586) through it — the two NAS mirrors no
   longer diverge, and the size-only phone copy is now content-verified. P2:
   `phone:distribute` returns `{ok:!failed, copied, failed, errors[]}` (was `ok:true`
   always) and the renderer shows `N/M photos … ⚠ K failed`. **Verified:** control-flow
   unit test (fresh→copied, rerun→skipped, **same-size-different-content→re-copied not
   skipped**, missing-src→throws) all pass; live 0.4.21 boots healthy, store round-trips
   still pass. NOTE: real NAS/phone hardware not exercised from here — the primitive's
   logic is proven, the wiring is syntactic + boot-verified.
2. **P3 ConfigStore — STEP 1 DONE + VERIFIED (v0.4.20, 2026-07-01).** Split the four
   top-level append stores (`renameDrafts`/`finalMeta`/`renameVersions`/`projectLedger`)
   into their own sidecar files (`drafts.json`/`final-meta.json`/`versions.json`/
   `project-ledger.json`) via `STORE_FILES` + `loadStores`/`saveStore`/`freshStore`/
   `migrateStores` in 01-core; `saveConfig` now strips those keys. Collapsed the dup
   reload-merge (`currentDrafts`==`currentFinalMeta`) into `freshStore(key)` — removes the
   clobber-in-merge bug. Wired 08 (drafts/versions/finalMeta) + 03 (ledger, 2 sites) onto
   `saveStore`. **On-disk verified:** non-destructive migration created all 4 sidecars with
   correct counts; **config.json 1073KB → 385KB (−64%)**; settings intact; drafts/versions/
   finalMeta/ledger round-trips pass via CDP. *Vestigial now: `readConfigFresh` +
   `lastSelfWriteMtimeMs` (no callers) — remove in a later pass.*
   **STEP 2 — DONE + VERIFIED (v0.4.26, 2026-07-02).** Extended the sidecar mechanism to
   NESTED keys (`storeGet`/`storeSet` dotted-path + `stripStoresForWrite` that clones the
   parent so the live config isn't mutated) and split `ai.people` (face descriptors — the
   real monster) + `ai.clipObs` into `people.json`/`clip-observations.json`. Rewired all 9
   `ai.people` mutation handlers (08) + clipObs:set (03) to `saveStore`; `faces:ignore` does
   both (people→sidecar, ignored stays in config); `faces:unignore`/`ai:replaceMemories`
   stay `saveConfig`. **On-disk verified:** non-destructive migration wrote people.json
   (356KB, 2 people, 19+8 faces intact) + clip-observations.json; **config.json 385KB → 10KB
   (−97%)**; ai.memories/enabled/ui preserved; CDP peopleCount=2. Unit-tested the nested
   helpers incl. strip-non-mutation. Remaining ai.* am(memories/styleExamples/feedbackLog)
   are tiny — not worth splitting.
3. **P4 streamSpawn — DONE + VERIFIED (v0.4.23, 2026-07-02).** Added `streamSpawn(cmd,
   args,{onLine,onData,idleMs,timeoutMs,env})` in 07 (streaming sibling of `runCapture`)
   with an IDLE watchdog (resets on each output chunk, so a slow-but-progressing job isn't
   killed — unlike killAfter's fixed deadline). Fixed the MTP-hang: `mtpCopyViaMtp` (05)
   spawned PowerShell `CopyHere` with NO timeout, so a phone yanked mid-COM-call left an
   orphan forever; now killed after 8 min of total silence (its per-file PS wait is bounded
   to ~300s, so 8 min = genuinely wedged). Unit-tested (line-stream, idle-kill, progress
   resets timer); boot-verified on 0.4.23. Other 05 spawns (`runPwshScript`, `runAdb`)
   already had timeouts. *Follow-up: `runPwshScript`/`runAdb`/compress could delegate their
   spawn scaffolding to `streamSpawn` (D5) — not done (return-shape adapters, low urgency).*
   **P5 regex single-source — DONE + VERIFIED (v0.4.24, 2026-07-02).** Added
   `IMAGE_EXT_LIST` + `VIDEO_EXT_RX_SRC`/`MEDIA_EXT_RX_SRC` in 01-core; `IMAGE_EXTS`, the
   ADB scan, and the PowerShell/MTP scan now ALL derive from the two ext lists. Fixed a
   real drift bug: the PS `$vrx` had drifted to omit `mts|m2ts`, so AVCHD clips on a phone
   were invisible to the MTP scan (ADB found them). Runtime-verified the derived regexes
   include mts/m2ts and classify correctly; boot-verified on 0.4.24. *Still pending (dedup,
   not a bug): the JS `scanDir` consolidation of the 4 readdir walkers
   (listVideosShallow/listImagesShallow/walkForVideos/scanSimPhone).*
4. **P6 paths + P7 ensureDir — DONE + VERIFIED (v0.4.22, 2026-07-02).** Added
   `pathsEqual`/`pathKey` (filesystem-case-aware) in 01-core; fixed the compress
   collision bug (09:66/71 compared case-SENSITIVELY → `Clip.mp4`/`clip.mp4` could
   overwrite on Windows) and routed `organizeMove`'s hand-rolled case-fold compare
   through it. Burned down `mkdir`: 7 async sites → `ensureDir` (baseline 12→5; the
   remaining 5 = the two sync config writers, the sync MTP Promise-executor, and
   `ensureDir`'s own definition — all legit). Boot-verified on 0.4.22.
   The Round-5 mechanical batch (memory/rules/list dedup) is still pending.
5. **Relocate components:** lift `ai-client` and `media` out of 06 into their own modules;
   thin the `finalize:run`/`copy:start`/`prefs:set` mega-handlers onto L1 calls.

**Anti-regression (so it STAYS fixed — this is what stops the mole game) — DONE (2026-07-01).**
`scripts/check-primitives.mjs` (wired into `npm run check`) counts raw `spawn(` / `copyFile(`
/ `mkdir(` bypasses in `main-mod/**` and **fails if any category exceeds its committed
baseline** (`scripts/primitives-baseline.json`) — fixing bypasses is always allowed, adding
one fails with the file:line + the primitive to use. Count-based so it grandfathers today's
known bypasses and only catches NEW ones (verified: a fresh raw `mkdir` fails the gate).
**Current baseline = the burn-down list:** `spawn:12, copyFile:4, mkdir:12`. Lower these over
time (P7 = route the 12 mkdir through `ensureDir`; P4 = the spawns through `streamSpawn`),
running `--update-baseline` after each reduction. Extend RULES with a `config.<store>=`
rule once a ConfigStore accessor exists.

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

## Component hardening pass (v0.4.27–0.4.28, 2026-07-02)

Took every extracted primitive and made it the best it can be, driven by 4 parallel
adversarial reviews (ConfigStore / verified-fs / spawn / path-ext-rules-submenu-guard).
Applied only real correctness/robustness wins (unit-tested the pure logic; boot + CDP
verified). Highlights:
- **ConfigStore (0.4.27):** FIXED a live data-loss bug — `clips:retagPerson` mutated the
  finalMeta/drafts sidecars then called `saveConfig()` (which strips them) → re-tags
  reverted on restart; now `saveStore`. `stripStoresForWrite` only strips a key if its
  sidecar EXISTS on disk → data can never land in ZERO files. `writeJsonAtomic` fsyncs
  before rename + cleans temp on any failure. Removed dead `readConfigFresh`.
- **Verified-fs (0.4.27):** post-copy verify now fsyncs then does a FULL hash (sampled
  missed a length-preserving mid-file corruption — unit-proven); `copyFileVerified`
  unlinks dest on final failure. Sampled kept for resume/dedup scans.
- **Spawn (0.4.28):** `treeKill` (Windows `taskkill /T /F`) everywhere — `proc.kill()`
  only killed the immediate PID, so the MTP idle-kill could still orphan the COM worker
  (undercut P4). `streamSpawn` merges env into process.env (was replacing → PATH-drop
  trap); output caps; MTP 3h absolute backstop.
- **Guard (0.4.28):** fingerprint baseline (file+normalized-line) replaces the global
  count — a new bypass fails even if an old one is removed same-commit (negative-tested).
  Ext regexes now regex-escape each extension. Last bespoke `aiExtractRules` unwrap folded
  into `extractRulesFrom`. Submenu `desc` honors lazy values.

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
