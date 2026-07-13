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

### Tests (`npm test`) — read this before "fixing" anything

```bash
npm test         # node --test test/   (rebundles first via pretest)
npm run check    # syntax + primitives guard + the full test suite
```

The suite runs the **real shipping `main.js`** inside a `vm` context with a stubbed
`electron` (`test/harness.mjs`), so every top-level helper and all 157 `ipcMain` channels are
callable without Electron or a window. See §8 for how and why that works.

```js
const m = loadMain({ userData });   // isolated temp APPDATA
m.get('VIDEO_EXT_LIST');            // read any top-level const/let/function
m.call('buildEmbedTags', meta);     // call any top-level function
await m.invoke('verify:copies', p); // invoke a real IPC handler
m.plain(v) / m.getJSON(name);       // REQUIRED before assert.deepEqual (vm realm != host realm)
```

Test footage is **generated, never committed**: `test/fixtures.mjs` shells out to `ffmpeg` for
real decodable clips/images (`makeVideo`, `makeImage`, `makeCard`), and skips when
`HAVE_FFMPEG` is false.

**Rules.** A fix without a regression test is not a fix — that is precisely what produced a
~10% regression rate over the first 78 commits (roughly 1 in 10 fixes introduced a new bug).
To prove a new test is real, break the fix, watch the test fail, restore it. Note `adb` and a
real MTP device are unavailable in WSL, so the phone stack is tested through its **parsers**
(`parsePsJson`, `adbParseDevices`, …) with recorded stdout, not a live device.

**Code on Gitea, releases on GitHub.** Gitea's server can't host the ~130 MB installer (see
§8), so the installer + auto-update feed live on **GitHub releases**
(`Virus7976/usb-video-manager`); Gitea stays the home for code/issues/PRs/wiki.

**Cutting a release is one command** — `npm run release` (`scripts/release.mjs`): bump →
`npm run check` (syntax) → commit → tag → **push code to both Gitea and GitHub** → build +
**publish the GitHub release** (`electron-builder --win --publish always`) → verify. Run it
**on Windows** (`electron-builder --win` can't stamp the `.exe` on bare Linux/WSL); it can be
driven from WSL via `powershell.exe`/Windows-`node` interop so no human touches Windows.

```powershell
$env:GH_TOKEN = "<github token, contents:write>"   # or ~/.github-token; Gitea push uses git creds
npm run release            # release current version
npm run release patch      # …or bump patch | minor | major | x.y.z first
npm run release:dry        # fast validate: syntax + plan, no build, no mutations
npm run release -- --no-publish   # build + push code/tag, skip the GitHub release
```

electron-updater reads the **latest GitHub release** (`build.publish` github provider in
`package.json`). So "publish" == users self-update; they don't re-download. Updates download
in the background and install on quit, or immediately via the tray's **Restart to install
update**. Auto-update is a **no-op in dev / non-Windows** (`app.isPackaged && win32`), so
`npm start` never touches the network.

Manual build (no release): `npm run build:win` → `dist\USB-SD-Auto-Action-Setup-x.y.z.exe`.
Verify a build contains your change by substring-checking the asar at
`%LOCALAPPDATA%\Programs\USB SD Auto-Action\resources\app.asar` (silent install: run the
Setup `.exe` with `/S`).

- CI (`.gitea/workflows/release-check.yml`) is a **backstop, not a builder**: on a `v*` tag it
  re-checks syntax + that the tag, `package.json`, and `CHANGELOG.md` agree and that the GitHub
  release exists. It does **not** build (the Linux runner has no wine), and **needs a registered
  act_runner to run at all** (none is registered yet).
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
- **Deleting from the card is NEVER automated.** It is always a deliberate, explicit user
  action, gated on verification. No auto-mode, setting, or convenience path may reach a
  source delete on its own. This is the owner's hardest rule — treat it as inviolable.
- **`await window.api.X()` CAN REJECT — never let a rejection skip your cleanup.**
  Every long-running IPC call (ffmpeg, exiftool, fs moves, adb, Ollama) can throw, not just
  resolve `{ok:false}`. The renderer used to assume otherwise: it set a latch / disabled a
  button / subscribed to a progress channel, `await`ed, and undid all three *on the happy
  path only*. One rejection then wedged the screen for the rest of the session — a button
  stranded on "Filing…", a spinner turning forever, `copyInProgress` stuck true (which nags
  on every navigation and blocks auto-mode) — plus an orphaned listener that double-wrote
  the UI on the next run. There was not one `finally` in all of `src/mod` before 2026-07-12.
  So:
  - **Busy buttons go through `withBusyBtn(btn, label, fn, onError)`** (`01-core.js`). It owns
    the `finally`. Don't hand-roll `disabled = true` … `await` … `disabled = false` again.
  - **A latch or a subscription released across an `await` goes in a `finally`** — never on
    the happy path alone. Guarding the `await` in a `try/catch` is equally fine; what is
    forbidden is an *unguarded* await that can unwind past the cleanup.
  - `test/renderer-async-cleanup.test.mjs` enforces both statically over `src/mod/*.js`, and
    proves the guard can still fail. If it trips, fix the code — don't loosen the rule.

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
- **Never stack `backdrop-filter` over `backdrop-filter`.** A translucent surface that relies on
  `backdrop-filter` (e.g. `--acrylic`) becomes **invisible on some GPUs** when it paints over
  *another* blurred element. This bit the autocomplete flyout: it showed fine over normal
  content (per-clip rename fields) but vanished when opened inside the **Name-batch modal**,
  whose `.modal-card` is also blurred. Fix: the combobox dropdown (`.subject-combo`) uses a
  **solid** `--menu-solid` background with `backdrop-filter: none`. If a menu/flyout can ever
  appear above a modal, make it opaque. (Note: this is invisible to headless render tests —
  `getBoundingClientRect`/`elementFromPoint` still report the element as present.)

## 6a. Pop-out preview window (`src/preview.html`)

A second `BrowserWindow` (created in `main.js` → `createPreviewWindow`) with **two modes**,
persisted in `config.previewGrid` (`{ mode, source, tile, playVideos, muted }`):
- **mirror** — one clip, `<video>` for footage or `<img>` for photos. `preview:set` carries a
  `kind` (`photo`/`video`, inferred from `IMAGE_EXTS` if absent).
- **grid** — a wall of every clip in scope (`selected`/`all`/`unnamed`). The **main window owns
  the clip list** (`renderer.js` → `pushPreviewGrid`, debounced, hooked into `updateBatchBar`);
  it sends paths via `preview:list` and main resolves `file://` URLs. Clicking a tile fires
  `preview:jump` → main → main window → `focusClipFromPreview`.
- Config is the single source of truth in **main**; either window can change it (`preview:config`
  / `preview:mode`) and main persists + **re-broadcasts to both** so they stay in lockstep.
  New preload channels: `previewList / previewConfig / previewMode / previewJump / previewReady`
  and `onPreviewList / onPreviewConfig / onPreviewJump`.

## 7. How to add a screenshot to the README

The app window grabs cleanly with PowerShell (no extra tools) — see `CONTRIBUTING.md`.
Drop PNGs in `docs/screenshots/` and reference them. Avoid screens that expose real client
folder names in a public repo.

## 7a. ⚠ IN PROGRESS — the AI redesign (tool-calling)

**If you are picking this up mid-flight, read this first.** Owner's verdict: *"very gimmicky, it
doesn't learn well, it has no idea how to group projects or how to ask questions. The AI shouldn't
have to think that much, it should just be choosing when to use the tools it's given."*

### Four root causes (all verified against the code)

1. **No tool-calling, anywhere.** All 24 AI call sites go through `ollamaGenerate` → `/api/generate`
   with `format:'json'` + a giant instruction prompt, parsed by `parseJsonLoose` — which *always*
   returns an object, so a total model failure is indistinguishable from an empty answer.
2. **`aiTextModel()` silently fell back to the VISION model**, and `textModel` defaults to `''`. Out
   of the box, *every* text task — project placement, rule distillation, memory consolidation — ran
   on `qwen2.5vl:7b`: weak at instructions, weak at JSON, and **incapable of calling tools**.
3. **The "learning" is a self-confirmation loop.** `learnFromAnalysis` defaults ON; after each run
   `ai:reflect` feeds the model its own observations paired with its own generated names and asks
   "what rules explain these choices?", then auto-saves the result into memory. It writes down what
   it already does and calls it the user's preference. Real user corrections aren't privileged.
4. **Memories are injected uncapped** into every clip's prompt (the store caps at 300 → ~18 KB of
   English rules per clip, on a 7B model).

