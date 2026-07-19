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
  **The cache must NOT store the `null` sentinel** (see §8 latch note): `null` means "couldn't tell"
  (a `/api/show` that threw / came back non-ok), and caching it latched a transient boot-time blip
  into a permanent false "No reasoning model" for the whole session.
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
- ~~**Grow `styleExamples` from every user correction.**~~ **DONE** — see the section below.
- ~~Delete the dead `ai:batchQuestions` / `ai:parseRoute` handlers.~~ **DONE.** Both are gone, with
  their preload surface. `ai:parseRules` supersedes `parseRoute`; the per-subject loop in the renderer
  supersedes `batchQuestions` (the questions worth asking are the ones the DATA raises, not the ones a
  7B model can think of). `DESCRIPTOR_WORDS` sat between them and is still live — don't take it too.

**⚠ OPEN — the owner's latest asks (2026-07-13), in his words:**

1. ~~"recognize multiple people per frame … use that in the descriptions"~~ **DONE** (both halves —
   see the group-shot section below; naming now emits `josiah-liam-repairing-mower`, 4 runs of 4).
2. ~~"if there are more than one unconfirmed it should have a thumbnail with that section of the video
   and I should be able to click each face and name them"~~ **DONE** — see below, verified in the
   running app on a real 6-face clip.
3. **"It should also be writing a lot of what it finds into metadata" — NOT STARTED.** This is the
   next job. The AI already derives far more than gets written: `observation` (the full vision
   description), `tags`, `shotType`, `people`, `subject`, `description`, `category`, `location`, plus
   the shoot/placement decisions. Find out what Finalize actually embeds today (XMP `PersonInImage` +
   keywords is all the code comments claim) and widen it. **Check before assuming:** read the
   exiftool write path in `main-mod/08-finalize-feedback.js` and see which of those fields reach the
   file. Do NOT write metadata into the ARCHIVE originals without asking him — organize COPIES is the
   established rule (see [[usb-app-filing-back]]).

### ⚠ THE "No reasoning model" WARNING THAT WOULDN'T CLEAR — a null-cache latch (2026-07-17)

His config was correct all along: `ai.textModel = 'qwen3:8b'`, which real Ollama (0.32.1) reports as
`capabilities: ['completion','tools','thinking']`. Yet the home screen showed the red **"No reasoning
model · Get qwen3:8b"** card, and — because naming falls back to the vision model when no tool model is
found — his 331 already-named drafts came out with generic `subject: "misc"`. The warning was
**degrading every name**, not just nagging.

Root cause: `ollamaCapabilities()` memoized whatever it computed, **including the `null` it returns
when it couldn't tell** (a `/api/show` that threw or came back non-ok). `renderAiHealth()` runs at app
boot — the one moment Ollama is most likely still warming — so a single transient failure there cached
qwen3:8b as "unknown" for the whole session. `ollamaModelTools()` treats unknown as `false` (never
guess a model into tool mode), so `aiToolModel()` returned `''` forever after. Fix: **never cache the
`null` sentinel** (`if (caps) _capCache.set(...)`) so a transient blip re-probes next time.

