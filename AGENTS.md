# AGENTS.md — project memory & dev guide

> # ⚠️ UPDATE THIS FILE RELIGIOUSLY ⚠️
>
> **This is the project's living memory.** Every meaningful change — a feature, a fix, a
> convention, a gotcha you hit — gets a note here **in the same commit**. Humans and AI
> assistants both read this file first to understand how the app works and *why* things
> are the way they are. Treat updating it like updating the changelog: not optional.
>
> If you only change one line of code but learn something non-obvious, write it down here.
> A stale AGENTS.md is worse than none — keep it true.

This file is the equivalent of an `AGENTS.md`/`CLAUDE.md` convention file. The
human-facing release notes live in [`CHANGELOG.md`](CHANGELOG.md); the full
build/test/publish runbook (incl. setting up a new machine) is in
[`RELEASING.md`](RELEASING.md); deep architecture notes can also go in the repo **Wiki**.
**Hard-won learnings and breakthroughs get logged in [§8](#8-lessons--breakthroughs-append-here)
— append, don't overwrite.**

---

## 0. ⭐ ALWAYS CHECK THE ISSUES TAB FIRST ⭐

**Before doing ANY work on this repo — every session, every time — read the open
[Issues](../../issues).** They are the live to-do list, roadmap, and bug tracker.

- Start by listing open issues and deciding what (if anything) to pick up or update.
- When you finish a change, check whether it **closes or affects** an open issue and update
  it (comment, label, or `Closes #N` in the commit/PR).
- File a new issue for anything you discover and don't fix immediately. Don't let work
  live only in your head — it belongs in the Issues tab so the next person/AI sees it.
- The **Actions** tab runs `issue-check.yml` daily to print all open issues into the log —
  a server-side backstop so the list is always surfaced even when no one's looking.

This is rule **zero** for a reason. A change that ignores the issue tracker is incomplete.

### Issue-first workflow (how every request is handled)

When the user brings ANY request or bug (one or many):
1. **File each as its own Gitea issue FIRST**, before coding.
2. Write a **big, self-contained description** so the next person/AI can act on it cold,
   without re-reading any chat (don't make others waste tokens). Include: Summary, Context/why,
   Where it shows up (screen + files/functions), Acceptance criteria checklist, Notes/constraints,
   and a label.
3. **Fix one by one.** Each: implement -> `npm run check` -> `npm run build:win` -> verify the
   asar marker -> close the issue (`Closes #N`) with a comment summarizing the fix + commit.
   Cut a release with `npm run release` (see §3).

Full details and a copy-paste issue template are in the Wiki -> **Issue Workflow** page.

How to list them from the CLI:
```
curl -s -H "Authorization: token <YOUR_TOKEN>" \
  "https://gitea-gour.jakegour.com/api/v1/repos/liamgour/USB-Video-Downloader/issues?state=open&type=issues"
```

---

## 1. What the app is

An offline Windows (Electron) desktop app for videographers. Pipeline:
**import (SD/USB/phone) → rename → copy+verify → compress → analyze with LOCAL AI → organize into a Projects tree → embed XMP metadata → clear card.**
All "AI" is local: Ollama vision models over HTTP + bundled face-api.js. No cloud, ever.

## 2. Architecture

- **`main.js`** — Electron main process. All privileged work: `ipcMain.handle(...)` handlers,
  ffmpeg/ffprobe spawning (thumbnails, contact sheets, **compression**), ExifTool
  (`exiftool-vendored`) XMP embed, Ollama HTTP calls, MTP/phone via `Shell.Application`
  COM driven by PowerShell `-EncodedCommand`, copy + sampled-SHA-256 verify, NAS mirror,
  finalize/organize. Config load/save lives here.
- **`preload.js`** — `contextBridge.exposeInMainWorld('api', {...})`. The ONLY surface the
  renderer may call. Every new IPC needs a one-line bridge here.
- **`src/renderer.js`** — ~9k lines, essentially all UI logic. Rename grid, AI flows,
  destination map, faces, the task bubble/theater, settings, menus.
- **`src/index.html`** — app shell (Fluent titlebar, menu bar, step flow, static modals).
- **`src/styles.css`** — native dark Fluent styling.
- **`src/face-models/`** + **`src/face-api.min.js`** — bundled local face recognition (WebGL).
- **`config.json`** — bundled machine-independent DEFAULTS only. Real user settings live in
  `%APPDATA%\USB SD Auto-Action\config.json` (never committed).

**Golden rule:** renderer ↔ main only through `window.api`. A typical feature =
`ipcMain.handle('x', …)` (main) + `x: (p) => ipcRenderer.invoke('x', p)` (preload) + UI (renderer/html/css).

## 3. Build / release / verify loop

**Cutting a release is one command** — `npm run release` (`scripts/release.mjs`) does the whole
loop: bump → `npm run check` (syntax) → `npm run build:win` → verify the artifacts → commit →
tag → push → publish to Gitea. Run it **on Windows** (or under wine — `electron-builder --win`
can't stamp the `.exe` on bare Linux/WSL).

```powershell
$env:GITEA_TOKEN = "<repo+release scoped token>"   # one-time per shell
npm run release            # release current version
npm run release patch      # …or bump patch | minor | major | x.y.z first
npm run release:dry        # fast validate: syntax + plan, no build, no mutations
npm run release -- --skip-build   # publish an already-built dist/
npm run release -- --no-publish   # build + tag + push, skip the Gitea upload
```

It publishes **two** Gitea releases from one build:
- **`vX.Y.Z`** — the permanent, human-facing archive of that version.
- **`latest`** — a fixed-tag release that `release.mjs` recreates each time; the installed
  app's **auto-updater** (electron-updater, `build.publish` generic feed in `package.json`)
  polls `…/releases/download/latest/latest.yml`. So "publish" == users self-update; they don't
  re-download. Updates download in the background and install on quit, or immediately via the
  tray's **Restart to install update**. Auto-update is a **no-op in dev / non-Windows**
  (`app.isPackaged && win32`), so `npm start` never touches the network.

Manual build (no release): `npm run build:win` → `dist\USB-SD-Auto-Action-Setup-x.y.z.exe`.
Verify a build contains your change by substring-checking the asar at
`%LOCALAPPDATA%\Programs\USB SD Auto-Action\resources\app.asar` (silent install: run the
Setup `.exe` with `/S`).

- CI (`.gitea/workflows/release-check.yml`) is a **backstop, not a builder**: on a `v*` tag it
  re-checks syntax + that the tag, `package.json`, and `CHANGELOG.md` agree and that both Gitea
  releases actually exist. It does **not** build (the Linux runner has no wine).
- **Gotcha:** `electron-builder`'s `winCodeSign` extraction can fail with a symlink permission
  error on some Windows setups. Workaround: enable Developer Mode / run the build elevated once,
  or pre-extract the winCodeSign cache.

## 4. Conventions (do not break these)

- **Native dark Fluent look.** Every new UI must match the existing dark Fluent style
  (CSS variables in `styles.css`). Verifying the look is part of "done". Group settings/modal
  content with the shared `.pref-section` / `.pref-sec-t` / `.pref-body` primitives (uppercase
  header + card body + steady spacing) instead of ad-hoc inline margins.
- **Restrained, purposeful motion.** This is a precise pro tool, not a toy — motion must
  *explain state*, never perform. Keep transitions/entrances ~120–200ms with standard easing
  (`ease`); **no** bounce/overshoot, springy scales, breathing "glow" pulses, decorative
  sweeps/shimmers, or sparkle/confetti celebrations. Continuous *indicators* of active work
  are fine (spinners, the analyze scanline) because they convey ongoing state. The motion
  vocabulary lives in the "Coherent motion" block + the per-component rules in `styles.css`,
  and the bottom-of-file `@media (prefers-reduced-motion: reduce)` block must keep covering any
  new looping/decorative animation (functional spinners are intentionally left turning).
  Don't reintroduce a "delight" flourish — taste/restraint was a deliberate pass (see CHANGELOG).
- **Offline AI only.** Frames go to local Ollama and nowhere else. Never add a cloud call.
- **Faces are SUGGESTIONS, not auto-tags.** Recognised faces are saved to a person's profile
  as *unconfirmed* and surfaced for the user to confirm (or the explicit 🤖 Auto-faces toggle).
  Never silently mark a clip with a person without the user's confirm step.
- **Generic / no personal data.** The shipped app has NO baked-in personal projects, client
  names, or drive paths. Defaults derive from the OS Videos folder at runtime. Keep it that way.
- **Crash-safety.** Rename/analyze work autosaves (drafts, `finalMeta`, obs cache). Don't
  introduce a flow that loses work on a mid-run crash.
- **Verify before destroy.** Never delete originals before copies are checksum-verified.

## 5. Key subsystems (where to look)

- **Task bubble → popup → theater** (`renderTaskBar`, `openTaskPop`, the `#taskTheater`
  "theater" with the live thumbnail conveyor + activity feed): the single global progress UI.
  Tasks: `setTask(id,label,cur,total,phase,detail)` / `clearTask(id)`; ETA via `etaText`.
  Cancellable ids handled by `cancelTaskById`/`isCancellable` (`ai`, `faces`, `compress`).
- **The mega Analyze** (`finAnalyzeSelected` on Organize; `aiAnalyzeSelected` on the Rename
  grid): PHASE 1 faces (scan → verify via awaited `showFaceReviewGrid`, or auto-tag) → PHASE 2
  name every clip with people woven in. Passes `draft:{subject,description,location}` so it
  IMPROVES existing names. Works on photos.
- **⚡ Quick mode** (`uiPrefs.quickAnalyze`): one single-pass vision call per SUBJECT, copied
  to same-subject siblings; faces also sampled per subject (whole group's keys attached).
  The `quick` flag forces single-pass in `ai:suggest` (skips the 2 extra reasoning passes).
- **🎬 Sort with me** (`openSortChat` inside `showDestinationMap`): guided one-subject-at-a-time
  chat — autoplaying clip + "where does this go?" (folder chips + typed autocomplete) → files the
  group AND saves a filing rule (`routesCache`/`saveRoutes`) so future footage auto-routes.
- **Destination map / Organize** (`showDestinationMap`): the live placement engine
  (`recomputeAuto` → `placement{}`/`autoKeys`, rules in `routesCache`, day-folder scheme
  discovery `projectBase`/`stripDayLeaf`/`dayFolderMap`). TWO views via `render()` dispatcher:
  the default **Plan** (`renderPlan` — clips grouped by destination project into confidence-
  ranked cards, "Needs you" vs "Confident" sections, inline change/remember) and **Folders**
  (`renderTreeView` — the colour-coded tree). Every placement records WHY + confidence in
  `placeMeta` (`setMeta`): rule / ledger / subject / unsorted / ai / manual. Accuracy comes from
  the **project ledger**: `ledgerMatch` (renderer, deterministic pre-file of obvious repeats)
  and `suggestLedgerMemory` (main.js — feeds the ledger's people/subjects/summaries into the
  `ai:suggestProjects` prompt; that handler also returns per-placement `why`/`confidence`).
- **Placement brain (`ai:suggestProjects`, main.js)**: contract is
  `{ ok, placements:[{ i, path, why, confidence }] }` — keep it. Two pure, unit-testable
  helpers shape its accuracy: **`rankCandidateFolders`** ranks the folder tree toward THIS
  batch (people/subject/location token overlap + category + a strong boost so standing-route
  dests are never hidden) and caps the list shown to the model — the right project stays
  visible, distractors that drive mis-placement are dropped, and the omitted count is told to
  the model so it picks `_Unsorted` instead of forcing a far-fetched match (small trees are
  shown whole). **`calibratePlacements`** then *overrides the model's self-reported confidence
  deterministically* — `_Unsorted` ≤0.3, brand-new project ≤0.5, existing/route/child-of-
  existing trusted — and forces clips that share a subject onto ONE destination. The renderer's
  "Needs you" vs "Confident" split depends on this calibration, so don't trust the raw model
  number. Confidence is *capped* by destination type, never *raised*. `suggestLedgerMemory`
  is @ledger's (a black box this consumes). Test pure helpers with a throwaway node script
  (extract the source between the markers; Ollama isn't runnable in CI).
  `runAiPlan` is the shared AI pass (primary "Suggest with AI", Refine, and the on-open
  `maybeAutoPlan`); `openSuggestWizard`/`openSortChat` remain as secondary tools under "More".
- **Compression** (`compress:run`/`compress:list`/`compress:defaults` in main): ffmpeg presets
  (balanced H.264 1080p / smaller H.265 / hq); `config.compressMode` = `'external'` (Tdarr
  watch-folder, default) | `'app'` (local ffmpeg). Live progress via `-progress pipe:1`.
- **Photos** ("Path A" done): `finalize:scan` accepts `{dir,includePhotos}`; `faces:frames`
  short-circuits for images (returns the image as the single frame so face detection runs on
  stills); the rest of the chain (poster/contact-sheet/ExifTool XMP into JPG) already handled
  images. "Path B" (photos in the Step-1 rename grid) is NOT done yet.
- **Metadata embed** (`finalize:run`, `buildEmbedTags`): rich XMP/IPTC via ExifTool incl.
  `lr:HierarchicalSubject` (digiKam/Lightroom), `iptcExt:PersonInImage`, Resolve CSV. People
  AND location both get a hierarchical branch (`People|<name>`, `Places|<location>`) + a
  `digiKam:TagsList` entry so they're browsable, not just flat keywords. Hierarchy components
  are run through `hc()` (de-hyphen + strip `| / \`) so a value like `AC/DC` can't split into
  bogus tree levels.
- **Plain-English filing rules** (`ai:parseRules` → `normalizeParsedRule`/`descriptorPlacement`
  in main.js; `ai:parseRoute` for the single-rule editor). A rule is a `route` (keyword →
  `dest` folder, optional `byDay`) or a `descriptor` (a shot TYPE — vlog/timelapse/b-roll —
  that must NOT be lumped into one folder). **Descriptors carry a `placement` enum, not a bare
  boolean:** `'separate'` (each shooting day = its own project) vs `'with_day'` (file into the
  day's existing project). The old `joinProject` boolean was polarity-prone (the prompt itself
  warned "they are opposites"); the model now returns the self-describing enum and we **derive
  `joinProject` from it** (`with_day` → true) for back-compat with stored rules + the renderer
  — so don't reintroduce a boolean as the model's job. `DESCRIPTOR_WORDS` is a safety net: a
  rule the model labelled `route` but with NO dest whose keywords are all known shot-types is
  reclassified to `descriptor`. Rule shape stays `{kind,name,match[],dest?,byDay,joinProject?}`
  plus the additive `placement` on descriptors.
- **Safe filing** (`organizeMove` + `moveFileCrossDevice`, both main.js): "verify before
  destroy". Name collisions are resolved by CONTENT (`fingerprintsMatch` = size + sampled
  SHA-256), not size alone — a different clip sharing a name+size is versioned `" (n)"`, never
  skipped/overwritten. Cross-device moves (EXDEV) copy to a `.part-…` temp, verify the
  fingerprint, atomically rename into place, then unlink the source — a crash anywhere leaves
  the source intact and no half-file at the destination. `projects:move` returns the uniform
  shape `{from, ok, action, path}` (+ optional `embedded`/`embedError`) even on failure.
- **First-run setup wizard** (`showSetupWizard` in `src/renderer.js`; issue #1): a multi-step
  `.modal-overlay`/`.setup-wizard` flow (welcome → intake → projects → nas → ai → faces → done)
  that points the core folders + optional AI/faces, then offers the tour. Nothing persists until
  Finish (it merges the FULL current `aiCfg` into `prefs:set` so a re-run never wipes other AI
  settings). **First-run detection:** `main.js` captures `USER_CONFIG_EXISTED` at module load
  (before any `saveConfig`) and reports `firstRun` via `config:get`; the renderer's
  `maybeFirstRunSetup()` shows the wizard once when `cfg.firstRun && !uiPrefs.onboarded`, else
  falls back to `maybeAutoTour()`. Completion sets the `onboarded` ui-pref (via `ui:set`, which
  preserves arbitrary keys) **and** localStorage `tourSeen`. Re-run from Help → "Setup wizard…",
  the Settings hub, or the command palette. Reuses `showModelStore()` (AI step) and
  `ensureFaceModels()` (faces step).

## 6. Known limitations / traps

- **Vision models hallucinate.** qwen2.5vl etc. sometimes invents a subject that wasn't shot.
  That bad subject then drives placement. Mitigations: 🎬 Sort with me (human-in-the-loop),
  manual rename, improving the perceive prompt. Don't trust auto-placement blindly.
- **ffmpeg/ffprobe must be on PATH** (or set in Settings) or thumbnails/compression fail.
- **A stale `src/` vs root `renderer.js`:** the ACTIVE renderer is `src/renderer.js` (loaded by
  `src/index.html` and bundled via `build.files`). Don't edit a root-level `renderer.js`.
- **Analyze speed:** full multi-pass per clip is slow (hours for hundreds of clips). ⚡ Quick is
  the answer; keep it the default.

## 7. How to add a screenshot to the README

The app window grabs cleanly with PowerShell (no extra tools) — see `CONTRIBUTING.md`.
Drop PNGs in `docs/screenshots/` and reference them. Avoid screens that expose real client
folder names in a public repo.

## 8. Lessons & breakthroughs (append here)

A running log of non-obvious things we learned the hard way, so nobody (human or AI) has to
re-derive them. **Append new entries at the top; never delete.** Format: `### YYYY-MM-DD —
title`, then what we learned and why it matters.

### 2026-06-28 — Streamlined build/test/publish + auto-update
- **`npm run release` is now the whole release.** One command bumps, syntax-checks, builds,
  verifies, tags/pushes, and publishes. Full runbook: [`RELEASING.md`](RELEASING.md). Don't
  hand-roll releases — that's how the `latest` feed drifts out of sync.
- **The installer must be built on Windows (or wine).** `electron-builder --win` stamps the
  `.exe` via tools that don't exist on bare Linux/WSL — so CI (Linux runner, no wine)
  **cannot** build it. That's *why* CI is only a publish-*check*, and why building is local.
  This app has **no natively-compiled native modules** (face-api = JS/WASM, gopro-telemetry =
  pure JS, exiftool ships a prebuilt `.exe`), so the *only* blocker to a Linux/CI cross-build
  is wine — if we ever add wine to the runner, full CI builds become possible.
- **Auto-update uses a fixed-tag `latest` release, not a moving URL.** This Gitea (1.26) has
  no GitHub-style `/releases/latest/download/<asset>` alias, so electron-updater points at a
  **generic** feed `…/releases/download/latest` and `release.mjs` recreates the `latest`
  release each time. If auto-update breaks, first check the `latest` release's assets are the
  current build's `.exe` + `.blockmap` + `latest.yml`.
- **Auto-update is gated to `app.isPackaged && win32`** so `npm start`, tooling, and CI never
  reach for the network or the updater.
- **Publishing needs a token with `write:repository`** in `GITEA_TOKEN` (read scope 403s on
  release create). The release script reads it from the env and never stores/prints it.

<!-- ### YYYY-MM-DD — next lesson goes above this line -->

