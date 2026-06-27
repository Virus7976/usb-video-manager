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
human-facing release notes live in [`CHANGELOG.md`](CHANGELOG.md); deep architecture
notes can also go in the repo **Wiki**.

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
3. **Fix one by one.** Each: implement -> `node --check` -> `npm run dist` -> verify the asar
   marker -> close the issue (`Closes #N`) with a comment summarizing the fix + commit.

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

```
node --check src/renderer.js        # and main.js / preload.js if touched — ALWAYS before build
npm run dist                        # electron-builder → dist\USB SD Auto-Action Setup x.y.z.exe
# silent install:  run the Setup .exe with /S
# verify the build actually contains your change by substring-checking the asar:
#   %LOCALAPPDATA%\Programs\USB SD Auto-Action\resources\app.asar
```

- Releases are published to the Gitea **Releases** tab with the `.exe` attached. `dist/` is gitignored.
- **Gotcha:** `electron-builder`'s `winCodeSign` extraction can fail with a symlink permission
  error on some Windows setups. Workaround: enable Developer Mode / run the build elevated once,
  or pre-extract the winCodeSign cache. The iconed build needs this resolved.

## 4. Conventions (do not break these)

- **Native dark Fluent look.** Every new UI must match the existing dark Fluent style
  (CSS variables in `styles.css`). Verifying the look is part of "done".
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
  `lr:HierarchicalSubject` (digiKam/Lightroom), `iptcExt:PersonInImage`, Resolve CSV.

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