Also: project placement shows the model **folder names only, never contents**, and the ledger is only
written *after this app files something* — so a pre-existing library gives it bare strings and an
instruction that "PAST FILING MEMORY WINS" about an empty list. The LLM question-generator
(`ai:batchQuestions`) is **dead code**, replaced by a hardcoded `for` loop over subjects.

### The shape we're moving to

Vision model **perceives** (observation only, no decisions) → a tool-capable text model **decides**
by calling tools: `search_projects` / `inspect_project` / `place_clip` / `create_project` /
`ask_user`. The folder tree becomes something the model *queries*, not a list it must memorise.

### Landed so far

**Transport + model choice** (`main-mod/06-copy-transfer.js`):
- `ollamaChat(model, messages, {tools})` on `/api/chat` — parses `tool_calls`, tolerates
  args-as-a-JSON-string, and reports "no tool call" honestly (the old `parseJsonLoose` *always*
  returned an object, so total failure was indistinguishable from an empty answer).
- `ollamaCapabilities()` / `ollamaModelTools()` — reads Ollama's own `capabilities` array. The code
  already parsed that array and only ever tested it for `'vision'`. Cached; never *guesses* a model
  into tool mode (a model that can't call tools just returns prose and breaks everything downstream).
- `ollamaListModels()` — one owner for `/api/tags`, which was being re-fetched in four places.
- `aiTextModel()` no longer falls back to vision. `aiToolModel()` / `autoPickToolModel()` select an
  installed tool-capable model and persist it. **Not memoized** — a cached promise there outlives
  config changes and model installs (a test caught this).

**Learning** (root cause 3 + 4):
- `reflectFromClips` now only samples clips the user actually CORRECTED (`clip._userNamed`, set in
  `recordAiEdit`). An untouched clip's name IS the AI's output — feeding it back is the loop.
- The `ai:reflect` prompt no longer says *"a system … produced these names"*. Filtering the samples
  isn't enough on its own: the model was being told to reason about its own choices, so it looked for
  the wrong thing. It now says these are THE USER's names, and that "none" is a fine answer.
- `selectMemories()` caps the memories injected per clip at 24 (was UNCAPPED — up to 300 rules,
  ~18 KB, into every clip's prompt). Deliberately **not** a pure relevance filter: a rule like
  "always lowercase with hyphens" is global and has zero lexical overlap with any clip, so a naive
  ranker would bin exactly the style rules that matter. Keep everything while it fits; only rank
  (relevance, then recency) once over budget; emit in original order so the prompt stays stable.

**Testing** — the harness had **no `fetch` in its vm context**, which is why the AI subsystem had
never had a single test. It does now, with no Ollama and no GPU required:
`test/ai-tools.test.mjs`, `test/ai-model-choice.test.mjs`, `test/ai-learning.test.mjs`. Stub the
transport with `app.get('globalThis').fetch = …`, and normalise objects crossing the vm boundary
with `JSON.parse(JSON.stringify(x))` — they carry the sandbox's `Object.prototype`, so
`deepStrictEqual` fails on identity alone.

### Landed: the tools themselves (`main-mod/10-ai-tools.js` — new file)

`defineTool()` / `toolSchemas()` / `runToolLoop()`. The loop asks → runs a tool → feeds the result
back → repeats until a **terminal** tool. It handles, in code and under test: no tool call at all
(an honest "I don't know"), a hallucinated tool name (corrected in-band), a withheld tool, max-steps,
a tool that throws, and the **protocol guard** below.

**The structural bit that made the difference — don't undo it.** Every durable fix here was a change
to what the model *can* do, not to how nicely it was asked:

- It invented projects instead of asking → `create_project` now declares `requires:
  ['search_projects']` and `place_in_project` declares `requiresAny: ['search_projects',
  'recall_decision']`. `runToolLoop` **refuses the call in code** until the prerequisite has run. It
  then asked, on its own.
- It invented subjects (`car-door`, a second spelling of `lawn-mowing`) → `set_clip_name`'s `subject`
  is a schema-level **`enum`** of his real subjects. It is now *impossible* to emit a new one;
  `propose_new_subject` is a separate, deliberate act that refuses near-duplicates.
- Descriptions ran 20+ words → capped in code (`aiCapWords`), not requested in a prompt.
- Search couldn't match "alpine" → "Alps" → **the TOOL was stupid, not the model.** `aiTokenMatch`
  matches on a 3-char shared prefix. Not 4: "alpine"/"alps" and "skinning"/"skiing" share exactly 3 —
  measured against the words that actually failed.

Placement memory (`rememberPlacement` / `recallPlacement`, persisted in `config.placementMemory`) +
`backfillLedgerFromTree()` (the pre-existing library, which the ledger never knew about) +
`learnFromLibrary()` (real subjects and `styleExamples` mined from the 310 clips he had already named
himself). **An exact recall skips the model entirely** — that is "it only ever asks it once and then
it knows".

### Landed: all of it is now REACHABLE (this was the last gap)

The tools, the loop and the grid all existed and passed tests while **nothing in the UI could reach
them**. Three entry points close that:

- **Analyze** (`aiSuggestClip`, `src/mod/04-tasks-ai.js`) → `aiNameWithTools()` runs
  **perceive → choose**: the vision model only LOOKS, then the tool model NAMES from the subject
  enum. Returns `null` — never a half-name — whenever it can't run, so the old single-call path is
  an intact fallback. Gated on `aiToolModelReady`, latched by `renderAiHealth()` **before** its
  no-problems early return (latching after it would have switched the tool path on only for a
  *broken* config — see the test).
- **Organize** (`finPlaceIntoProjects`, `src/mod/09-phone-finalize.js`) → the `#finPlaceBtn` bar in
  step 2 opens `showPlacementReview()`. A confirmed choice is written back as **`f.meta.ledgerRel`**,
  which is the *only* field the destination map reads: without that write-back the app asks, the user
  answers, and everything still files into `_Unsorted`. **That exact bug already shipped once.**
- **The AI health card** (`renderAiHealth` / `applyAiHealthFix`) surfaces the four things that were
  silently wrong in his real config (weak vision model, no tool model, unlearned style, no
  `projectsRoot`) — each with a one-click fix. Silent when healthy; it does not invent problems.

### Still to do

- ~~Verify tool-calling against the real `qwen3:8b`.~~ **DONE — it works.** Run on the real GPU
  against his real footage: 6/6 tool calls, correct protocol (`get_naming_style` → `get_shoot_context`
  → `set_clip_name`), 0 invented subjects, 0 camera-words, 80% subject match. See the two sections
  above for the numbers and what they cost.
- **Grow `styleExamples` from every user correction** (`learnFromLibrary` seeds them from the
  archive, and `recordAiEdit` now marks corrections with `_userNamed`, but the two aren't joined up).
- Delete the dead `ai:batchQuestions` / `ai:parseRoute` handlers.

### ⚠ THE SINGLE-GPU RULE — measured, and it constrains every AI design here

**His card is an RTX 3060 Laptop with 6144 MiB.** Measured, on his machine, with `nvidia-smi` +
`/api/ps`:

| | VRAM |
|---|---|
| baseline (desktop) | 787 MiB |
| `qwen2.5vl:7b` loaded, mid-run with images | **5411 MiB** (88% of the card) |
| `qwen3:8b` loaded | **4937 MiB** |
| both at once | **impossible** — `cudaMalloc failed: out of memory` |

So: **one model resident at a time, ever.** Three rules, all enforced in code, all easy to silently
undo:

1. **Batch.** Vision phase (perceive every clip) → reasoning phase (name every clip). Never
   perceive-then-name per clip: that swaps 5 GB of VRAM *on every clip*. `const batched =
   aiCfg.multiPass || aiToolModelReady` — with a distinct tool model this is not a preference, and
   `multiPass` (off by default!) gets no say. `aiNameWithTools` takes `noPerceive` so a batch
   *cannot* fall back into a vision load mid-phase.
2. **Evict at the phase boundary** (`ollamaUseOnly`). Batching alone is NOT enough and this is the
   subtle one: Ollama keeps a model resident for `keep_alive` (5 min default) after its last request,
   so the vision model is still in VRAM when the reasoning model loads. The phases were separated in
   *time* but not in *memory*. `keep_alive: 0` is what actually evicts.
3. **Release when the run ends** (`releaseGpu`, called from analyze, improve, auto-enhance AND
   placement — "don't be a resource hog"). Otherwise a finished run sits on 5 GB while he goes off to
   edit video.

`ollamaUnload` **verifies** the eviction against `/api/ps` rather than trusting the HTTP 200, and
`ollamaUseOnly` reads Ollama's *real* loaded state — another app, or an `ollama run` in a terminal,
can load a model behind our back and our own bookkeeping would never know.

### ⚠ get_shoot_context — the biggest naming win, and the least obvious

**Measured end-to-end on his real footage (6 real clips, real GPU, his own filenames as ground truth):
subject match 60% → 80%.** Nothing else came close. Full protocol results: 6/6 tool calls (zero
prose), **0 invented subjects** (the enum holds), **0 camera-words** in descriptions.

**HE SHOOTS IN BATCHES.** Mined from the 310 clips he named himself: 20 of his 28 shoot days are
*entirely one subject*. `2026-06-01` = 37 lawn-mowing + 14 vlog. **Knowing only the DATE and guessing
that day's dominant subject scores 88% on its own** — better than the entire vision pipeline.

And it explains a failure vision can never fix. `2026-06-01_lawn-mowing_josiah_v23` is twelve minutes
of two men **sitting on the grass repairing a mower**. Nobody mows. I pulled 9 frames and looked at
them. The label is not in the pixels — **the subject is what the footage is FOR (the job), not the
action on screen**, and that lives in the sibling clips. More frames would only have cost him time.

The tool returns **counts, not a verdict**, so the model weighs it against what it saw. Verified on
the adversarial case: `2026-05-11` is timelapse×13 vs pov×2, and it still correctly answered **pov**,
because the observation said so. A tool that returned a single answer would have broken that.

### ⚠ SHOOT MEMORY closed the last gap — 60% → 80% → **100%** on the real six

The mower-repair clip is the one vision can never get. So the app now **asks once per shoot** (a card
per unknown day in the faces-style grid, at the vision→reasoning phase boundary, where the GPU is
empty anyway) and **remembers the answer forever** (`config.shootMemory`, one entry per day). 37 clips
from one shoot is ONE question. A shoot he has answered — or has ever named a clip from — is never
asked about again. That is *"or it only ever asks it once and then it knows"*, and it is the invariant
the tests exist to protect.

With the shoot answered, the six real clips score **5/5 subjects**, 6/6 tool calls, 0 invented
subjects, 0 camera-words.

### ⚠⚠ THE TOOL-RESULT STRINGS ARE LOAD-BEARING. MEASURED. DO NOT "TIDY".

I renamed one key in `get_shoot_context`'s return and reworded its note. Cosmetic. Identical data.
It flipped `2026-05-11_pov_wood-cleanup-fairview` from **`pov` (his name, correct)** to **`vlog`
(wrong)** — deterministically, **4 runs out of 4 each way**, at temperature 0.1 on the real qwen3:8b.
A tidy-up cost 20 points of subject accuracy.

On an 8B model the phrasing of a tool *result* is **input, not documentation**. `"for the same day"` +
`"a day can STILL contain more than one subject"` keeps the counts as evidence to weigh; calling the
day a *"shoot"* frames it as one thing, and the model starts answering with the day instead of with
the footage. There is a test pinning the exact strings. **If you change them, re-measure against his
footage.**

### ⚠ PLACEMENT IS PER-SHOOT — and the silent mis-file it fixes

`recallPlacement` used to match on **subject alone** and return `confidence: 'exact'`, and the review
grid **auto-files an exact recall with no card and no question**. So: he files his 2026-06-01
lawn-mowing shoot into `Clients/Josiah`. A month later he mows a different property. Subject matches →
"exact" → **the new shoot is silently filed into Josiah's project.** Never asked, never told. That is
what *"later I go to the output folder and get AI to work out which project each video belongs in —
this part I know sucks"* actually looked like from the inside.

Same root cause as naming: it treated a **subject** as if it were a **shoot**. Now:

- `groupClipsForPlacement` groups by `date|subject`. Two lawn-mowing shoots are two cards, two
  questions. (It used to collapse every lawn-mowing clip he has ever shot into ONE card → ONE project.)
- `rememberPlacement` / `recallPlacement` are keyed on the shoot day. **Only the same shoot is
  `exact`** — the only thing allowed to skip the question. Legacy records carry no date and can never
  be exact: the worst case is being asked once more, which beats mis-filing.
- A familiar subject on a **different** shoot is `action: 'suggest'` — a one-click yes/no card naming
  the shoot the project came from.

**And the model never gets that choice — measured.** Handed a `likely` recall from an earlier shoot,
*with a note spelling out* "this may be a new job that happens to look the same; if you cannot tell,
ask_user, do not assume", real qwen3:8b called `place_in_project` into the old project **4 runs out of
4**. It never once asked. The prompt asked; the model placed. So the code decides.

Where the model IS in charge it is fine — 3/3 it asks when nothing in the tree matches, 3/3 it files
correctly when an obvious project exists. It is good at *"does a matching project exist?"* and bad at
*"is this the same job as last time?"*. Keep those separate.

### ⚠⚠ THE DELETE GATE — it had a FAIL-OPEN. Read this before touching `verifyCopyPair`.

Deleting from the card is the one irreversible act in the app, and Jake's hardest rule
(*"THIS SHOULD NEVER BE AUTOMATED"*). The gate re-verifies in the main process and fails closed. It
had **one way to fail open, and it did not merely allow a bad delete — it performed one:**

**`dest === source`.** Stat the same file twice: same size. Hash it twice: same hash. *"Verified."*
Then unlink it. The handler returned `{ ok: true, method: 'deleted' }` **while destroying the only
copy of the footage.** Now refused three ways, because a string compare is not enough:

1. `pathsEqual(src, dst)` — catches case/separator variants (`E:\DCIM\X.MP4` vs `e:/dcim/x.mp4`).
2. **same inode + device** — catches a hardlink, a symlink, a junction, a `subst`ed drive, a `\\?\`
   prefix. Genuinely different path strings, one file. The stats are already in hand; it costs nothing.
3. **same removable volume** — `uniqueDest()` never overwrites, so pointing the intake folder at the
   card produces a real, byte-identical second file that passes identity, size AND hash. The gate
   would delete the original, report success, and leave him one copy: on the card he is about to wipe.
   Checked BEFORE the hash — no point reading a gigabyte off a card to then reject it on volume
   grounds. Only fires when the source really is removable, so internal-disk copies are untouched.

### ⚠ …and the hash behind it was a 1 GB allocation per file

`sampledFingerprint(…, { full: true })` was `readAt(0, size)` — i.e. `Buffer.alloc(size)`, **the whole
file in one buffer.** Measured on a 900 MB clip: RSS **43 MB → 987 MB**. And `verifyCopyPair` hashes
the source and the copy **in parallel**, so **~1.9 GB of RAM per clip** — on every copy and every
delete, on the same 16 GB machine that is holding a 5 GB model in VRAM. GoPro chapters run to 4 GB,
which is at `Buffer`'s ceiling and would simply throw.

Now streamed in 2 MB chunks: **+18 MB** instead of +944 MB, and the digest is **byte-identical**
(verified against the old implementation), so nothing that already stored a fingerprint changes.
`fh.read()` is also not obliged to fill its buffer in one call — a short read there would silently
hash *less of the file than it claims to*, which on a verify-before-delete is the difference between
checking the footage and pretending to. It now loops until the chunk is full.

### ⚠ HIS ARCHIVE IS NOT A CLEAN TEACHER — learnFromLibrary poisons itself

Read what it actually produced from his real 310 clips (not a fixture — the real filenames):

1. **`delete` became a learned SUBJECT.** He writes `_delete_` to mean "this clip is junk" — 6 clips,
   which sails past the "seen at least twice" filter and lands **in the enum**. The model could then
   legitimately name a clip `delete`. It is a workflow marker, not a thing he films. → `MARKER_SUBJECTS`.

2. **The OLD AI's own garbage was being taught back as HIS style.** `still-black-squares-grid-static`,
   `still-liam-sitting-computer-cluttered-room`, `wide-establishing-panning-car-houses` — **49 of his
   272 named clips (18%)** carry descriptions the previous naming pass wrote. Mining filenames cannot
   tell his names from the AI's, so the new model was being handed the old model's mistakes as
   exemplary. **That is the self-confirmation loop again, wearing a different hat.** `set_clip_name` is
   explicitly forbidden from using camera words, so those examples don't merely fail to teach — they
   *contradict the instruction*, in the one place the model trusts most. → `CAMERA_WORDS`.

The camera-word filter is **hyphen-boundary aware**, not a substring match: his own compound word
`josiah-topbunk-updownshot` must survive, and a naive `includes('shot')` would bin some of the best
examples in the archive.

### ⚠ NONE OF THE AI WORK RUNS ON HIS MACHINE UNTIL THE HEALTH CARD IS CLICKED

His real config, read off disk 2026-07-13: `model: llava-llama3` (hallucinates), `textModel: ''`,
`styleExamples: 0`, **no subjects**, `projectsRoot: ''`.

`aiNameWithTools` returns `null` when `subjectsCache` is empty — so **out of the box, on his actual
machine, the entire tool-naming path is DISABLED** and analyze silently falls back to the old
giant-prompt behaviour he called gimmicky. The health card is the only thing that arms it.
`test/ai-bootstrap-e2e.test.mjs` starts from his exact config, applies one fix per problem, and asserts
the app ends up *genuinely working* — subjects in the enum, few-shot pairs clean, tool model resolved —
not merely "no problems reported". **Keep that test honest; it is the one that decides whether any of
this reaches him.**

### He has almost no Projects tree (2026-07-13)

`L:\Videos\02 - Projects` contains only `Compression`. His actual project-ish folders are `L:\liam`
(Josiah, Karis, Mariah grad video, Random Files) — flat, and thin. All 310 named clips sit unorganized
in `02 - Compressed`. So *"get AI to work out which project each video belongs in — this part I know
sucks"* is partly not an AI problem at all: **there is almost nothing to file into.** Placement will
mostly want to CREATE projects. Do not invent an organizational scheme for him — that is his call.

### Hardware constraint (the owner's machine)

`qwen3:8b` (tools), `llama3.2-vision` (tools+vision, **but returns HTTP 500 on this machine — broken**),
`qwen2.5vl:7b` (vision), `llava-llama3` (vision). **One GPU — it cannot hold a vision model and an 8B
text model at the same time** (verified: loading qwen3 during a vision run = `cudaMalloc failed: out
of memory`). Any design that needs both must swap them deliberately rather than assume both fit.

### ⚠ MEASURED ON HIS REAL FOOTAGE — read this before touching the AI

Everything below came from running the real models on his real clips, with his real filenames as
ground truth. It contradicts several things that "looked fine" in code review.

**1. `llava-llama3` — his configured vision model — HALLUCINATES badly.** On the same contact sheets,
side by side:

| ground truth | `llava-llama3` (configured) | `qwen2.5vl:7b` |
|---|---|---|
| man at desk, "COME AND SEE" on monitor, bunk beds | *"a sign that reads **Cabinets for Sale**"* | *"desk, monitor displaying **COME AND SEE**, headphones, **bunk beds**"* |
| truck doors open, trailer hitch, farm | *"a person riding a **motorcycle** on a road"* | *"white **pickup truck**, doors open… **farm**, barns"* |

It invents whole objects. **A large part of "the AI is gimmicky" is simply that the app is running the
worst vision model installed.** Prefer `qwen2.5vl:7b`. Do not trust `llava-*` for grounding.

**2. His subjects are KINDS OF SHOOT, not objects.** Real distribution across 310 clips: `vlog` 129,
`lawn-mowing` 68, `pov` 26, `calisthenics` 17, **`lawnmowing` 15**, `timelapse` 13. A vision model
describes *objects*, so the namer invented `car-door`, `computertime`, `skateboarding`, `table-setup`
as subjects. Note `lawn-mowing` **and** `lawnmowing`: **his archive is already permanently fragmented
by a near-duplicate subject**, and nothing in the app prevented it.

The fix is not a better prompt — it is a schema-level **`enum`** of his real subjects (Ollama enforces
enums in tool schemas), plus `propose_new_subject`, which REFUSES anything that is merely a rewording
of an existing subject. With the enum on, invented subjects went to **zero** and `vlog`/`pov` matched
his own labels exactly.

**3. His descriptions are 1–7 words.** Given a rich observation the model wrote 20+
(`a-young-boy-moving-through-his-cluttered-bedroom-standing-near-the-bed-…`), which is an unusable
filename. Capped in code (`aiCapWords`), not in a prompt.

**4. A model will always rather ACT than admit ignorance.** Given a clip it could not identify, the
real qwen3:8b invented a project called "Client - Grey Object" and justified it confidently. It only
asked once the loop REFUSED, in code, to let it create a project it had never searched for. Hence
`requires` / `requiresAny` in `defineTool`. **Structure beats instruction.**

**5. A too-literal search tool makes the model look stupid.** Footage described as *"two people
SKINNING up a snowy ridge, ALPINE"* scored ZERO against a project called "Alps 2026" (subjects:
skiing, ski touring) because the matcher was exact — so the model created "Alpine Skinning Ridge". The
model was not wrong; the TOOL was, and a model can only be as good as what the tool tells it.
`aiTokenMatch` now matches on a 3-char shared prefix (`alp`, `ski`) — the number is measured against
the words that actually failed.

**6. VERIFY YOUR OWN HARNESS FIRST.** The first real-footage run produced garbage, and it looked like
the vision model was useless. It wasn't: my `ffmpeg select` filter had silently dropped 2 of 3 frames
and `tile=3x1` padded the sheet with **black** — the model said "the photo is black and white" because
it *was*. The app's own `getContactSheet` seeks each frame individually (`-ss` at
`duration*(i+0.5)/N`) and then tiles; do that. I was one step from writing off a working model on the
basis of a broken test.

**7. His config is the worst case, and it is real.** `ai.textModel: ''` (so every text task ran on the
vision model), `ai.model: llava-llama3` (the hallucinating one), `projectsRoot: ''` (there is **no
project tree at all** — which is why "organize sucks": there is nowhere to file to and the app never
said so), `projectLedger: 0`, `styleExamples: 0`. The 310 clips sit flat in `02 - Compressed`.

## 8. Lessons & breakthroughs (append here)

A running log of non-obvious things we learned the hard way, so nobody (human or AI) has to
re-derive them. **Append new entries at the top; never delete.** Format: `### YYYY-MM-DD —
title`, then what we learned and why it matters.

### 2026-07-12 — The card→intake copy was the ONE copy path with no staging, no fsync, no verify

This codebase has two well-built verify-before-destroy primitives (`copyFileVerified`,
`moveFileCrossDevice`: temp → flush → full fingerprint → atomic rename). The single path that
touches **the only copy of the footage** — `copyFileWithProgress`, card → intake — used neither, and
it could corrupt the archive three ways at once:

1. It wrote **straight to the final path**, so a partial copy wore the real filename.
2. Cancelling called `rs.destroy()`, which emits neither `'end'` nor `'error'` — so `pipe()` never
   called `ws.end()`, `'finish'` never fired, and **the promise never settled**. `copy:start`'s
   `await` hung forever, which made its own `if (aborted) unlink(destPath)` cleanup *unreachable dead
   code*: the truncated clip stayed in intake under its final name, `copyTask.active` stayed true (so
   every later copy was refused with "A copy is already running"), and the renderer's
   `copyInProgress` latch stuck true for the session. `token.aborted`, checked in two guards, was
   never assigned anywhere either.
3. It **verified nothing**. Tdarr would then compress the truncated clip and file it into Projects —
   while the delete gate, which compares card↔intake, happily cleared the card.

Now: stage to `<dest>.part` → `datasync` → full-file fingerprint against the card → rename. A file at
`dest` is therefore *always* a complete, verified copy. `compress:run` had the same shape (ffmpeg
wrote directly to the final `.mp4`, and `skipExisting` — default ON — then trusted any leftover
partial as finished); it now stages into `.partial/`, which `listVideosShallow` cannot see because it
lists **files** at the top level only.

**The lesson: a destructive/irreplaceable operation must not have its own bespoke copy path.** If
you're writing bytes that matter, go through the primitive — and if the primitive doesn't fit
(progress reporting, here), fix the primitive rather than hand-rolling around it. `pipe()` + `destroy()`
is a hang waiting to happen; use `stream/promises`' `pipeline()`, which turns a destroy into a
rejection.

### 2026-07-12 — Batch rename quietly destroyed data on the most ordinary path there is

"Select all → type a subject → Apply to N" is *the* flow. Three separate bugs on it:

- **The batch date was applied without the user ever typing it.** Merely *ticking* clips auto-filled
  it from the FIRST selected clip, and `copyDateMode` defaults to `'always'` so it applied without
  asking — overwriting every clip's real capture date and setting `dateLocked`, which permanently
  blocks ffprobe from correcting it. Two shoots on one card → the older day got stamped with the
  newer day's date. It now only auto-fills when the whole selection *already shares* one date.
- **The row `⤓` copied unconditionally**, so propagating a subject from a row with an empty
  description wiped the description and every custom organize field on all the ticked clips —
  values the user couldn't even see (`cleanGrid` hides the meta row). `applyBatch` was explicitly
  guarded against this; the row path just wasn't.
- **Select-all ignored the active filter.** Filter to "Unnamed", select all, Apply → every *named*
  clip, hidden from view and already finished, was overwritten too. There is now ONE
  `clipMatchesFilter()` predicate, so what you can SEE and what a bulk action TOUCHES cannot disagree.

Also: **a partial undo is worse than no undo.** `applyVersionToClips` restored only half of what
`buildDraftMap` snapshots — people, tags, `facesScanned` and `ledgerRel` were all *in* the snapshot
and simply never read back, so "Restore" from the automatic "Before AI analyze" point could not undo
what the AI had done.

### 2026-07-12 — The "hundreds of little things": work lost, failures you couldn't see, dead ends

Patterns worth recognising, because each produced several separate bugs:

- **An allowlist guard cannot protect fields it doesn't know about.** `mergeDraft`'s never-blank
  guard named its protected fields explicitly, so `facesScanned`, `ledgerRel` and — by
  construction, forever — the user's CUSTOM organize fields fell straight through
  `{...prev, ...incoming}` and could be blanked by a stale write. It is now a **denylist**: every
  saved field is protected, and only `selected` (a UI tick, which must be clearable or you could
  never untick anything) may be cleared. A new draft field is now protected *by default* instead of
  silently unguarded.
- **Never persist an array index.** `aiQuestions` carried a `clipIndex` — a position in
  `state.scannedFiles`. Persisting that would re-attach "is this a new category?" to a different
  clip after a rescan. Everything durable in this app is keyed by `clipKey()` (`name__size`), which
  survives a replug, a new drive letter and a restart. Follow that without exception.
- **A count is not a diagnosis.** A failed AI clip was a counter plus a line in an in-memory log
  (capped at 400, gone on restart, buried under Help → Activity log). With 100 clips you couldn't
  see WHICH failed, WHY, or retry just those. The clip now carries `_aiFailed`/`_aiError`, the card
  shows it, and "Retry failed" re-runs exactly those — restoring the previous selection in a
  `finally`, because silently changing what's ticked is how a helpful retry loses someone's work.
- **Silence is a bug.** Step pills that refused to open did nothing and said nothing. A yanked card
  produced sixty separate "Took too long — skipped this clip" errors — a confidently wrong
  diagnosis of a different problem. `cardIsGone()` now asks on demand (auto-poll is OFF by default,
  so the `drive:removed` event alone would never fire for most users) and reports once.
- **An undo nobody can find is not an undo.** `projects:move` had always recorded everything needed
  to reverse a run, and `undoLastOrganize()` had always worked — it was just in a menu. It is now
  offered on the toast, at the moment you'd want it.

### 2026-07-12 — Organize ran TWO filing systems, and the one the user could see lost

Step 2 IS the destination map (rendered inline into `#finMapHost`) — you plan a whole tree and its
Apply files into the Projects root. But the step-3 **Run** button called `finalize:run`, which
ignored the map completely and filed by `[category, project]` into the *Compressed* folder. Those
two fields are normally **empty** (the rename grid hides them by default; the AI only sets a
category that already exists), so `subdirParts()` returned `[]`, `organizeMove()` found the file
already sitting in the destination, and Run reported **"N skipped, 0 moved"**. You planned
everything, pressed Run, and it did nothing while looking like it had worked. Step 2 also had **no
visible way forward** — `finNext2Btn` was `class="hidden"` and nothing un-hid it, so reaching Run
meant guessing the step-3 pill was clickable.

There is now ONE plan: the map publishes it (`currentDestPlan()`), Run executes it, and a clip with
no place on the map is **left alone and reported** rather than dumped in the root of the Projects
tree (which is what a naive `rel: ''` fallback would have done — see `organize-plan.test.mjs`).

Two related shapes worth internalising:
- **A flag that duplicates a fact will drift from it.** `state.phoneBackup` was set false by
  `goHome()` while the phone's clips were still loaded, so re-entry ran the CARD copy path on phone
  files — bypassing the "Send to Uncompressed" gate. It's now `isPhoneFlow()`, derived from
  `state.scannedDrive`, which cannot disagree with what's loaded.
- **In-memory state that gates a destructive step is a bug.** `state.copied` gated the Delete step
  and died with the window, so clearing a card in a LATER session (the actual workflow) was
  impossible without re-copying the whole card. It's now the durable `copiedLog` store, keyed by the
  stable `name__size` fingerprint, rebuilt from the intersection of *what's on this card now* and
  *what we logged* — which is also what stops one card's clips ever appearing in another's delete
  list. It is a convenience for rebuilding the list, never an authority: `delete:source` still
  re-hashes and refuses whatever it can't prove.

### 2026-07-12 — The app REMEMBERED the analysis, then refused to use it

"It forgets where it was" turned out to be the opposite problem. `clip-observations.json` is
written correctly, per clip, immediately, keyed by the stable `name__size` fingerprint (so it
even survives a replug and a new drive letter). The data was always there. Three things then
threw it away:

1. **Mode `empty` ("Only name blank clips") ran the full vision pass on EVERY selected clip**
   and discarded the answer inside `applyAiResult`, which gates subject/description/category on
   being blank. Cancel at clip 40 of 100, hit Analyze again → all 100 re-watched. There was no
   notion of "already analyzed" anywhere. `aiAlreadyAnalyzed()` (04-tasks-ai.js) is now that
   notion: a cached observation **and** a subject+description ⇒ nothing left to do ⇒ skip.
2. **The "Reuse earlier analysis of N clips (faster)" checkbox was a lie in the default config.**
   `dlg.reuse` was read in exactly one place — inside `if (aiCfg.multiPass)` — and `multiPass`
   defaults to **false**. A default install ticked the box and got nothing.
3. **Face clusters were keyed by absolute path** (`clip.key || clip.sourcePath`, and scanned
   clips have no `.key` — main-mod/02-media.js never emits one) while every other store uses
   `clipKey()`. Card replugs as `F:` instead of `E:` → the review still showed the faces, but
   confirming them tagged **zero** clips, silently.

Lesson: when a user says "it forgets", check whether it persisted and failed to *read back*
before assuming it failed to *write*. Also — a defaulted-off config flag (`multiPass`,
`updateSubject`) silently disabling a control the UI still renders is a recurring trap here.
"Start over" had the same shape: it could never change a subject because `updateSubject`
defaults false and batch-rename fills every subject first.

### 2026-07-12 — The delete gate lived in the renderer, so a renderer bug could disarm it

`delete:source` used to accept a bare array of paths and unlink whatever it was handed; the
entire "only delete what's provably copied" check lived up in `09-phone-finalize.js`. The one
irreversible operation in the app was therefore protected by a guard that any renderer bug could
silently remove — in a codebase whose whole problem is renderer bugs. It now takes
`{source, dest}` pairs, **re-hashes every file in main immediately before the unlink**, and
refuses anything it can't prove (a bare path is refused outright — it carries no proof a copy
exists). `test/delete-gate.test.mjs` asserts the footage survives a *lying renderer*.

Related: `state.copied` (which gates the Delete step) was only cleared in `startFlow`'s
fresh-scan branch, so importing a card and then backing up a phone left the **card's** clips in
it — the Delete pill inside the phone flow listed them. Put the safety check next to the
dangerous operation, not next to the button.

### 2026-07-10 — Startup cost: defer the 1.3 MB face library and the heavy sidecar stores
- `index.html` loaded **`face-api.min.js` (1.3 MB, bundles TensorFlow.js) as a blocking
  `<script>` ahead of `renderer.js`** — every launch read, parsed and executed it, including
  the many sessions that never open face recognition. It is now injected on first use by
  `loadFaceApiLib()` in `src/mod/08-people.js`. That works because **`ensureFaceModels()` is
  the single chokepoint** all eight face call sites go through, and all are already `async`.
- `loadStores()` synchronously `JSON.parse`d **all seven sidecars at module load, before the
  window existed** — including `people.json`, where the base64 face thumbnails are ~70% of the
  bytes and which **grows without bound** as people are tagged (40 people × 15 faces ≈ 5 MB).
  Startup got permanently slower the more the app was used.
- `ai.people` / `ai.clipObs` / `ai.facesPending` are now in `LAZY_STORES` and load on first
  access via `ensureStore()`. Boot store-loading went ~27 ms → ~7.8 ms on a 5 MB face DB, and
  **no longer scales with the DB at all**.
- **The invariant that makes deferral safe:** every read AND write of a lazy store goes through
  an accessor (`aiPeople()`, `clipObsStore()`, `aiFacesPending()`) that calls `ensureStore()`
  first. Otherwise a caller could mutate the in-memory value and *then* have the sidecar read
  on top of it. `saveStore()` additionally **refuses to write a lazy store that was never
  loaded** — nothing can have mutated it, so a write could only stamp an empty default over
  real data. If you add a new lazy store, add its accessor in the same commit.
- `migrateStores()` must `ensureStore()` before `saveStore()`, or a legacy value still living
  inside `config.json` would never be re-homed to its sidecar.
- Verified against the real app: with a *corrupt* `people.json`, a second launch boots cleanly
  and **never even complains** — proof nothing on the launch path reads it — and the corrupt
  bytes are left intact for recovery.

### 2026-07-09 — The main process IS testable: load the bundle in a `vm` with a fake `electron`
- `main.js` is one concatenated script with no `exports`, so nothing could be `require`d by a
  test. That is *why* there were zero tests for 78 commits — not laziness, an actual wall.
- The way through: `new vm.Script(mainJsSource).runInContext(ctx)` where `ctx.require` returns
  an **electron stub**. Two properties make it work:
  - top-level `const`/`let` land in the context's *global lexical environment*, which persists
    across later `vm.runInContext()` calls — so every internal helper is readable by name;
  - `ipcMain.handle(...)` runs at load, so a **recording stub captures all 157 channels** and
    tests can invoke real IPC handlers with no Electron and no window.
- `app.whenReady()` returns a **never-resolving promise** in the stub — that is what keeps
  `createWindow()`/`createTray()` from firing. `ROAMING_DIR` reads `process.env.APPDATA`, so
  pointing that at a temp dir gives each test an isolated config + sidecar directory.
- Gotcha: values built *inside* the vm have a different `Array`/`Object` prototype, so
  `assert.deepStrictEqual` fails a prototype check even when the structure matches. Use the
  harness's `m.plain(v)` / `m.getJSON(name)` to re-materialize them in the host realm first.
- See `test/harness.mjs`. Run with `npm test`; `npm run check` now includes it.

### 2026-07-09 — Splitting the stores out of config.json quietly removed their data-safety guard
- `config.json` has always been protected by `config_readFailed`: if the file exists but won't
  parse, **every writer refuses to save**, so a transient read glitch can't replace real data
  with defaults. That guard was never extended to the sidecar stores created in 0.4.20/0.4.26.
- `readJsonRetry()` returns `null` for BOTH "file absent" and "file corrupt". Absent is
  legitimate (first run), so `loadStores()` treated a **truncated `people.json` as a fresh
  install**, defaulted it to `[]`, and the next `saveStore()` wrote that `[]` over the user's
  entire face database. Same for `drafts.json` → every saved rename. Verified end-to-end
  against the real app, not just a unit test.
- Fixed with a per-store `storeReadFailed` latch (mirrors `config_readFailed`): the session
  runs on defaults so the app still works, but `saveStore()` refuses to write. `freshStore()`
  clears the latch if the user repairs the file. Regression tests in `test/stores.test.mjs`.
- **The lesson is the shape, not the bug:** a *performance* refactor silently moved data out
  from behind a *correctness* guard. When you relocate data, ask what invariant protected it
  where it used to live.

### 2026-07-09 — Two functions that "find the JSON in noisy text" were both wrong, differently
- `parsePsJson` (PowerShell stdout) scanned for the first `[`/`{` and parsed to end-of-string.
  A stray line containing a brace (`C:\{guid}`, a `[notice]` tag) made the slice start
  mid-banner, `JSON.parse` threw, and the real trailing JSON was dropped → **"no phone
  attached", silently**, with no error surfaced anywhere.
- `parseJsonLoose` (LLM replies) used a greedy `/\{[\s\S]*\}/`, i.e. first `{` to the **last**
  `}`. A trailing aside ending in a brace ("that's it :}") or a second JSON object swallowed
  the real value → the whole AI suggestion came back empty. It could also return `null`/a
  scalar, which every caller then property-accessed into a TypeError.
- Both now delegate to one primitive, `scanBalancedJson()` in `main-mod/01-core.js`: walk the
  text, and from each candidate opener scan with a depth counter that **skips string literals
  and their escapes**. The first balanced span that actually parses wins. This is the DEDUP.md
  rule in action — one primitive owns the decision, so a fix lands in both places at once.

### 2026-07-09 — `verify:copies` is a DELETE GATE, so it must hash the whole file
- The intake copy (`copyFileWithProgress`) performs **no verification at all**, which makes
  `verify:copies` the only integrity check in the card-import → verify → clear-card flow.
- It was using the *sampled* fingerprint (head/mid/tail, ~6 MB of a 4 GB clip), while its two
  sibling delete gates — `copyFileVerified` and `moveFileCrossDevice` — both pass `{full:true}`
  precisely because a sampled hash cannot see a mid-file bit-flip that preserves length.
  A corrupt copy therefore reported "verified", and the user was invited to erase the card.
- Now full-hashes both sides. The cost is a full read of each file, but this step is
  explicitly user-initiated and already renders a "Verifying copies…" state — that is the
  right place to pay it. If it ever gets too slow, hash the source *while copying* (the bytes
  are already streaming through memory) rather than going back to sampling.
- Rule of thumb: **whatever a check authorizes you to destroy, it must actually check.**

### 2026-06-28 — winCodeSign symlink error: disable signing, don't fight it
- The build fails at `winCodeSign` extraction with **"Cannot create symbolic link : A required
  privilege is not held by the client"** (darwin `*.dylib` symlinks) unless the user has the
  symlink-create privilege (Developer Mode / elevation). On a UAC-filtered admin account that
  privilege isn't held, and pre-extracting the cache doesn't help (electron-builder re-downloads
  winCodeSign to a *random* temp name each run).
- **Fix without admin:** we don't code-sign, so skip the step that needs winCodeSign —
  `signAndEditExecutable: false` (package.json `build.win`) **+** `CSC_IDENTITY_AUTO_DISCOVERY=false`
  (release.mjs sets it). Verified: a clean 129 MB installer + blockmap + latest.yml, zero errors.
  Tradeoff: the bundled exe's embedded version/icon isn't rcedit-stamped (the NSIS installer +
  app icon are unaffected). If we ever code-sign (issue #5), enable Developer Mode instead.
- The whole Windows build can be driven from WSL via `cmd.exe`/`powershell.exe` interop on a
  Windows-path checkout (`C:\Users\...`), with Windows `node`/`npm`/`git` — no human on Windows.

### 2026-06-28 — Releases live on GitHub; Gitea can't host the installer
- **Code, issues, PRs, wiki stay on Gitea. The installer + auto-update feed live on GitHub
  releases** (`Virus7976/usb-video-manager`). Why: this Gitea server **cannot** host the
  ~130 MB installer — three independent server-side limits, none fixable via API or from the
  build machine: (1) release-asset `allowed_types` has no `.exe`/`.yml`/`.blockmap`;
  (2) `[attachment] MAX_SIZE` is **100 MB**; (3) the **reverse proxy 413s** bodies > ~100 MB
  (confirmed: a 130 MB PUT to the generic package registry also 413'd). That's why `v0.1.0`
  had zero assets and no release ever shipped (Gitea issue #6).
- **GitHub makes it simpler, not harder:** native electron-updater `github` provider + a real
  "latest release", so no fixed-tag hack. `build.publish` in `package.json` is the github
  provider with `releaseType: "release"`; `release.mjs` builds with `electron-builder --win
  --publish always` (GitHub does the upload) and mirrors the code commit+tag to GitHub first
  (so the release attaches to a real commit). Two tokens: Gitea push via the git credential
  helper; GitHub via `GH_TOKEN`/`~/.github-token`.
- **Build still must be native Windows** (no wine) — but it can be driven from WSL via
  `powershell.exe`/Windows-`node` interop, so a release needs no human on Windows.

### 2026-06-28 — Gitea is behind Cloudflare: use a browser User-Agent for API writes
- POSTs to the Gitea API (create issue/PR/release) **403 with `error code: 1010`** when the
  request has a bot-ish `User-Agent` — that's **Cloudflare**, not a Gitea token-scope problem.
  `curl`'s default UA passes; `python-urllib` and Node's default `undici` UA get blocked. Fix:
  send a normal browser `User-Agent` header (see `scripts/release.mjs` → `gitea()`). A token
  that 403s on writes is very likely fine — check the UA before suspecting the scope.

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