Verified against his REAL Windows Ollama from WSL via the curl.exe winFetch shim (§ HOW TO MEASURE):
`ai:health` → `toolModel: "qwen3:8b"`, zero problems; and the real `ai:nameFromObservation` path on a
real observation ("liam is gaming in his room") → tool call `set_clip_name{subject:"gaming"}`, not
`misc`. Regression test: `test/ai-toolmodel-latch.test.mjs` (a boot-time show failure must not latch).
Reminder: phone detection also works read-only from WSL — the `PS_PHONE_LIST` COM enum saw his real
"Liam's S23 Ultra" over MTP; the copy/organize/**clear** stages still need the Windows app + `L:` drive.

### ⚠ REBUILDING THE INSTALLER FROM WSL — two gotchas that stopped a clean build (2026-07-17)

Built `USB-SD-Auto-Action-Setup-0.4.28.exe` from WSL with the reasoning-model fix. What bit:

1. **A stray root-level `"directories": {doc,test}` in `package.json` is FATAL to electron-builder 25.**
   It reads npm's own `directories` field as its deprecated config and hard-errors
   (`"directories" in the root is deprecated`) before packaging. Removed it from source — it was
   unused npm metadata. If a build dies immediately after "loaded configuration", check for this.
2. **The Windows build checkout predates the `main-mod/` split.** The only Windows-path checkout with
   Windows-native `node_modules` (electron + electron-builder installed, electron/nsis/winCodeSign
   cached) is `C:\Users\jakeg\Downloads\skool-downloader-chrome\usb-auto-action` — an OLD monolithic-
   `main.js` tree with **no `main-mod/`, no `scripts/`**. So `npm run build:win` fails at
   `prebuild:win` (`node scripts/bundle.mjs` missing). Instead: **bundle in WSL, copy the already-built
   `main.js`/`src/renderer.js` + source over, and run `npx electron-builder --win --publish never`
   DIRECTLY** (skips the prebuild hook). `main-mod` isn't in `build.files`, so the installer never
   needed it. That checkout's `package.json` also lagged 3 runtime deps (`electron-updater`,
   `multicast-dns`, `qrcode`) — `npm install` them (pure-JS, ~3s) or the packaged app crashes on
   `require`. Signing is skipped (`CSC_IDENTITY_AUTO_DISCOVERY=false`, see winCodeSign note above).
   Verified the fix bytes land in `dist/win-unpacked/resources/app.asar` and all deps are packaged.

### ⚠ FACE REVIEW — clicking a face on the GROUP SHOT looked like it did nothing (2026-07-17)

Owner, mid-session on a real family group photo: *"There is no way to click these right now and rename
them from here."* The `.fsc-box` face buttons ARE wired (`src/mod/08-people.js` `wireScenes`): a click
sets `s._sel` and re-renders, opening the naming card as `.fsc-pick` **below the photo**. But on a tall
PORTRAIT group shot the photo fills the `.face-grid-scroll` viewport, so the card that opens lands
below the fold — the click worked, the result was just off-screen, so it read as dead. Fix: after a
face is selected, `requestAnimationFrame(() => scroll.querySelector('.fsc-pick').scrollIntoView(...))`
so the naming card is brought into view the instant it opens. (Deliberately did NOT cap `.fsc-photo`
height — the boxes are `%`-positioned against it, so any letterboxing would misalign the name tags onto
the wrong faces. scrollIntoView carries zero alignment risk.) Workaround without a rebuild: click a
face and scroll the review panel down to the card.

### ⚠ TWO UI REGRESSIONS FROM THE WSL FOLDER-DEPLOY, + a Resolve CSV win (2026-07-17)

While shipping the reasoning-model fix as a `resources/app` FOLDER (electron-builder is blocked by the
winCodeSign symlink-privilege issue — see below), partial file copies dropped things the build needed.
Root lesson: **when deploying by hand-copying source, the renderer, index.html, styles.css AND
`src/assets/` all move together, or the UI silently half-renders.**
- **index.html was stale** → its newer element IDs (`pendingWork`, `aiHealth`, `autoModeChk`) were
  missing, so `renderPendingWork()`/`renderAiHealth()` hit `if (!host) return` and every home card
  (pending work, AI health, auto-mode) vanished while Devices/Actions still showed.
- **`src/assets/app-icon.png` was never copied** (added to source 2026-07-06) → the window/taskbar icon
  (`nativeImage.createFromPath(__dirname/src/assets/app-icon.png)`, `main-mod/01-core.js` +
  `04-routes-ledger.js`) fell back to the default Electron atom. `build.files` does NOT include
  `build/` and signing is off, so there is no rcedit-stamped exe icon — the app RELIES on that PNG.
- **Pull screen bug (real, pre-existing):** during a phone pull the `#phCopyBtn` "Pull N off phone &
  rename" button was never hidden (only `phChooser` is), so it sat under the 62% progress bar looking
  broken. Fixed: hide it in `phoneCopy()`, restore it in `phoneEnterChooser()`.
- **Resolve CSV widened:** `finalize:run`'s `resolve-metadata.csv` only wrote File Name/Description/
  Keywords/Scene, dropping the per-clip `shotType` and `observation` the AI already derives. Added
  **Shot** and **Comments** columns (Resolve's Import Metadata maps both), so an editor can sort a bin
  by shot type and full-text-search the media pool. Test: `test/resolve-csv.test.mjs`.

### ⚠ TIER-1 FILE-SAFETY BATCH from the 100-item audit (2026-07-17, 605 tests green)

Started knocking out the audit backlog (`memory/usb-app-audit-backlog-2026-07.md`) top-down:
- **Map "Apply" honored copy mode.** `projects:move` ALWAYS moved → deleting the L: archive source,
  leaving C: as the only copy (violated "organize copies, never moves"). Now takes `copy` (default
  copy = safe), threaded from `finKeepSource`; copies are recorded undoable. `main-mod/02-media.js:470`,
  `src/mod/07-organize-map.js`. Test `test/projects-move-copy`.
- **`copyFileVerified` is now atomic.** Removed the dead shadow def; the live one routes through
  `stageVerifiedCopy` (.part → full verify → rename) so a crash mid-copy never leaves a truncated file
  under the real name in NAS/archive/backup. Test `test/copyverified-collision`. NOTE: did NOT add
  collision-versioning — a differing dest is a truncated prior copy that must be REPAIRED (the resume
  case, pinned by `copy-verify.test`); content can't tell that from a cross-clip name collision, so the
  real fix for #2 is unique final names (the clipKey backlog item), not clobber-avoidance here.
- **Truncated file declined by the staging gate is now UNLINKED**, not left on disk for resume to
  re-trust. `main-mod/05-windows-phone.js`. Test extends `test/staging-integrity`.
- **Compress got an idle hang-watchdog** (10-min silence → treeKill), the one ffmpeg call that lacked
  it → one bad-codec clip can't hang the batch. `main-mod/09-ipc-boot.js`.
- **Global crash net**: `uncaughtException`/`unhandledRejection` → `userData/crash.log`, process stays
  alive (was dying silently mid-copy). `main-mod/01-core.js`. Test `test/crash-log`.

Batch 3 (2026-07-18, 609 green): **skipMove clips no longer flat-dumped into the NAS root**
(`if (nasRoot && !skipMove)`); **Resolve CSV MERGES by File Name** across runs instead of overwriting
(`csvFirstField` helper + read-merge-write, was clobbering the batch workflow); **`xmp:Label` misuse
dropped** (it's the colour-label field; shotType stays a keyword); **`DateCreated` accepts a trailing
time** (prefix match, was writing no date at all for date+time); **photos now recover the lossless
embedded record** on a store miss (dropped the `!f.isPhoto` gate). Test `test/metadata-batch`.
NOT-yet-done, flagged in backlog: native EXIF/QuickTime capture date (#32 — needs real-exiftool verify),
re-embed skip via readEmbeddedRecord (#68), map `resolveFolderPath` (#30), `clipKey` collision (#8).

Batches 4–12 (2026-07-18): knocked the backlog from 3 → **55 of 100 done, 636 green**. Per-batch item
lists + the deliberately-NOT-done set live in `memory/usb-app-audit-backlog-2026-07.md` (batch 11 =
#63 store size+mtime latch, #90 modal aria, #51 next-unnamed visual order, #74 recomputeVersions
debounce, #65 grid-wall play-cap, #72 persistent poster cache, #99 no-upscale, #84 face-detect-error≠no-
faces, #87 declined-pull count, #43 Run-aborts-not-root-dump; batch 12 = #81 persistent app.log, #86
verify-copies progress, #88 compress ETA, #34 batch-apply save-point, #46 ignored-face clustering, #44-part
clipObs name-swap). **56 of 100 done, 638 green.** ⚠ **ALL of batches 1–12 are STILL HELD FROM DEPLOY** — Jake
asked me not to rebuild while he was scanning. When he's clear: copy the bundles + `src/preview.html` in ONE
restart, then visually verify the renderer items. Hit the safe edge at 56: the rest need the running app to
verify (#45 face-review persistence, #77 scan past sessions), touch AI-matching memory (#37), or are held.
Line to draw and hold: I would NOT touch the finalize move loop (#69/#55), measured AI prompt/memory
(#80/#35), or the global `clipKey` (#8) blind — a bug there misfiles or corrupts his real footage.

**THEN built the E2E system (test/e2e/, real Playwright+Electron — renderer AND faces testable; see
`PROMPT.md` §5 + `usb-app-e2e-harness`) and used reproduce→fix→verify to land: #45 (face-review persistence,
2-launch e2e), #46-deepening (e2e caught a latent faceDecide early-return bug), #49 (face caps kept newest-N
instead of protecting confirmed enrolment faces), and #1-r e2e coverage (Select-All respects the filter).
Now: 61 of 100 done, fast suite 643 + e2e 11 green. STILL UNDEPLOYED. Next per PROMPT.md §4: #37 ledger-undo
(main-side split boundary — see backlog note), then more e2e backfill (#43/#65). #77 + the AI decide-not-
generate reshape are DEFERRED (design call / needs real-Ollama measurement) — logged in the backlog, not blind.**

### ⚠ FACE SCAN "re-scans from scratch every session" — the skip trusted an in-memory flag (2026-07-17)

Owner, angry: face scanning wasn't remembered across sessions — already-scanned clips got scanned
again. The DATA was fine (verified on disk: 1168 `facesScanned` flags in drafts, 349 pending clusters,
face-scenes.json, people.json — and the temp files' `name__size` matched the draft keys 1168/1168, zero
size drift). The bug was the SKIP: `scanFacesForClips` filtered on `clip._facesScanned` ONLY, an
in-memory flag that (a) isn't on every clip representation — `currentSelectedClips()` on the Organize
screen builds fresh `{name,sourcePath,...}` objects with no `_facesScanned` AND no `size`, so clipKey
was `name__undefined` — and (b) a restore can miss. Result: the durable truth (the draft's
`facesScanned`, keyed by `name__size`) was ignored. Fix: `scanFacesForClips` now loads drafts once and
`isScanned(c) = c._facesScanned || scannedKeys.has(clipKey(c))`; and `currentSelectedClips` carries
`size` + `_facesScanned` on the Organize-screen objects. `src/mod/08-people.js`. (Renderer-only — no
harness test; verify in the app: a re-scan should skip the already-scanned clips.)

### ⚠ "AI analysis done · Named 0 clips" was a CANCELLED run mislabelled (2026-07-17)

`aiAnalyzeSelected`'s end-of-run toast: when the run was aborted before it named anything
(`okCount===0 && failCount===0`, the naming loop broke on `aiAborted`), it fell into the success
branch → "AI analysis done · Named 0 clips", which reads as "ran and found nothing" not "you stopped
it". Added an `if (aiAborted)` branch → "Analyse cancelled…". `src/mod/04-tasks-ai.js`. (Renderer-only;
staged in repo but held from deploy — owner was mid-scan and asked not to rebuild.)

### ⚠ STANDALONE "Scan faces" action (2026-07-17)

There was NO way to run ONLY a face scan: face scanning was bundled inside `aiAnalyzeSelected` (which
also runs the vision naming) or buried two clicks deep in the People dashboard's "scan more clips".
Added `scanFacesSelected()` (`src/mod/08-people.js`) = `scanFacesForClips(currentSelectedClips())` →
straight into the face review, no naming. Wired into all menu surfaces: the custom Edit→AI menu
(People section) + the two other AI submenus + the command bar (`06-menus.js`), and the native
right-click AI context menu (`main-mod/01-core.js` `ai:scan-faces` → `preload.js` map →
`04-tasks-ai.js` onAiMenu → `scanFacesSelected`).

### ⚠ ORGANIZE/UNDO AUDIT — 2 fixed, 3 accepted (2026-07-17). Delete gate confirmed SOLID.

Audited finalize:run + organize:undo + copy-verify + the delete gate. **The delete gate is fail-closed
and correct** — do not weaken it (rejects same-card copies, dest===source, same-inode links, size
mismatch; full-hash both sides; `delete:source` re-verifies server-side). Fixed two real bugs (tests:
`test/organize-undo-copy`):
- **Finding 1 (metadata loss):** a `skipMove` clip (unplanned under a plan — sits unfiled in Compressed)
  still hit `filed.push` → `markFinalMetaDone` → its finalMeta became prune-eligible. After eviction the
  clip is filtered out (needs `it.meta`) and can NEVER be organized again. Fixed: `if (!skipMove)
  filed.push(...)` (`main-mod/09-ipc-boot.js`).
- **Finding 4 (undo of a copy):** `organize:undo` moved a COPIED clip back beside the still-present
  original → a versioned duplicate, not an undo. Fixed: undo of a copy UNLINKS the copy (guarded — if
  the original vanished, restore the copy instead) (`main-mod/02-media.js`).

Accepted / documented (lower value or by-design): **F2** non-plan clip with empty category/project
files into the Projects ROOT and reports success — but that is `subdirParts`' intended "no level → no
subfolder", and the AI/phone flow is covered by `usingPlan`+skipMove; **F3** the NAS mirror's
resume-skip uses a SAMPLED hash (a right-size/corrupt secondary backup can survive across runs — the
delete gate is unaffected, full-hashing every NAS file per run is too costly); **F5** the delete gate's
link check guards on `ino`, which is 0 on some ino-less internal volumes (edge: a junction-as-dest on a
non-removable ino-less FS; NTFS/removable are covered).

### ⚠ BIG FIX BATCH — flow gaps + face-review rework (2026-07-17, all staged, 593 tests green)

Owner asked to fix the four audited flow gaps AND a pile of face-review issues in one go. All landed
with tests where testable (main-process) and implemented-but-needs-his-eyes where not (renderer UI —
can't drive the live app while he's using it). The four OPEN items below are now DONE:

**Flow (fully tested):**
- **Photos now get embedded metadata.** `buildPhotoJobs` attaches `flowMetaOf(p)` (shared with
  `saveFlowFinalMeta`) to each copy job; `phone:distribute` embeds the AI record into each unique
  SOURCE photo ONCE via `buildEmbedTags`+`getExifTool` before copying, so every copy inherits it. A
  staging copy, never the phone original; XMP-only, so "original quality" holds. `test/photo-metadata-embed`.
- **Staging gate.** `phone:pull` stages on COMPLETENESS: a file short of its known `it.size` is
  declined (`incomplete++`), so a truncated pull never finalizes a corrupt clip. `test/staging-integrity`.
- **Real cancel.** `streamSpawn` gained an `abortCheck` poller (kills the child when it flips); the MTP
  copy passes `() => phoneAbort`. Killed mid-file → truncated → declined by the staging gate. `test/streamspawn-abort`.
- **`finalizePhotos` defaults true** so photos are first-class in the Organize screen too.

**Face review (implemented; VISUAL CHECK NEEDED after restart):**
- **Wrong thumbnail fixed.** The card showed the cluster's canonical thumb (a crop from some OTHER
  clip → looked like a stranger). Now `faceCropHTML` shows the face you actually clicked, cropped from
  THIS photo in pure CSS (background sprite, no canvas).
- **Popup on the photo.** Naming card is now `.fsc-pop-wrap` — a dim-backdrop popup centred ON the
  photo (inset:0, can't overflow/misalign), not a card below you had to scroll to. Backdrop-click closes.
- **Bigger on big screens.** Modal `min(1040px,96vw)`, photo `min(760px,90vw)` (were 880/560).
- **Detection catches more faces.** The solo-clip-tuned filters (minConfidence 0.5 / score 0.55 /
  minSide 64px·5.5%) dropped back-row + side faces in group shots (a table of 9 showed as 3). Relaxed
  to 0.4 / 0.42 / 44px·4%. It's a precision/recall tradeoff — naming a face requires it to become a
  cluster (whose descriptor IS training data), so his CONFIRMATION is the quality gate. TUNABLE.
- **Second-screen integration.** Clicking a face mirrors that shot's full-res file to the pop-out
  preview window (`previewSet`, no-ops when closed).
- **Face learning verified (no fix needed):** `assign()`→`people:save` appends the confirmed face's
  descriptor under the person (`confirmed:true`, near-dups deduped <0.35), persisted to people.json.
  Auto-guesses are stored `confirmed:false`. So it DOES learn from confirmations.

### ⚠⚠ SUPERSEDED — flow gaps found by audit (2026-07-17), NOW FIXED (see batch above).

Two subagents audited the photo path and the phone pull/staging path against the live code. High-value,
un-fixed (the copy/staging ones touch file integrity — do NOT rush a fix on the owner's real files):

1. **Photos filed via the phone/GoPro flow get ZERO embedded metadata.** `buildPhotoJobs` builds plain
   `{src,dest}` jobs (`src/mod/09-phone-finalize.js:753`) → `phone:distribute`
   (`main-mod/05-windows-phone.js:921`) is a pure `copyFileVerified` with **no exiftool write**. Videos
   reach `finalize:run` and get the rich XMP; photos never do (that scan hits the Compressed/source
   folder, not the Projects tree the photo was already dropped into). So all the AI's
   subject/people/keywords for a photo live only in the sidecar, never in the file. Biggest gap — the
   owner's ask #3 ("write a lot of what it finds into metadata") is unmet *for photos specifically*.
2. **Staging trusts file EXISTENCE, not completeness (HIGH, file integrity).** After the pull,
   `pullInto` stages by `stat` and discards the per-file OK/FAIL results (`05-windows-phone.js:277`);
   `scanPhoneStagedDir` on resume walks the dir with no size/fingerprint check. A truncated pull (MTP
   `CopyHere` timeout, short `adb pull`) is then renamed, moved to Uncompressed, and Tdarr'd into the
   archive as a corrupt clip. Needs a size/fingerprint gate on staged files vs the source manifest.
3. **Cancel on the MTP path doesn't stop the copy AND drops all videos (MEDIUM).** `copy:cancel` sets
   `phoneAbort`, but the MTP PowerShell batch loops with no abort check (`05-windows-phone.js:804`) and
   `streamSpawn` has no abort hook — so Cancel-at-62% keeps copying to the end, then `if (!phoneAbort)`
   skips the entire video pull (`:285`). The ADB path honors per-file cancel; MTP does not.
4. **Photos are second-class in Organize:** `finalize:scan` is video-only unless `includePhotos`, and
   `uiPrefs.finalizePhotos` defaults `false` (`src/mod/01-core.js`); the "ready to organize" counts
   (`pending:work`) are `listVideosShallow` only, so photos in Photos Temp never nudge. Unmatched
   photos linger in Photos Temp with no path into Projects.

### ⚠ num_ctx — the fixed 4096 window that dropped 3,744 clips in one run (2026-07-15)

`ollamaGenerate` (`main-mod/06-copy-transfer.js`) set `body.options = { temperature }` and never
touched `num_ctx`, so every call went out at Ollama's default context window of **4096 tokens**.
Current Ollama builds no longer silently truncate an over-long prompt — they return HTTP 400
`exceed_context_size_error`. Our prompts routinely run 5–6k tokens once injected memories, style
examples and the shoot digest are folded in, so a real batch analyze failed on **3,744 clips at
once** ("request (5337 tokens) exceeds the available context size (4096 tokens), try increasing it").

Fix: `pickNumCtx(prompt, opts)` sizes the window to the prompt (~3.5 chars/token over-estimate + a
per-image budget for vision + reply headroom, rounded up), floored at 4096 and **clamped to
`config.ai.numCtxMax` (default 8192)** so a 6 GB card's KV cache stays sane — this respects
[[usb-app-single-gpu-rule]]. `config.ai.numCtx > 0` pins a fixed window for every call. Regression
test: `test/ollama-numctx.test.mjs` (5 cases, captures the outgoing `/api/generate` body).

Note for the owner's "use Qwen not Ollama": Ollama IS the local runtime that serves Qwen — they are
not alternatives. The context error is independent of which model is loaded. The deeper cause is
root cause #4 (memories injected uncapped, ~18 KB/clip) — sizing num_ctx fixes the failure now;
capping the prompt is the still-open follow-up.

### ⚠ THE GROUP SHOT — multiple faces per frame, named ON the frame

Owner: *"recognize multiple people per frame … if there are more than one unconfirmed it should have a
thumbnail with that section of the video and I should be able to click each face and name them. Do this
smartly because I like the current system just build it smart."*

`detectAllFaces` **already found everyone in a frame.** All the app ever kept was a 144px crop per
person, so a frame with four people became four disembodied heads and the shot they came from was
thrown away. Now the best group frame per clip (most faces; size breaks the tie) is kept with a box per
face, and the review grid shows it as a clickable scene.

**Built on the existing system, not beside it** — that was the instruction, and it is also what keeps
it correct:

- Clicking a face renders **`cardHTML(cl)` inline** — the very same card, with its suggestion, chips
  and "Who is this?" input. `wire()` binds it automatically because it queries the whole scroll for
  `.face-grid-card-item`. **There is not one line of duplicate naming logic.** Don't add any.
- A face shown on the shot is **removed from the loose grid below** (`onScene`) — one person, one
  place to name them.
- A scene face re-links to its cluster **by DESCRIPTOR, never a stored index**: clusters are rebuilt
  from `faces-pending.json` on every reopen and merged across scans, so any index written down points
  at a different person next time.
- The frame is a ~1100px JPEG, so it goes to `faces/` through **the same `saveFaceCrop` path** as every
  crop; only the `file://` ref + boxes + descriptors live in `face-scenes.json`. **`gcFaceCrops()` must
  keep them** (`ensureStore('ai.faceScenes')` + `note(s.img)`) — miss that and the GC deletes every
  frame the first time it runs while the store still points at them.

**Verified in the RUNNING app** (Electron under WSLg, Playwright, a real 6-face clip): 4 boxes on the
real frame, click → inline card, type a name → box turns green + counter drops, the person lands in
`people.json` **and the clip is tagged `people:['Josiah']`** — which is what feeds the description.

**Two things left open by that verification:**

- **Reopening under-reports the shot.** `_serializePending` drops `done` clusters, so on reopen the
  already-named faces cannot re-link and their boxes vanish: the same frame that said *"4 people · 4
  still to name"* comes back as *"2 people · 2 still to name"*. No data loss — but the count describes
  live clusters, not the faces in the frame, and the green "already did this one" context is lost.
- **Only 4 of 6 visible faces were boxed.** NOT caused by this change (the per-person path uses the
  identical filters), it is the pre-existing detector gate — `minSide = max(64, w*0.055)` and
  `score < 0.55`, against a frame already downscaled to 1100px. If he complains that someone is
  missing from a shot, that is where to look, not in the scene code.

### ⚠ HOW TO DRIVE THE REAL APP FROM WSL (no card, no hardware)

The GUI *can* be driven end-to-end here, and it is worth doing — it found both items above.

- Playwright's `_electron.launch({ args: ['.'], executablePath: node_modules/electron/dist/electron })`,
  with `ELECTRON_RUN_AS_NODE` deleted from the env (VS Code leaks it — see `dev.sh`).
- Drive detection is Windows-only, so the home screen offers **"Choose drive…"** (`#manualPickBtn` →
  `drive:pick`, whose own comment says *"fallback / testing without hardware"*). Stub **only**
  `dialog.showOpenDialog` via `app.evaluate(({dialog}) => …)` and point it at a folder with clips.
  Then `#startFlowBtn` → the clips list. Faces: **Edit ▸ AI ▸ People & faces… ▸ Scan clips**
  (`.menu-trigger[data-menu="edit"]`, hover `AI`, then the item).
- **Gotchas that cost real time:** a full-page `win.screenshot()` HANGS under WSLg — screenshot the
  ELEMENT (`.face-grid-card`) instead. Attaching a CDP session KILLS the window. `import -window root`
  does not work under WSLg.
- **⚠ `XDG_CONFIG_HOME` does NOT isolate the stores.** `STORE_DIR` is
  `process.env.APPDATA || ~/AppData/Roaming/…` (`main-mod/01-core.js`), so a test run writes into
  **`~/AppData/Roaming/USB SD Auto-Action/`** for real. Set `APPDATA` to a temp dir if you want
  isolation. (A verification run has already left a test person "Josiah" + a test clip's faces there;
  it is the Linux dev store, not his Windows data, but clear it if it gets in the way.)

### ⚠ LEARNING FROM HIS CORRECTIONS — and why "just append it" would have changed nothing

The few-shot pairs the model is shown (`ai.styleExamples`) could only ever be written by the two BULK
MINERS — `learnFromLibrary` / `learnNames` — which read old filenames off disk. When Jake looked at a
name the AI produced and typed a better one, that pair was distilled into an English rule and then
**thrown away.** The single cleanest signal in the whole system — him saying *"you wrote X, it is
actually Y"* — never reached the model as an example. `recordAiEdit` already marked the clip
`_userNamed`; nothing carried the NAME.

`recordStyleCorrection` / `styleFewShot` (`main-mod/10-ai-tools.js`) close it. Three things hold it up,
and each one is a trap if you undo it:

1. **A SEPARATE STORE** (`config.ai.styleCorrections`). Corrections must NOT be appended to
   `styleExamples`: `learnFromLibrary` **assigns over** that array (there is a test pinning *"replaced,
   not appended"*), so one click of the health card's "learn my style" fix would have silently erased
   every correction he had ever made. Mined examples are derived data and can be rebuilt from disk at
   any time. A name he typed once cannot.

2. **CORRECTIONS WIN THE SLICE.** The few-shot is cut to 12; the mined set holds up to 60. **Measured:
   a correction appended to the end of that list appears at index 60 and is cut — it would have been
   stored, saved, and never once shown to the model.** They go FIRST, freshest first.

3. **…BUT ONLY HALF OF IT.** If he corrects twelve `vlog` clips in a row, twelve `vlog` examples would
   crowd out every other subject and the model would forget `pov` and `calisthenics` exist —
   `learnFromLibrary` deliberately spreads the mined examples ACROSS subjects for exactly that reason.
   Corrections take at most half the budget; the mined diversity keeps the rest.

**No `CAMERA_WORDS` filter on a correction, deliberately** — and that is the whole reason these are two
stores and not one. That filter exists because 18% of his archive's descriptions were written by the
OLD AI and a filename cannot say who typed it. Here it can: **he did, just now, to correct us.**
Second-guessing his own correction would make the app disagree with the user about what the user
prefers. `MARKER_SUBJECTS` still applies (`_delete_` is his junk marker, not a name).

Both prompt sites (`get_naming_style` and the legacy giant prompt in `07`) now read through the one
owner, `styleFewShot()` — two call sites reading `ai.styleExamples` directly is how one of them
silently stops showing him his own corrections while the other keeps working.
`test/ai-style-corrections.test.mjs` pins all of it.

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

### ⚠⚠ THE DESCRIPTION — face recognition belongs IN THE NAME (measured, his models, 2026-07-13)

Owner, on reading the output: *"I don't like those descriptions. It should also be using the face
recognition."* Both halves were real. Measured end-to-end on the real `qwen3:8b` via the real handler
(`ai:nameFromObservation`), on the mower-repair clip, **4 runs of 4 at each step**:

```
two-men-sit-on-a-cut-lawn-beside      ← before
men-working-on-mower                  ← keyword rules restored
josiah-repairing-mower                ← face recognition in the name
```

**1. The description was a truncated SENTENCE.** `set_clip_name`'s description field said only *"What
is HAPPENING — concrete and specific. This is where the detail goes."* Handed a rich observation the
model answers with English prose, and the 8-word cap just severed it at a preposition. The rules it
needed **were not new** — the LEGACY giant prompt already had them (*"2-6 keywords… no articles/filler…
no sentences"*) and **the tool path had dropped them.** On that one field the redesign was *worse than
the thing it replaced*. Check the old path before assuming the new one is strictly better.

`aiCapWords` now strips filler at the **EDGES ONLY**. Interior function words stay: his own
`headcam-getting-into-truck-and-checking-trailer` needs its `into` and its `and`, and a blanket
stopword strip would **rewrite his style rather than enforce it**.

**2. Face recognition never reached the name — and the gap was NOT in the face code.** It already ran,
already recognised Josiah, already handed the name to the loop. But **the vision model cannot know that
man is Josiah**, so nothing in the observation ever says so, and nothing told the reasoning model that a
recognised name outranks what the camera saw. His archive is `josiah-front-lawn`,
`liam-mowing-front-lawn`, `josiah` — **the person's name IS the description.** It now goes in the TOOL
RESULT (`get_naming_style`), not just the system prompt: on an 8B model **a tool result is input; a
system prompt is a suggestion.** Only when someone was recognised — an empty list invites *"no people
visible"* into the name.

**3. …which then BROKE THE PROTOCOL, and the fix had to be structural.** The richer `get_naming_style`
made the model feel it had enough, and it **skipped `get_shoot_context`** — the single biggest naming
win there is. Measured, 4 runs of 4: the protocol collapsed to two calls. It still got the subject
right, **by luck** — the word "lawn" happened to be in the observation — and the clips that NEED that
tool are precisely the ones where it is not. `set_clip_name` now declares
**`requires: ['get_shoot_context']`** and the loop refuses to name until the shoot has been looked at.
Asking did not work. Structure does. **Enriching one tool's result can silently starve another — check
the whole trace after any tool-result change, not just the final answer.**

### ⚠ HOW TO MEASURE AGAINST HIS REAL MODELS (no GPU needed in WSL)

Ollama runs on the **Windows host**, bound to Windows `localhost`, which WSL cannot reach. Windows
`curl.exe` can: `/mnt/c/Windows/System32/curl.exe`. So load `main.js` in the normal test harness and
swap ONE thing —

```js
app.get('globalThis').fetch = async (url, opts) => winFetch(url, opts);   // shells out to curl.exe
```

— and every call site (`ai:nameFromObservation`, `ai:placeGroup`) runs the **real tool schemas, the real
`runToolLoop`, the real `styleFewShot`** against the real `qwen3:8b`. Not a re-typed approximation: the
app's own code. This is how everything above was measured, and it is cheap. Do it before believing a
prompt change worked.

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

### ⚠ UNDO HAS TO ACTUALLY UNDO — the second silent mis-file, same shape as the first

An `exact` recall **files a shoot with no card and no question**. So the Undo button on that auto-filed
card is the ONLY way he can ever correct a placement the app got wrong. It cleared `g.chosen` — the UI
— and left the memory that *caused* the auto-file sitting in `config.placementMemory`. Undo it, close
the review, and every future clip from that shoot is silently filed into the project he just rejected,
forever. His undo was quietly reverted, and the app got **more** confident each time (`count` goes up).

It only ever looked fine because re-picking updates the record in place: **the bug needs him to undo and
NOT immediately choose again** — which is exactly what "undo" means.

- `forgetPlacement()` removes the record, keyed on the **same identity `rememberPlacement` writes**
  (subject + shoot day + people). If those two ever disagree, undo deletes the wrong record — or
  nothing at all, while reporting success. There is a test pinning them together.
- **Undo then RE-ASKS.** `g.options` (the one-click chips) is only ever filled from the model's own
  search trace, and a recalled group never had one — so an undo dropped him on a bare text box, typing
  a project path from memory to fix the app's mistake. **Forgetting BEFORE the re-ask is what makes it
  honest:** the model calls `recall_decision` first, and now correctly finds nothing.

**The single-GPU test caught a real bug in that re-ask** — not a stale pattern. `undo` fires from a
click handler, **outside** the `for … await` loop, so it would have started a second tool loop straight
into the middle of the first. Same model, so it does not OOM the way vision-plus-text does; it doubles
the KV cache on a 6 GB card and both crawl. **`for … await` does not protect you from a click.** Every
model call now goes through one `queueAsk` chain, and the test asserts *that* invariant rather than
"the call is lexically inside the loop", which was only ever a proxy for it.

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

### ⚠ FILING BACK ONTO HIS COMPUTER — it COPIES, and the disk is the constraint

His decision, 2026-07-13: *"C:\Users\jakeg\Videos\02 - Projects\2026 … I would like to be able to
select what footage goes back here onto my computer"*, filed **in batches, not per clip**.

The numbers that shape every decision here:

| | |
|---|---|
| archive — `L:\…\02 - Compressed` | 310 clips, **73 GB**, on a 2.3 TB-free disk |
| projects — `C:\…\02 - Projects\2026` | `2026 - Client Work` / `- Personal` / `- Social Media`, **30 GB free**, and it is his SYSTEM disk |

**It does not all fit. That is not a bug — it is why he wants to choose what comes back.**

1. **Organize COPIES now, it does not move** (`config.organizeCopy`, opt-OUT). The project folder on C:
   is a WORKING copy he can clear out when the disk fills, and the archive on L: has to still be there
   when he does. A move would quietly make the C: copy the only copy, on the smaller and fuller disk.
   Move is still available — the "Keep the originals in the Compressed folder" tick.
2. **`organizeMove()` routes both modes through ONE staged+verified writer** (`stageVerifiedCopy`:
   stage → flush → **full** fingerprint → rename). A second hand-rolled copy of the footage is exactly
   how you get one path that verifies and one that doesn't. See [[usb-app-copy-integrity]].
3. **`finalize:run` refuses a run that will not fit**, before a single byte is written — with 2 GB of
   headroom, because filling a *system* disk to the last byte breaks the machine, not just the app.
   Copy-only: a move consumes no space on the destination.
4. **The Organize screen shows the two numbers up front** (`renderFinSpace`): how much he has selected,
   and how much room is left. A refusal at the end of a long think is a worse answer than a number he
   could see all along.
5. **`defaultProjectsRoot()` prefers the current YEAR folder** when it exists. His projects live at
   `02 - Projects/2026/…`; defaulting to `02 - Projects` would file every clip one level ABOVE his
   real project folders — technically organized, completely useless. Verified on his machine: it
   resolves to the right folder, and the health card offers it in one click rather than a file browser.

The batch unit is the SHOOT (`date|subject`) — see the placement section. That is what "recognize in
batches where stuff goes, not per clip" means.

### ⚠⚠ ORGANIZE — HIS REAL TREE, AND THE THREE BUGS THAT MADE IT "SUCK"

His tree, read off C: on 2026-07-13:

```
C:\Users\jakeg\Videos\02 - Projects\2026\
  2026 - Client Work\    Charles · Gourgess Lawns
  2026 - Personal\       Course Content · Facebook · 2026-06-11_vlog_footage-from-gopros_v1
  2026 - Social Media\   Calisthetics Journey · 2026-05-30_vlog_water-park_v1
```

His decisions (2026-07-13): **a dated subfolder per shoot** inside the project · **the AI proposes a
new project folder and he confirms** · **the category is learned from where things already went**.

Target shape: `2026 - Client Work\Gourgess Lawns\2026-06-01\<clip>.mp4`

**1. It was slugging his folder names.** `slugFolder()` turned `2026 - Client Work/Gourgess Lawns` into
`2026-client-work/gourgess-lawns` — a **brand-new folder created beside the real one**, holding the new
footage while every edit he has ever made sat in the other. It **silently forked his project tree**, a
little more on every run. Now `safeFolderName()` (sanitize only what Windows forbids — never case,
never spaces) + `resolveFolderPath()` (ask the disk what the folder is *really* called, so
`2026 - client work` lands in his existing `2026 - Client Work`).

**2. `create_project` could invent a CATEGORY.** A new *project* is a reasonable thing to invent; a new
*category* is not. A model answering `Client Work` (dropping the year — exactly the near-miss an 8B
model makes) would have created a second category beside the real one and split his tree in half. The
parent must now be a folder he actually has, and the created path uses **his** spelling.

**3. A dated folder was matching every shoot forever.** MEASURED, real qwen3, his real tree: a wedding
for a NEW client was filed into `2026 - Personal/2026-06-11_vlog_footage-from-gopros_v1` — **3 runs out
of 3**. Because he names one-off project folders exactly like clips, the folder name contains the
subject word `vlog`, so *every* vlog shoot matches it lexically, forever. The search returned it as a
hit and the model trusts hits. **It was never a hit; it was a word collision — better prompting could
not have fixed it, because the TOOL was handing the model a wrong answer and calling it a match.**

The rule his tree encodes: **dateless folder = an ongoing project (new shoots welcome); dated folder =
the home of THAT shoot, and no other.** → `folderIsOtherShoot()`.

**Result on his real tree, 3/3 each:** `lawn-mowing → Client Work\Gourgess Lawns` ·
`calisthenics → Social Media\Calisthetics Journey` (bridging his own `Calisthetics` typo, via
`aiTokenMatch`'s 3-char prefix — a substring search can never connect `calisthenics` to
`Calisthetics`) · a wedding for a new client → **ask_user**, instead of a wrong folder.

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

### 2026-07-18 — The RENDERER is testable too now: a real Playwright+Electron E2E harness
- The vm harness above covers MAIN only. Renderer fixes kept shipping "inspection-verified, needs a
  visual check on deploy" — the exact source of the whack-a-mole regressions. `test/e2e/` closes that:
  it launches the **real app** (`playwright-core`'s `_electron`) and asserts on the live DOM and the
  renderer's own `state`/functions. Proven on real blind items: #90 (modal aria), #51 (next-unnamed),
  #34 (batch-apply save-point) — all green against the running app.
- Same trick as the vm harness, in Chromium: `renderer.js` is one classic script, so its top-level
  `const`s (`state`, `applyBatch`, `saveVersionPoint`…) are global-lexical and readable via page eval —
  `read(win, expr)` / `run(win, body)`. You can even wrap a real function (e.g. `saveVersionPoint`) to
  count calls and assert the real `applyBatch` invokes it.
- **Traps (all were live):** delete `ELECTRON_RUN_AS_NODE` (WSLENV leak → no window); isolate + seed
  via **`APPDATA`** temp dir (stores are `${APPDATA}/USB SD Auto-Action`); `--no-sandbox --disable-gpu`;
  `focusClip` focuses on a 160 ms timeout (await it); tear modals down via DOM not click; full-page
  screenshot hangs under WSLg.
- **Run:** `npm run test:e2e` (opt-in, `RUN_E2E=1`, needs a display — WSLg provides one). `npm test`
  stays fast (e2e SKIP-guarded, no Electron). `npm run test:all` = both. See `test/e2e/README.md`.
  **For any renderer/UI change from here on, add an `*.e2e.mjs` instead of writing "verify on deploy".**

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

### 2026-07-18 — The preload is sandboxed now (audit #94)
- `sandbox: false` gave the preload a full Node process for no reason: preload.js requires ONLY
  electron's `contextBridge` + `ipcRenderer`, both of which a sandboxed preload still gets. Verified
  before touching it — no fs/path/os/child_process/Buffer anywhere in the file.
- **Why it's worth more here than in a typical Electron app:** `webSecurity: false` sits three lines
  below, a deliberate trade so Chromium's native file loader can seek HEVC over `file://`. That means
  rendered filenames and AI text run in a renderer with the brakes off. If anything ever achieves
  script execution there, the sandbox is what stops it reaching a full Node process. It doesn't fix
  #95 (no path validation on fs/shell IPC) — it shrinks what a compromise is worth.
- **Verified, not reasoned: the entire 40-test e2e suite passes with the sandbox ON** — real app boot,
  folder scan, real face-api detection over WebGL, IPC round-trips, modals, seeded stores. Those
  tests call `window.api.*` throughout, so the bridge is genuinely exercised rather than assumed.
- **The guard that matters going forward is the precondition, not the flag**: a test asserts
  preload.js requires *nothing but* `'electron'`. Adding `require('fs')` there would pass review and
  then fail at RUNTIME in the packaged app — the worst possible place to discover it. The test fails
  at build time with a message saying to move Node work into main and expose it over IPC.
- The `webSecurity: false` assertion is deliberately phrased as a reminder to revisit this reasoning
  if that ever changes, rather than as an endorsement of leaving it off.
- Test: `test/preload-sandbox.test.mjs` (4).

### 2026-07-18 — The ADB→MTP fallback existed but was unreachable (audit #89)
- `mtpCopyToDest` is ADB-first with an MTP fallback and even comments *"falling back to MTP"* — but
  the gate was `if (r && r.ok) return r`, and **`adbPullToDest` returns `{ ok: true }`
  unconditionally.** It tracks failure PER FILE (`status: 'FAIL'`) while always reporting batch
  success, so the fallback could never run: whatever ADB choked on was silently dropped and the pull
  reported done. Irreplaceable phone media, not pulled, with the UI saying it finished.
- **This is the shape to watch for: a batch-level `ok` that summarises per-item results.** The
  fallback wasn't missing, it was *unreachable* — the same class as #40's always-false warning and
  the dead `autoMatched` gate, and the third instance this run.
- Now decided per FILE: `adbRetryList(items, results)` retries only the stragglers (never re-pulling
  gigabytes that landed), and `mergePullResults` lets the LATER attempt win so an item MTP rescued
  reports OK instead of a phantom loss in the declined count (#87).
- **"Not mentioned in the results" counts as needing a retry, not as done.** A crash or abort
  mid-batch leaves later items unreported, and treating no-news as success is exactly how a file goes
  missing quietly — there's a test for that case specifically.
- Per §8 the transports can't be driven in WSL, so the decision is extracted and unit-tested; the
  wiring is pinned by a test asserting the always-true batch flag no longer gates the fallback.
- **Found by triaging the remaining backlog for "does the HARM still occur?"** rather than picking an
  item and hoping — the discipline that iteration 29's wasted work bought. Same pass cleared #59
  (already covered) and found #94 (`sandbox: false`) and #100 (pretty-printed multi-MB stores) still
  real but lower value.
- Test: `test/phone-adb-fallback.test.mjs` (7).

### 2026-07-18 — #59 already fixed; I nearly shipped a duplicate of it (negative result)
- The audit says renamed videos in `_Phone Video Temp` live only in `phonePendingVideos`, so closing
  the app re-loads them as fresh unnamed clips and re-analyzes. **The module-level array is real —
  the CONSEQUENCE is not.** `scanPhoneStaged()` reads that folder from disk, `renderPendingWork()`
  already shows a home card for it, and `resumePhoneStaged()` continues naming/organizing **without
  the phone connected**. The recovery path exists, and `01-core.js` even says so in a comment
  ("the AI analysis it already did is remembered per clip — nothing re-analyzes").
- **I had already implemented and tested a main-side `phoneStaged` count on `pending:work` before
  checking the renderer.** It passed 5 tests and was completely redundant — a second implementation
  of logic that already works, i.e. the DEDUP.md failure this repo warns about, with a drift risk
  between the two. Reverted in full, tests deleted.
- **The lesson is sharper than "the audit is stale":** I verified the SYMPTOM (a module-level array
  that doesn't persist) and treated it as proof of the HARM (work is lost). Those are different
  claims. Before building the fix, check whether another mechanism already covers the harm —
  especially in a codebase where recovery paths were added later than the bug reports.
- Sixth backlog entry this run that was already done or misdescribed. Cost here was one iteration of
  wasted implementation, caught before it shipped only because I read the renderer before declaring
  victory.

### 2026-07-18 — Phone media dated by COPY TIME, not capture time (audit #58, video half)
- `date: phoneDateOf(name) || toDateStr(mtimeMs)`. After an MTP/ADB pull, mtime is when the file
  landed on disk — **today**. Plenty of phone media has no date in the filename (WhatsApp,
  screenshots, many Android cameras), so a shoot from last month arrived dated today.
- **Not cosmetic, and this is why it was worth doing over the remaining perf items:** the shoot DATE
  predicts the subject ~88% of the time (`usb-app-shoots-in-batches`) and drives day-grouping, ledger
  same-shoot matching, and `get_shoot_context` — the AI's single strongest signal. A wrong date
  poisons placement AND naming, quietly.
- `captureDateFor()` now tries, in order: filename → container `creation_time` → mtime. **Filename
  first on purpose** — it's authoritative and free, while probing spawns an ffprobe per file, which
  is unaffordable across a card of hundreds when most names already carry the date.
- **VIDEO HALF ONLY, and the boundary is measured not assumed: ffprobe returns EMPTY tags for a
  JPEG** (verified here). Stills need `EXIF:DateTimeOriginal` via the vendored Windows exiftool,
  which will not run in WSL — so probing a photo would cost a spawn and return nothing. The photo
  branch is explicit in the code and pinned by a test, so nobody "completes" it without exiftool.
- Fallback to mtime is retained for an unreadable file: a missing date must never break staging.
- **Scoping trap worth remembering:** the helper was first written at column 0 but INSIDE another
  function body — still a nested binding, invisible to `page.evaluate`. Indentation is not scope;
  the e2e caught it immediately with "captureDateFor is not defined".
- Test: `test/e2e/phone-capture-date.e2e.mjs` (4), driving the real renderer against a real video
  whose container says 2026-06-01 and whose filename says nothing.

### 2026-07-18 — Reachability made an invariant; the IPC surface audited end-to-end
- Prompted by shipping #64 unreachable: audited **every** IPC path rather than trusting that mine were
  wired. **179 main channels, 179 bound in preload — zero orphans.** So no main-side handler exists
  that a user can never reach, including everything added this run (`clips:tagPerson`,
  `clips:untagPerson`, `ai:cancel`).
- The other direction found real dead surface: **11 preload methods nothing calls** (`adbDisable`,
  `aiBackfillLedger`, `aiLoaded`, `aiRecallShoot`, `aiVisionAdvice`, `applyRename`,
  `clearPhoneBackupFolder`, `facesImage`, `feedbackList`, `getIntake`, `removeFieldHistory`). In a
  `webSecurity:false` renderer every exposed method is callable by injected script, so this is
  attack surface as well as clutter (audit #95).
- **Deliberately NOT deleted.** Several belong to phone/AI features that can't be exercised from WSL,
  and removing an API because a grep found no caller is exactly the "tidy" this codebase's lessons
  warn about. Pinned in a KNOWN_UNUSED list instead, so **new** dead methods fail the suite while the
  existing ones stay a deliberate follow-up. Each one removed is one less thing an XSS can call.
- **The check earned its keep on its first run**: my quick ad-hoc scan called `aiBackfillLedger`
  "used by tests", but the tests call the INTERNAL `backfillLedgerFromTree` directly and never touch
  the bridge method — a substring false positive the stricter check caught. `getFinalMeta` is the
  genuine counter-example: e2e calls `window.api.getFinalMeta()` through the real bridge, so it is
  correctly not flagged.
- **Stated plainly in the test: this would NOT have caught #64.** That was an unset settings FIELD,
  not an unbound channel — it catches the neighbouring class only. A guard oversold is a guard
  misused.
- Test: `test/ipc-reachability.test.mjs` (3), including a can't-pass-vacuously check.

### 2026-07-18 — #64 follow-up: I shipped the opt-in with no way to opt IN
- The GPU encode landed reading `s.gpu` — **which was set nowhere.** The renderer sends
  `{preset, skipExisting}`, so the entire feature was unreachable: read in three places, written in
  none. That is precisely the dead-code shape audit #40 was about, committed by me two iterations
  after documenting it. **An "opt-in" feature is only meaningful if the opt-in exists; check the
  switch is wired before calling it done (§6).**
- Fixed in `compressSettings`: `config.compressGpu` (default false) now flows through as `s.gpu`.
  **HOW TO TURN IT ON: set `"compressGpu": true` in config.json.** Config-only on purpose, matching
  the other advanced knobs (numCtx/numCtxMax) — a tool for a tool-user (§1), not a settings screen
  for everything, and it wants one side-by-side encode before being recommended.
- **The strongest test in the set is the end-to-end one:** with the flag ON, on a machine with no
  usable GPU, a real ffmpeg encode still succeeds and produces a complete file. This box is the ideal
  adversarial case — it LISTS nvenc and can use none of it — so that test proves the opt-in cannot
  break compression for someone whose driver is missing or broken.
- Three tests now pin reachability itself (the switch reaches settings; default is off; a per-run
  override still wins), so the feature can't quietly become dead code again.
- `ai-parse.test.mjs` asserts `deepEqual` on the WHOLE settings object, so adding one field broke two
  tests. **Fourth time this run a test pinned an exact shape rather than its intent** — expected here,
  since those are deliberately characterization tests, but it's the recurring maintenance cost of
  exact-shape assertions.

### 2026-07-18 — GPU encode (audit #64): shipped OPT-IN, and `-encoders` is NOT an availability probe
- Compression only ever ran libx265/libx264 on the CPU despite an RTX 3060 — the slowest step in the
  pipeline, where NVENC is typically 5-20x faster. `buildCompressArgs` now emits `hevc_nvenc` /
  `h264_nvenc` when `s.gpu` is set AND the probe says that specific encoder works.
- **DEFAULT OFF, deliberately.** The CRF→CQ mapping decides the quality of his PERMANENT compressed
  archive, and visual quality cannot be validated from WSL. The probe, plumbing and CPU fallback are
  verifiable and land now; turning it on by default needs one real side-by-side encode on his
  machine. Note #6's duration verdict catches an INCOMPLETE encode but says nothing about whether
  the quality is right — it is not a substitute for that comparison.
- **The test caught a genuine design flaw before it shipped, and this is the durable lesson:
  `ffmpeg -encoders` lists nvenc whenever ffmpeg was BUILT with it.** Verified here — this WSL box
  reports 5 nvenc encoders and cannot use any of them. A listing-based probe would have selected a
  hardware encoder on any machine without a working NVIDIA driver and failed EVERY clip. Availability
  is now a **functional test-encode** checked by exit code.
  - Second-order trap found the same way: the probe frame must clear NVENC's minimum dimensions. A
    64x64 probe fails with "Frame dimensions are less than the minimum supported value" — reporting
    "no GPU" on a machine that has one. It uses 320x240.
- Per-codec decision, because partial drivers are common (h264_nvenc present, hevc_nvenc missing);
  emitting an encoder ffmpeg lacks would fail the whole batch. NVENC ignores `-crf`, so `-cq` is sent
  instead and `-crf` is omitted entirely; `-tag:v hvc1` is kept so Resolve/Finder still read it.
- A failed probe is NOT cached — same latch lesson as the AI capability cache (§7a).
- `copy-integrity.test.mjs` pinned `buildCompressArgs(src, partPath, s)` exactly; updated to allow the
  new 4th arg while still pinning the DESTINATION. **Third time this run a test pinned incidental
  arity/strings rather than its stated intent** — worth watching for when adding a parameter.
- Test: `test/compress-gpu.test.mjs` (7).

### 2026-07-18 — PROMPT.md §4 refreshed; the deploy backlog is now the top risk
- PROMPT.md's own last line says to update it when its guidance would mislead. After this run **§4's
  weak-point list had gone stale in the most costly way: three of its six items were largely done**
  ("renderer fixes are blind" — the e2e suite now covers them; "the two filing paths disagree" — #29
  /#37/#30 landed; "the delete gate is untrusted" — #15 hardened it). A future session reading it
  would have gone and re-done finished work. Rewritten with what's actually true now.
- **The new #2 is the DEPLOY BACKLOG, and it is worth saying plainly: dozens of fixes across many
  batches are built, tested and still unshipped.** None of it helps Jake until it lands, and the
  longer the batch grows the more a single deploy can surprise him. Deploying — when he is not
  mid-scan — is now worth more than the next fix. That is a judgement this log should carry, because
  no individual iteration will ever surface it.
- The other new entries are the patterns this run kept paying for, promoted from incident notes to
  standing guidance: the audit list has drifted from the code (confirm a bug reproduces first);
  sibling paths that never got a guard (grep the pattern, don't wait for the audit); write-throughs
  without their inverse; and "measure before optimising" with the won't-fix numbers attached.
- **Also-ran verified but deliberately NOT fixed: MTP album chip counts** (`05-windows-phone.js`
  ~line 174) use `$alb.GetFolder.Items().Count`, which counts `.thumbnails` and other non-media, so
  the chip over-reports. Real, but it lives in a **PowerShell string I cannot execute in WSL** (§8)
  and it's a cosmetic count — changing code I can't run is the "don't ship blind" case. Filter by
  media extension inside the PS loop when someone can test against a real device.

### 2026-07-18 — #75 measured → WON'T-FIX; dead `autoMatched` flag removed
- **#75 (people:match rebuilds the enrolled set every call) — MEASURED, then declined.** A generous
  enrolled set (10 people × the 80-face cap) rebuilt and compared **750 times** — a ~250-clip scan at
  ~3 faces per clip — costs **79 ms total, 0.11 ms per call**. The dominant cost in that loop is the
  distance comparison itself, which a cache would not remove.
- **So caching would trade recognition CORRECTNESS for 79 ms.** The backlog's own note warns of a
  stale-match risk, and it's real: confirm a face mid-scan and a cached enrolled set misses it. In the
  app's most sensitive subsystem that is a bad trade against a saving no user can perceive. Recorded
  as won't-fix with the numbers so nobody re-opens it on the strength of the big-O alone.
  **General point: an O(n·m) that looks alarming can still be free — measure the constant.**
- Removed the dead `autoMatched` flag. It was read in three places and set nowhere: the "Recognized
  automatically" section could never render, and its Undo gate was the real bug fixed last iteration.
  With that fixed the flag had no purpose left, and **a dead flag that has already caused one bug is a
  trap, not harmless clutter.** `done && !autoMatched` collapsed to `done` — provably equivalent,
  since the flag was always falsy.
- The section was always empty for a DESIGN reason worth keeping visible: nothing auto-confirms in
  this app — a recognised face becomes a SUGGESTION the user confirms (`collectClipFaces`). If that
  ever changes, reinstate the section deliberately, with a flag something actually sets.
- Test: `test/e2e/faces-review-sections.e2e.mjs` (4), pinning that the OTHER sections survive.
  One trap while writing it: `Function.prototype.toString()` includes COMMENTS, so asserting the
  absence of a phrase that my own explanatory comment mentions failed. Assert on the rendered call.

### 2026-07-18 — "Undo" on a confirmed face never untagged the clips (+ #76 measured and deferred)
- `assign()` tags every clip in the cluster, but Undo untagged only
  `if (cl.autoMatched && cl.assignedName)` — and **`autoMatched` is read in three places and never
  SET anywhere**. The condition could not be true, so Undo reset the card and left the person tagged
  on all their clips. The user watches the face go back to unnamed and reasonably concludes the tag
  is gone. (Same family as #40: a dead condition making a control silently not do its job.)
- **My own #26 fix made the consequence worse, and that's the lesson**: tagging now writes through to
  finalMeta/renameDrafts, so an un-reversed tag is PERSISTED. **Adding a write-through path obliges
  you to add its inverse** — otherwise "undo" quietly means "undo the part you can see".
  `clips:tagPerson` needed the sibling `clips:untagPerson`; it now has one (remove-only, idempotent,
  never creates a record for an unknown key).
- Both halves: the renderer's `untagClips` reverses the persisted tag as well as the in-memory one.
- **#76 (120 frame data-URLs over one IPC) — MEASURED, then deliberately NOT done.** Two things the
  measurement changed: frames are scaled to **1100px, not "full-res"** as the audit says (~5 MB at
  the default 24 frames; ~25 MB only at the non-default 120), and — more importantly — the audit's
  recommended **bounded-concurrency detect conflicts with `usb-app-single-gpu-rule`**: one 6 GB card,
  one model resident, so parallel WebGL detects wouldn't parallelise and could OOM. The safe half is
  streaming frames in batches to cut peak memory, WITHOUT touching detect concurrency. Left for a
  session that can profile it on the real machine — this is the app's most bug-prone subsystem and
  the measured payload at default settings doesn't justify a blind refactor.
- **Also deferred: adding `tool_name` to tool-result messages** (audit also-ran). It looks like a
  protocol correctness fix, but it changes the payload the model receives — exactly what
  `usb-app-tool-strings-are-input` says costs measurable accuracy. Needs a run against Jake's real
  models first.
- Still dead, noted not fixed: the "Recognized automatically" section (`recognized` is always empty
  because nothing sets `autoMatched`). It renders nothing, so it misleads no one — lower priority
  than the Undo defect, but it should either get wired up or be deleted.
- Test: `test/clips-untag-person.test.mjs` (6), including a guard that the dead `autoMatched` gate
  doesn't come back.

### 2026-07-18 — The faces-pending save was stalling main once per clip (audit #67)
- `schedulePendingSave` used a flat 700 ms debounce, so during a scan a save fired after EVERY clip —
  and `writeJsonAtomic` is `writeSync` + `fsyncSync`, so each one blocks the MAIN process. Previews
  and copy progress hitch with it, 250 times across a 250-clip scan.
- **Measured before changing anything** (#66 externalised the crops, so the obvious question was
  whether anything was left): a realistic post-#66 store of 250 clusters still serialises to
  **3.1 MB** and **~13 ms** — and that's before the synchronous write and fsync. The 128-float
  descriptors are the remaining bulk; externalising the crops didn't touch them.
- Fix: `PENDING_SAVE_MS()` returns 8 s while `faceScanActive`, 700 ms otherwise, and the scan's
  `finally` clears the flag and flushes.
- **Why trading durability is legitimate HERE and not elsewhere: faces-pending is DERIVED data.** The
  worst case after a crash is re-scanning some clips — not lost footage, not lost names. Drafts keep
  their tight debounce for exactly the opposite reason. This is the distinction to apply before
  coarsening any other save.
- **Coarsening a debounce turns into DATA LOSS without the flush.** With an 8 s window a write can
  still be pending when the scan ends, so the `finally` calls `savePendingNow`. There's a test for
  that specifically, and another asserting the idle path is still 700 ms — applying the coarse
  interval everywhere would make the review grid feel like it loses work.
- Test: `test/e2e/faces-pending-debounce.e2e.mjs` (4), against the live renderer. The existing real
  face-detection e2e tests still pass, which is what proves the flag doesn't break the scan itself.

### 2026-07-18 — Cancel now actually cancels the Ollama request (audit #78)
- `ollamaFetch` carried only `AbortSignal.timeout(...)`, and the renderer's `aiAborted` flag is
  checked BETWEEN clips — so pressing Cancel mid-request left the current call running to
  completion: up to 180 s for a vision pass, or the whole tool loop for naming. "Cancelling…"
  sitting there for minutes per stuck clip is the most trust-destroying thing a long job can do.
- A shared cancel token (`aiCancelToken()`) is now merged into every request's signal via
  `AbortSignal.any`, with an `ai:cancel` IPC and the renderer's Cancel wired to it. This is the
  proper fix for the limitation logged under #23, where `aiCallGuard` only stops WAITING.
- **The subtle part is renewal, not the abort.** A token left in the aborted state would fail every
  later request instantly and leave the AI dead until restart — far worse than the bug being fixed.
  `aiCancelToken()` rebuilds when aborted, and there's a test named for exactly that ("a cancel does
  NOT poison the next run"), because it's the failure a careless implementation ships.
- `AbortSignal.any` is guarded (`typeof … === 'function'`) with a fall back to the timeout alone, so
  an older runtime can never stop the app talking to Ollama.
- **Harness gap closed, same shape as when `fetch` was added (§7a):** the vm sandbox had no
  `AbortController`, so every Ollama call threw ReferenceError under test while working fine in
  Electron. It's now a sandbox global. If a test fails with "X is not defined" on something that is
  a browser/Node global, suspect the sandbox before the code.
- Test: `test/ai-cancel.test.mjs` (4) — a stub that holds requests open so an in-flight abort is
  observable.
- **#97 deliberately NOT done**: registering the login item at first boot is flagged as a consent
  issue, but this is a TRAY app Jake wants resident to watch for cards. Adding a prompt would put
  friction on intended behaviour. Left alone on purpose, not overlooked.

### 2026-07-18 — Async-cleanup sweep: renderer is CLEAN, and now stays that way (negative result)
- Third sweep axis: every `.disabled = true` / busy-flag site in the renderer that then awaits an
  IPC call. **Found nothing broken.** All 19 sites already have a `catch`, a `finally`, or go through
  `withBusyBtn` — `usb-app-async-cleanup-rule` has been applied thoroughly.
- Two sites looked unprotected at first and were NOT: the delete-gate "Verifying copies…" button
  absorbs the rejection with `catch { verify = []; }` so the re-enable always runs, and the Finalize
  Run button's try/catch/finally simply sits further from the disable than my initial 30-line window.
  **A detector that ignores `catch` manufactures false positives** — worth knowing before anyone
  "fixes" those two.
- **So the deliverable is the invariant, not a change.** `test/async-cleanup-guard.test.mjs` encodes
  the rule as a test: disable-then-await with no catch/finally/withBusyBtn fails the suite. This turns
  a lesson people must remember into something the suite enforces — the same move `check-primitives`
  makes for the copy/spawn primitives.
- **Verified the guard has teeth rather than trusting a green tick**: injected a deliberate violation
  into `03-rename.js`, confirmed it failed at the exact line, then reverted. A guard that passes
  because it inspects nothing is worse than none (audit #40's lesson, applied to my own test).
- Tuned to stay quiet on purpose — 40-line lookahead, and catch/finally/withBusyBtn all count as
  protection. A guard that cries wolf gets deleted. It also asserts it can't pass vacuously (there
  are still ≥10 busy sites and `withBusyBtn` still exists), so a rename can't silently neuter it.

### 2026-07-18 — The phone pull had no free-space preflight either (sweep, second finding)
- Continuing the "guard on one path but not its sibling" sweep: the free-space preflight existed on
  exactly TWO write paths (organize, and intake since #16). `phone:pull` empties an entire camera
  roll — routinely tens of GB — and simply started writing. ENOSPC part-way leaves a half-pulled
  phone, a truncated file and a full system disk.
- **Photos and videos go to DIFFERENT destinations** (Photos Temp vs _Phone Video Temp) which can sit
  on different volumes, so each destination is checked against the bytes actually headed there.
  Summing everything against one disk would be wrong in both directions — it would miss a huge video
  set landing on a small drive, and falsely refuse when the two temps are on separate disks.
- Matches the sibling preflights deliberately: 2 GB headroom, missing size counts as 0, unreadable
  volume skips the check. Three copies of this logic now exist (organize / intake / phone); if a
  fourth writer appears, extract a shared `hasRoomFor(dest, bytes)` rather than pasting it again.
- Testable despite §8's ADB/MTP rule because the preflight runs BEFORE any device work — the
  reproduction is telling: without it the handler reached the MTP transport and died on a missing
  temp file, which is exactly the "it already started" failure the check prevents.
- No renderer change — verified: the pull's failure branch already renders `res.error`.
- Test: `test/phone-freespace.test.mjs` (4), including the two negative guards (a pull that fits
  isn't blocked; items with no declared size never cause a false refusal).

### 2026-07-18 — Two albums, one filename, one lost photo (audit #5) — found by sweeping, not by the list
- A phone pull flattens every selected album into ONE folder, and `IMG_0001.jpg` lives in Camera AND
  WhatsApp AND Downloads. `adbPullToDest` joined the raw name, so the second item either overwrote
  the first (different sizes) or was read as a completed RESUME and skipped (`have.size === it.size`)
  — one irreplaceable photo silently gone, the other staged twice.
- **This came out of deliberately grepping the "guard on one path but not its sibling" pattern**
  rather than taking the next audit entry: `uniqueDest` was used at six write sites and missing at
  this one. That sweep is worth repeating — it found a Tier-1 data-loss bug the last several
  iterations would not have reached.
- The sweep also CLEARED two suspects, which is worth recording so nobody re-investigates: the
  `copyFileSync` in 08-finalize-feedback is feedback SCREENSHOTS (not footage), and the raw
  `fsp.copyFile` in 05-windows-phone is inside the `sim` branch (a fake phone, not the real transport).
- New `claimPullDest(dir, name, claimed)` beside `uniqueDest`. **The distinction that makes it safe:
  only rename when the name was claimed by a DIFFERENT item in THIS run.** A file left by a PREVIOUS
  run must keep its exact path — my first attempt delegated to `uniqueDest` unconditionally and the
  resume test caught it immediately: it stepped past the existing file, which would re-download the
  whole card under new names on every resumed pull. `uniqueDest` alone is not enough anyway, since it
  only steps past names that EXIST ON DISK and a claimed name hasn't been written yet.
- Keyed case-insensitively: `IMG_1.JPG` and `img_1.jpg` are one file on Windows.
- Per §8 the phone transports can't be driven in WSL, so the DECISION is a pure helper tested
  directly — the branch, not the device. `test/phone-name-collision.test.mjs` (5), including the
  resume guard and a wiring assertion that the raw `path.join` is gone.
- **Still open on this bug:** the MTP/`pullInto` sites (05-windows-phone.js ~267/278) build dest paths
  the same way. They were left because the sim branch is not the real transport and the MTP path
  needs a device to verify end-to-end; route them through `claimPullDest` when someone can test on
  hardware.

### 2026-07-18 — The footage copy fsync'd the bytes but not the NAME (audit #19)
- `stageVerifiedCopy` does copy → `flushToDisk(tmp)` → full verify → `rename(tmp, dest)`. The bytes
  were durable; the **directory entry that names them** was not. A power loss after the rename can
  leave that entry unwritten — the file is gone even though its contents reached the platter — and
  `moveFileCrossDevice` deletes the source immediately after, so it was the only copy.
- **`writeJsonAtomic` has fsync'd its directory since the store work. The FOOTAGE path never got the
  same guarantee.** That is the fourth instance this session of "a guard exists on one path and not
  its sibling" (#16 preflight, #10 storeReadFailed, #26 tagging, now this) — and this time on the one
  path where losing a write is unrecoverable. It is worth actively grepping for the pattern rather
  than waiting to trip over it.
- Both rename sites are covered: `stageVerifiedCopy` (cross-device / verified copy) and
  `moveFileCrossDevice`'s **same-device fast path**, which is a bare rename and is the one that
  deletes the source.
- **Order matters and is asserted**: the flush must follow the rename. Flushing before it durably
  records a directory that does not yet contain the file — the guarantee inverted.
- **Best-effort by design, and the limit is honest: Windows cannot fsync a directory handle through
  Node, so this is a no-op there.** It genuinely closes the window on NAS/ext4/APFS; on Windows the
  window remains open and is now documented rather than silently assumed shut. Making it throw would
  break every copy on the platform the app actually ships to.
- Test: `test/copy-dir-durability.test.mjs` (5). Durability itself needs a power cut, so what's
  asserted is that the primitive exists, is invoked after the rename on both paths, never throws on
  a bad path, and — the regression guard — that `stageVerifiedCopy` still produces a byte-correct
  file with no `.part` left behind.

### 2026-07-18 — The tool naming path skipped the name cleanup the legacy path guarantees (audit #24)
- `cleanNameField()` is what turns a generic crowd word into the person face recognition already
  identified: "two men repairing mower" → "josiah-repairing-mower". The legacy path runs its fields
  through it; the tool path returned `{ ...r.result }` raw. **Reproduced exactly**: with Josiah
  recognised, the tool path produced `two-men-repairing-mower` — the precise failure all the
  shoot-context work exists to fix, coming straight back through the new path.
- Same family as §2's "the two filing paths must behave identically": two NAMING paths, one
  deterministic post-process, applied to only one of them.
- **DESCRIPTION ONLY, and this distinction matters.** The subject is schema-constrained to one of his
  EXISTING subjects — it is an identity, not prose. Injecting a person's name into it would invent a
  subject he doesn't have and fragment the library. The legacy path cleans both because there the
  subject is free-form. Blindly copying "the legacy path cleans both fields" would have been a bug.
- Applied at result assembly rather than inside `set_clip_name.run()`, because that's where the
  recognised people are in scope — and where the legacy path applies it too.
- **Not a §8 prompt/tool-string change**: it applies an existing deterministic transform to the other
  path's OUTPUT. The model's input is untouched, so nothing needs re-measuring.
- Two things the test harness taught, worth reusing: `ai:nameFromObservation` is the channel (not
  `ai:nameWithTools`), and a stub must answer Ollama's `/api/tags` + `/api/show` capability probes or
  the handler correctly refuses with "No tool-capable reasoning model installed". Also, the loop's
  protocol guard is real — `set_clip_name` `requires: ['get_shoot_context']`, so a stub has to walk
  the true prerequisite order. That guard working is #25's design doing its job.
- Test: `test/ai-tool-name-cleanup.test.mjs` (4), transport stubbed — no Ollama, no GPU.

### 2026-07-18 — The clip filter counted the DOM, not the data (audit #50; #42 found already fixed)
- The rename list renders in 100-clip chunks. `applyClipFilter` tallied `shown` by walking
  `.rename-card` elements, so on a 3000-clip card a filter matching 50 clips reported **"2 of 3000"** —
  whatever happened to have scrolled into view. Verified against the real renderer: with clips in
  state and no cards rendered it said "0 of 5" for three matches.
- **That reads as "your search found nothing" when it found plenty** — the same trust failure as #40,
  one screen over. Count from STATE (which knows every clip); keep walking the DOM only for
  visibility, since only rendered cards HAVE visibility.
- **The rendering half needed no fix, and it's worth knowing why:** hidden non-matching cards collapse
  the list, which keeps the bottom sentinel inside the IntersectionObserver's 900px margin, so chunks
  keep pulling until enough matches fill the view. `renameEnsureRendered` covers the jump case. Only
  the count was lying — check whether a windowing bug is real before rebuilding the windowing.
- **#42 (the "Remember" tick that no-ops) was ALREADY FIXED but had no test** — the code carries an
  explicit `#42:` comment and now reports both outcomes. Backfilled `test/remember-feedback.test.mjs`
  (3) rather than leaving a §5 violation in place. That's the FIFTH backlog item this session found
  already-done or misdescribed (#38, #10-as-written, #6/#7 text, #12, now #42) — the audit text is
  from 2026-07-17 and the code has moved under it.
- `test/batch-rename.test.mjs` pinned the local `const ok = clipMatchesFilter(c)`, which I inlined.
  Updated to pin the INTENT it names ("one predicate, so what you SEE and what a bulk action TOUCHES
  cannot disagree") — now asserting both uses go through it. Second time this session a test pinned an
  incidental detail rather than its own stated intent.
- Test: `test/e2e/clip-filter-count.e2e.mjs` (4), against the real renderer with 250 clips.

### 2026-07-18 — The "no real home" warning had been dead since it was written (audit #40)
- The Apply dialog counted `clips.filter((c) => !placement[c.key])` — clips with NO placement. But
  `recomputeAuto` **always** assigns one: a clip it can't place gets `<category>/_Unsorted`. So the
  count was permanently 0, the warning never rendered once, and low-confidence clips filed silently
  into real `_Unsorted` folders in his Projects tree.
- **This is a TRUST bug, not a cosmetic one.** PROMPT.md §1: the app has failed if Jake has to
  re-check every clip. Silently doing the exact thing it promised to warn about is what forces him
  to. Worth generalising: a guard whose condition can never be true is worse than no guard, because
  the reassuring text is still sitting there being read.
- Fix: `unplacedCounts(clips, placement)` — a module-level helper (extracted so it's *testable*; the
  original was a one-line expression buried in a closure) counting both unplaced clips and
  `_Unsorted` placements. The dialog now names whichever destination actually applies; it used to say
  "misc" while the clips landed in `<category>/_Unsorted`, sending people to look for a folder that
  was never created.
- **The `_Unsorted` match is ANCHORED to the trailing leaf** (`/(^|\/)_Unsorted$/i`), so a genuine
  project called "Unsorted Beach Day" isn't swept into the warning. A warning that cries wolf on
  normal runs stops being read — which would be worse than the silence it replaces. There's a test
  for exactly that case.
- `test/flow-gaps.test.mjs` pinned the literal `will go into <b>misc</b>`; updated to assert the
  INTENT it describes ("calls out the clips with no real home") plus the new helper. Pinning a
  user-facing string means any improvement to that string reads as a regression.
- Test: `test/e2e/organize-unsorted-warning.e2e.mjs` (5) — calls the real renderer helper, plus a
  wiring assertion that the dead check is gone.

### 2026-07-18 — The naming phase was the one AI step with no timeout (audit #23)
- `aiCallGuard` wrapped aiImprove and both aiPerceive calls; the NAMING step
  (`aiSuggestClip` → `aiNameWithTools`) was bare. The tool loop is `maxSteps: 5` with a 120 s
  per-call timeout, so one wedged clip could hold the batch ~10 minutes and then fall through to the
  legacy `aiSuggest` for another 180 s. On a 200-clip card that is how a run appears to "just stop".
- **Three batch loops needed it, not two.** Besides the multi-pass and single-pass naming loops there
  is a third — "name any clips that have no subject yet" — which runs over every unnamed clip, so an
  unbounded call there stalls exactly the run it exists to finish. **The test found that site; I had
  only planned to fix two.** Worth generalising: when guarding a call, grep for every call of that
  function rather than fixing the ones the audit happens to name.
- **300 s, deliberately LOOSER than the 200 s perceive guard.** Naming legitimately takes several
  tool steps, and a guard that skips clips which would have succeeded is worse than the stall it
  prevents. There's a test asserting the naming bound stays ≥ the perceive bound, so a future
  "tidy the timeouts" pass can't quietly invert them.
- Left the INTERACTIVE single-clip path unguarded on purpose: a user who clicked one clip is watching
  and can cancel, and cutting them off at 5 minutes would be a regression, not a fix.
- Known limitation, stated so nobody assumes otherwise: `aiCallGuard` stops WAITING, it does not
  CANCEL — the underlying request keeps running in main. That matches how perceive/improve behave.
  True cancellation is audit #78 (Ollama requests aren't abortable) and is a separate job.
- Test: `test/ai-naming-guard.test.mjs` (4). Source-level, because the batch loop lives inside a modal
  flow with GPU/model state the vm harness can't drive — same approach `face-scenes.test.mjs` uses.
  It includes a guard against passing vacuously if the file is ever restructured.

### 2026-07-18 — The tool-calling brain ran at Ollama's 4096 default (audit #21/#22)
- `ollamaChat` sent `options: { temperature }` and nothing else, so **every** tool-calling request ran
  at Ollama's 4096-token default — while `pickNumCtx()` sat in the same file, wired into
  `ollamaGenerate`, existing precisely to prevent the `exceed_context_size_error` this causes. A tool
  loop GROWS every step (each tool result is appended to `messages`), so the ceiling was hit LATE and
  mid-batch: the worst way for it to fail, and it looks like a model problem rather than a config one.
- The **tool schemas** are measured too. They ride in the same body and consume the same window, so
  sizing from messages alone under-counts exactly when a big toolset is in play.
- #22: `runToolLoop` awaited `ollamaChat` with no try/catch, so one transient 400/500 threw straight
  out — even though every other failure in that loop degrades gracefully and its own doc comment
  promises it "rather than crashing the run". Now returns `{ ok:false, reason:'transport_error',
  trace }`, keeping the trace so a late blip doesn't discard the reasoning already established.
- **These are TRANSPORT-CONFIG and ERROR-HANDLING changes, not prompt or tool-string changes** —
  §8's "tool strings are measured input" rule does not apply and no re-measurement is needed. Worth
  being explicit about, because the AI area is otherwise mostly hands-off.
- **Adding a new failure `reason` means auditing who reads it.** One caller already degraded any
  `!r.ok` to `action:'ask'` (correct). The other reported it as *"The model never settled on a name"*
  — blaming the model for an infrastructure failure and sending Jake to debug prompts instead of the
  server. It now names the real cause. A new return shape is only half-shipped until its readers agree.
- Two of my test expectations were wrong, not the code: `pickNumCtx` floors at 4096 (so a small
  toolset can't move it) and clamps to `config.ai.numCtxMax` (8192 default) — the clamp is deliberate,
  since an override bigger than the 6 GB card can hold would OOM (`usb-app-single-gpu-rule`).
- Test: `test/ai-chat-context.test.mjs` (6), transport stubbed — no Ollama, no GPU.

### 2026-07-18 — "Run" filed footage but learned nothing from it (audit #29)
- Only the map's "Apply" called `ledger:record`. Step-3 **Run** (`finalize:run`) filed clips and
  recorded NOTHING — so every shoot filed that way taught the app nothing. That matters more than it
  sounds: the ledger is what lets a later import from the same shoot be offered the same project,
  and the shoot DATE is the strongest signal this app has (`usb-app-shoots-in-batches`). Two filing
  paths disagreeing is exactly the divergence §2 calls the root of the scariest bugs.
- Fix follows the #37 shape: extract `recordLedgerEntries()` so **one function owns the ledger
  write**, call it from the `ledger:record` IPC (Apply) and directly from `finalize:run` (Run).
  Same writer → the two paths cannot drift, which is the actual defect being repaired.
- **Ordering is load-bearing:** Run records AFTER `config.lastOrganize` is stamped, because
  `reverseLastLedger` only reverses a delta whose `ts >= lastOrganize.ts`. Record first and undo
  would silently refuse to take it back — a Run-filed project would become unremovable memory.
  There's a test asserting that ordering, not just the recording.
- **Verified as a real reproduction, not a broken test.** The first run of these tests failed
  because the payload shape was wrong (`finalize:run` takes `items` / `organizeDest` / `options` —
  NOT `dest`/`opts`), which looks identical to a reproduction. After fixing the payload I disabled
  the new recording line and re-ran: 3 fail, 4 pass with it. Do this whenever a test goes green
  first try — a failing test proves nothing until you know WHY it failed.
- Tests: `test/finalize-ledger.test.mjs` (4), including a cross-path test that Run and Apply produce
  the same record shape. If those ever diverge, #29 is back in a new costume.

### 2026-07-18 — Naming a face only tagged what was on screen (audit #26/#27)
- `tagClips()` resolves a cluster's clipKeys through `byKey`, built from `state.scannedFiles`. A
  cluster restored from `faces-pending.json` legitimately references clips from EARLIER sessions —
  already renamed, already filed — and those keys just miss the lookup. Confirming a persisted face
  therefore tagged **zero** of its other-session clips, silently. #27 is the same hole from the other
  end: retag ran on rename/merge/reassign but never on a first-time `assign()`, so a newly-named
  person was never written onto footage organized before they had a name.
- **The renderer could not fix this alone — the clips aren't in memory to fix.** That's the shape
  worth noticing: when a renderer-side loop "skips" items, ask whether the missing items exist at
  all in that layer, or whether the operation belongs in main. New `clips:tagPerson` (name + keys)
  writes straight into finalMeta + renameDrafts, modelled on `clips:retagPerson`.
- Deliberately **add-only and idempotent**: it never removes a person, never duplicates on a
  re-confirm, and **never creates a record for an unknown key** — a cluster can reference a clip
  whose record was pruned, and resurrecting a stub carrying nothing but a person is worse than the
  missing tag. `tagClips` sends EVERY cluster key (not just unresolved ones) precisely because the
  handler is idempotent, which also repairs in-memory clips whose persisted record lagged.
- Same sidecar trap as `clips:retagPerson`, worth repeating: persist with `saveStore('finalMeta')` /
  `saveStore('renameDrafts')`. A plain `saveConfig()` STRIPS those from config.json and never writes
  the sidecars, so the tag would vanish.
- Tests: `test/clips-tag-person.test.mjs` (6, incl. a **wiring** assertion — the handler is useless
  if nothing calls it, and "nothing called it" was the entire bug) + `test/e2e/faces-tag-offscreen.e2e.mjs`
  (2, real app, a clip present in finalMeta and absent from `state.scannedFiles`).
- Two testing notes: values crossing the vm boundary carry the SANDBOX's `Object.prototype`, so
  `deepEqual` fails on identity alone — use `app.plain()` (cost a confusing failure here, and it's
  already documented in §7a). And `tagClips` is a closure inside `showFaceReviewGrid`, so it cannot
  be invoked from a test — its wiring is asserted by source inspection, the same approach
  `face-scenes.test.mjs` takes.

### 2026-07-18 — Face thresholds: measured, named, and one of them deliberately left alone (#91, #13)
- **Measurement first, because these are tuned numbers** (usb-app-tool-strings-are-input applies to
  recognition distances as much as to prompts). Ran real face-api detection on the fixture (three
  genuinely different people) and printed pairwise `faceDist`: **0.6028 / 0.6511 / 0.7116**. So the
  0.50 cluster-merge threshold has ~0.10 of margin on that sample — **audit #13 does NOT reproduce
  on any data available here**, and lowering 0.50 blind was therefore refused per §7.
- What WAS wrong is structural (#91): the same conceptual distance was a bare literal at five call
  sites (0.45 once, 0.5 four times), sitting next to the already-named FACE_CONFIRM/SUGGEST pair and
  free to drift from it. Now `FACE_CLUSTER_DIST` / `FACE_FRAME_DEDUPE_DIST`. Zero behaviour change —
  the face e2e still passes on real detection — but a future retune is one edit instead of five.
- **The asymmetry is the thing to remember, and it's now written where the constants are:** a bad
  MERGE is expensive (confirming the fused card tags BOTH people and poisons that person's training
  set — only confirmed faces vote, so it compounds); a bad SPLIT is cheap (two cards for one person,
  name both). Clustering at 0.50 being LOOSER than auto-tag at 0.46 is backwards for that reason.
- **The experiment a future session needs**, since the fixture can't settle it: take clips with two
  similar-looking family members (Jake shoots siblings — that's where 0.50 is suspect), print
  `faceDist` for those pairs, and only then move the number. Do NOT "tighten it to be safe" — that
  fragments one person into many cards, which is the opposite failure.
- Tests: `test/face-thresholds.test.mjs` (3) pins the measured values, keeps confirm<suggest, and
  fails if a bare literal creeps back beside a `faceDist` call. It deliberately does NOT assert
  "clustering ≤ auto-tag" — that's an aspiration that would fail today. `face-scenes.test.mjs` was
  pinning the literal `< 0.5`; updated to the constant, since its real intent is the DESCRIPTOR
  lookup (not the number), which now has one home.

### 2026-07-18 — Intake had no free-space preflight; organize did (audit #16)
- `copy:start` already summed every file into `totalBytes` for the progress bar but never compared
  it to the destination's free space, so a 60 GB card into a 40 GB disk ran to ENOSPC somewhere in
  the middle: half-imported card, truncated clip in intake, full system disk — and you find out at
  the worst possible moment. The ORGANIZE path has had exactly this check for a while; **intake, the
  first thing in the app that writes anything, did not.** Worth noting as a shape: when a guard
  exists on one write path, ask which other write paths were never given it.
- Fix mirrors the organize preflight deliberately (same 2 GB headroom, same phrasing, same
  don't-block-if-the-volume-is-unreadable stance) rather than inventing a second pattern.
- **It reuses `totalBytes` instead of re-stat'ing every source.** That number came from the scan and
  the progress bar already trusts it, so there is no new I/O on a card of thousands of clips. This is
  legitimate *because the preflight is advisory* — it exists to avoid a mid-copy failure, it is NOT a
  safety gate, so it must never be the reason a real import is refused. Missing size counts as 0;
  an unreadable volume skips the check.
- The regression test that matters is the negative one: a normal import must still run. A preflight
  that mis-computes would refuse every card, which is worse than the bug it fixes.
- No renderer change — verified, not assumed: the copy caller already branches on `!res.ok` and
  renders `res.error` (`src/mod/09-phone-finalize.js`). Test: `test/copy-freespace.test.mjs` (3).

### 2026-07-18 — Audit #12 was NOT a bug: drafts already survive a quit (negative result)
- The claim: the renderer's 600 ms draft debounce plus a `before-quit` that never asks the renderer
  to flush = the last renames are lost on quit. The existing `beforeunload` flush fires an **async**
  `drafts:save` invoke during teardown, which looked unreliable.
- **It isn't. Measured, not reasoned:** a two-launch e2e types a name, calls `scheduleDraftSave()`,
  quits immediately (well inside the debounce), relaunches against the same `APPDATA` and reads the
  store back — the draft is there. A graceful quit (tray Quit → `app.quit()`) unloads the window and
  main still services the invoke before exit.
- I built the "fix" first (a `drafts:saveSync` sendSync path) and only then wrote the reproduction —
  wrong order, and it cost the whole detour. **The test passed identically with the fix reverted**,
  which is the only reason the mistake surfaced. Reproduce FIRST; a test that passes before your fix
  is telling you something.
- The sendSync version was therefore dropped: no measurable benefit, and it adds a way for a wedged
  main process to hang the quit. **What was kept** is the `writeDrafts()` extraction — the async
  handler now delegates to one owner, so the non-destructive upsert and the never-evict-a-named-draft
  pruning can't drift if a second writer is ever added.
- **The genuinely unprotected case is a HARD kill** (SIGKILL / power loss / taskkill), where
  `beforeunload` never runs and no flush of any kind can help. Shrinking the 600 ms debounce is the
  only lever there, and it is not obviously worth the write amplification on a 3000-clip session.
- Tests: `test/e2e/drafts-quit-flush.e2e.mjs` (2) — kept as a REGRESSION guard, since "drafts survive
  a quit" is now an asserted property rather than an assumption. A note in `src/mod/01-core.js` warns
  against re-fixing this without a reproduction.

### 2026-07-18 — The same store-read fail-open, a second time — now renderer-side (audit #10)
- `ensureFaceScenes()` did `catch { faceScenes = []; }` and then set `_scenesLoaded = true`
  **on the failure path**. So one rejected IPC became "there are no group shots", the latch stopped
  it ever retrying, and the next `saveFaceScenesNow()` — which REPLACES the whole store — wrote `[]`
  over every saved group shot. `loadPendingFaces()` had the identical `catch { list = []; }`, wiping
  the unreviewed faces waiting from every other card.
- **This is the 2026-07-09 lesson repeating in a new place.** That entry is about `readJsonRetry`
  returning null for both "absent" and "corrupt", so a truncated `people.json` read as a fresh
  install and the next save destroyed the face database. Main got a `storeReadFailed` latch that
  refuses to write. These two renderer-side loads were never brought behind the same invariant —
  which is exactly what PROMPT.md §2 warns about: *"Data-safety invariants apply to ALL stores."*
- Fix mirrors main: on a failed read do NOT latch (so a later call retries) and set a
  `*_LoadFailed` flag that `saveFaceScenesNow` / `savePendingNow` / `schedulePendingSave` refuse to
  write through. Run on empty defaults so the UI still works; just never persist them.
- **Scope check worth repeating before "fixing" a REPLACE-the-store handler:** the scan path was
  already safe — it does `clusters = await loadPendingFaces()` then merges, and `ensureFaceScenes`
  is cumulative. And main's `storeReadFailed` already covers the CORRUPT-FILE case. The real
  remaining hole was an IPC-level failure, where main's store is perfectly healthy and would
  happily accept the wipe. Read the merge path before assuming a wholesale replace is the bug.
- Test: `test/e2e/faces-store-failopen.e2e.mjs` (3, real app + real stores) — reproduced the wipe
  (2 scenes → 0) before the fix. The third test is the one that matters long-term: a HEALTHY load
  must still save, or face review silently stops persisting anything.

### 2026-07-18 — The same-card delete guard could be bypassed by how a path is SPELLED (audit #15)
- The gate's most important refusal — *"the copy is on the same card as the original"* — was reached
  only through a DRIVE-LETTER comparison, and the removability probe behind it was letter-based too:
  `isOnRemovableVolume` did `if (!target) return false`, declaring any path without a drive letter
  **not removable**. A `\\?\Volume{GUID}\…` card therefore read as "not a card", the guard never
  fired, and the gate could delete the original while the only copy sat on the card about to be wiped.
- **The tell was an inconsistency inside one function:** the very next line already failed CLOSED
  (`catch { return true }` — "can't list drives → don't move off it"). Unknown-because-no-letter and
  unknown-because-the-lookup-threw are the same ignorance; they now make the same call. When one
  branch of a safety check fails closed and its neighbour fails open, the open one is the bug.
- Two changes: (1) `classifyRemovable(p, drives)` — a PURE primitive (drives passed in) so the delete
  gate's key refusal is testable with no card in a slot; unknown → removable, but a UNC `\\server\share`
  is still `false` (blanket fail-closed would refuse organizing onto the NAS with a nonsense "that's
  a card" message). (2) A **volume-identity** check in `verifyCopyPair`: `ss.dev === ds.dev` is what
  the OS reports, so it sees through path spelling entirely.
- The `st.dev` check is **strictly additive** — it can only refuse MORE, never fewer. That is the
  only direction this gate may ever move (§5). It's gated on the source really being removable so
  ordinary same-disk copies are untouched, and sits before the hash so a refusal costs no I/O.
- **The regression tests that matter most are the two NEGATIVE ones**: a normal internal-disk copy
  still verifies, and a genuine off-card copy still authorizes the delete. If either breaks, the gate
  has become an unconditional refusal and the app can no longer clear a card. `/dev/shm` vs `/tmp`
  gives a REAL two-device pair on this machine, so no test-only hooks were bolted into the gate.
- **STILL OPEN — a card mounted into a FOLDER** (`C:\Cards\SD1\…`) is not fixed. Both paths read as
  "C:", and `listRemovableDrives()` is enumerated by letter, so the card is not recognised as
  removable and the guard stays inert. Fixing it needs removability resolved per-VOLUME on Windows
  (`GetVolumePathName`, or WMI by device id) — **not verifiable in WSL** (no removable volume here),
  so it was NOT shipped blind per §7. Next step: extend `listRemovableDrives` to report volumes with
  no drive letter, then feed that into `classifyRemovable`.

### 2026-07-18 — ffmpeg exit 0 is not proof of a finished encode (audit #6)
- Compress trusted `code === 0` and nothing else. The old comment said it outright: *"ffmpeg exited
  0 → the encode is complete."* It isn't — given a source with a corrupt tail (or a read that ends
  early) ffmpeg writes a SHORT file and still exits 0. Nothing between there and the Compressed
  folder checked, so the staged file was renamed to its real name and organized as "done".
- **Why this one is a data-loss bug, not a quality bug:** the delete gate only compares
  card↔intake, so the card is then legitimately cleared. A short compressed clip can end up the
  ONLY surviving copy of a shot. (`skipExisting` staging already fixed the *crash* variant of this;
  the exit-0 variant survived.)
- Fix: `compressOutputVerdict(srcSec, outSec)` — probe the STAGED file and compare to the source
  duration before it earns its real name. Fails on an unprobeable output; tolerates
  `max(0.5s, 2%)` because a re-encode can land a hair short on GOP/timebase rounding. On failure
  the `.part` is discarded and the clip is reported failed — **the source is untouched, so it's a
  retry, not a loss.** No trimming exists in `buildCompressArgs`, which is what makes a straight
  duration comparison valid; if trimming is ever added, this check has to learn about it.
- **The risky direction of a guard like this is the false POSITIVE** — too tight a bound would
  start rejecting Jake's genuine encodes. So the test covers all three layers: the pure verdict, a
  REAL end-to-end ffmpeg encode that must PASS, and a really-truncated mp4 that must FAIL
  (`test/compress-verify.test.mjs`, 7 tests, real ffmpeg via `fixtures.mjs`).
- **Trap worth remembering: `probeMeta` memoises by path.** The staged path is deterministic
  (`out/.partial/<name>.mp4`), so probing the output with `probeMeta` would compare a CACHED
  duration from an earlier clip/run. Use `runFfprobeJson` (uncached) for anything at a reused path.
- No renderer change was needed, and that was verified rather than assumed: the new failure reuses
  the exact `{ok:false, error}` + `phase:'error'` shape the existing ffmpeg-failure branch emits,
  which `src/mod/10-boot.js` already renders as a "failed" chip with the error as its tooltip.

### 2026-07-18 — Undo has to reverse the MEMORY, not just the files (audit #37)
- `organize:undo` moved the filed clips back and left `config.projectLedger` untouched, so an
  undone Organize left a **phantom project**: a record still carrying the clip counts, dates and
  subjects of footage that is no longer filed there. `ledger:matchDates` / `search_projects` keep
  scoring **future** imports against those phantoms — so one bad Organize permanently poisoned
  placement. Undoing the visible half and keeping the invisible half is worse than not undoing.
- **The fix stayed entirely main-side, and that's why it covers both filing paths.** `ledger:record`
  now stashes its own reversal delta in `config.lastLedger`, and `organize:undo` calls
  `reverseLastLedger(lo.ts)`. Because the renderer already calls `ledger:record` after BOTH
  `projects:move` and `finalize:run`, neither filing path had to thread anything back — the §2
  "two filing paths must agree" trap is avoided by construction rather than by discipline.
- **It reverses a precise DIFF, never a snapshot.** `ledger:summarize` writes `summary`/`keywords`
  onto the same record *after* filing (the renderer fires it right after `ledgerRecord` returns), so
  restoring a pre-filing snapshot would silently discard the AI summary. So `ledgerMergeTracked`
  records only the values this run genuinely ADDED — a date an earlier clip also justifies survives
  the undo. There's a test that fails if anyone "simplifies" this into a snapshot-restore.
- Guards worth keeping: the delta is only reversed when `lastLedger.ts >= lastOrganize.ts` (a run
  that filed nothing to the ledger must not reach back and undo an earlier run's memory); the delta
  is consumed on use (no double-reverse); `rec.clips` clamps at 0 (the 8000-name cap can already
  have evicted some of what the run added).
- Tests: `test/ledger-undo.test.mjs` (6, vm) + `test/e2e/organize-undo.e2e.mjs` (full stack —
  seeded stores → real `undoLastOrganize()` → real dialog → real IPC → real ledger store).

### 2026-07-18 — E2E: you cannot stub `window.api`; seed the stores instead
- `window.api` comes over `contextBridge`, and every method is **`writable:false, configurable:false`**.
  Assignment fails silently and `Object.defineProperty` throws, so a test that "stubs an IPC call"
  actually runs the real one and then asserts against the wrong thing. Verified by reading the
  property descriptor, after a stubbed test failed in a very confusing way.
- **Drive the real path instead:** `launchApp({ seed: { 'config.json': …, 'project-ledger.json': … } })`
  writes those files into the isolated store dir before boot, so the app loads genuine state and the
  real IPC handler runs. This is strictly better than stubbing — it tests main + renderer together.
- Two traps that cost time: seed **`firstRun: false`** or the first-run setup wizard owns the modal
  layer and your `.modal-card` selector matches *its* card; and **click confirm buttons through the
  DOM** (`.cd-ok`), not with a real mouse click — the overlay intercepts pointer events and
  Playwright retries until it times out (smoke.e2e.mjs already carried this warning).
- `read(win, expr)` wraps the expression in a **non-async** arrow, so `await` inside it is a syntax
  error. Just return the promise (`window.api.ledgerGet()`) — Playwright resolves it.

<!-- ### YYYY-MM-DD — next lesson goes above this line -->

