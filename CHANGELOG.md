# Changelog

All notable changes to this project are documented here. Keep this updated alongside
[`AGENTS.md`](AGENTS.md) on every meaningful change.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [0.4.4] — 2026-07-01

### Added
- **"You've got footage to deal with" on the home screen.** When you open the app, a
  banner now surfaces footage waiting in the Uncompressed intake (still to compress) and
  clips already in the Compressed folder that are ready to organize — with a one-tap jump
  straight into Organize & back up. The per-clip AI analysis is already remembered, so
  nothing re-analyzes. First step toward a frictionless Auto mode: the app remembers your
  in-progress work across restarts and tells you what's left instead of forgetting it.

## [0.4.3] — 2026-07-01

### Added
- **Interrupted backups are now recognized as "to finish".** If a previous session
  pulled photos to Photos Temp but never finished renaming/copying/organizing them,
  those photos are no longer treated as done — they're counted as "to finish" and
  default-selected alongside genuinely new items, so nothing is silently left half-done.
  The summary now reads e.g. "N to back up · X to finish · Y backed up".
- **Already-pulled photos show real thumbnails** in the chooser grid, loaded free from
  their local Photos Temp copy (no phone access). Items still on the phone keep the
  photo/video icon — pulling files just to preview them would defeat the fast workflow.

### Changed
- **Phone videos now stage in a real "_Phone Video Temp" folder** (next to "04 - Photos
  Temp", under your Compression folder) instead of a hidden throwaway OS temp on C:.
  Because that folder is on the **same drive as the intake**, moving a finished video
  into "01 - Uncompressed" is now an **instant rename** instead of a slow full copy —
  and if a video pull is interrupted it **resumes** instead of re-downloading. Videos
  already sitting in the intake at the right size are skipped on a re-run. (The staging
  copy is removed once a video is safely in the intake; the folder itself stays.)
  Real-phone video pulls continue to use ADB fast transfer when it's enabled.

## [0.4.2] — 2026-07-01

### Fixed
- **Phone scan now works when fast transfer (ADB) is on.** Previously only the file
  *transfer* used ADB; the album listing and the "what's new" scan still went through
  Windows MTP. But once USB debugging is enabled the phone often stops exposing MTP to
  Windows, so the app showed "No albums found — Nothing here" even with thousands of
  photos/videos on the device. The scan and album chips now use ADB too (one `find`
  over DCIM/Pictures/Movies/Download with sizes), falling back to MTP when ADB is off.
- Hidden folders (Android's `.thumbnails` cache, `.gs*`, etc.) are excluded from the
  scan, so you're no longer offered thousands of cached thumbnails as "photos".

## [0.4.1] — 2026-06-30

### Added
- **Wireless phone backup (no tethering).** Set a **Phone backup folder** (File → "Phone backup
  folder (wireless)…", or the link on the home screen) — point it at the NAS folder your phone
  auto-uploads to (e.g. QNAP QuMagie/Qfile). It then appears under **Devices** as a one-tap
  source, so wirelessly-uploaded photos/videos flow straight into rename → organize with no
  cable and no phone tied up.

## [0.4.0] — 2026-06-29

### Added
- **Fast phone transfer (ADB).** Phone backups used Windows' MTP, which copies one file at a
  time and can take *hours to days* for a big camera roll. You can now switch on **fast
  transfer**, which uses ADB (`adb pull`) — typically many times faster. In the phone screen,
  tap **"⚡ Turn on fast transfer"**: it downloads the small ADB tool for you (one time); then
  enable **USB debugging** on the phone once (Settings → Developer options) and tap Allow. If
  ADB isn't set up or the phone isn't authorized, it automatically falls back to the old MTP
  method, so nothing breaks.

## [0.3.3] — 2026-06-29

### Added
- **Pick up where you left off.** When you reconnect your phone, photos you'd already pulled
  to your computer earlier are recognized — they're no longer re-offered as "new," so you only
  back up what's genuinely new. The summary shows "N new · M already pulled," and Review still
  lets you re-do any of them.

## [0.3.2] — 2026-06-29

### Clearer / more intuitive
- **AI actions no longer dead-end when AI is off.** Clicking "✨ Suggest with AI", Analyze,
  summarize, etc. without AI set up now opens the "turn on AI / pick a model" helper instead
  of flashing a toast that does nothing.
- Error messages now say "please try again" instead of the scary literal "unknown".
- The destination-map's primary button reads "Pick or type a folder" until you've chosen one
  (instead of a dead-looking "File here →").
- Menus stay open a bit longer so they don't vanish if your pointer drifts.
- The AI-settings close button now reassures that your changes are already saved.

### Fixed
- **Day grouping in the rename grid now shows every clip.** Previously each day header
  showed a count (e.g. "34 clips") but only one clip appeared under it, because the list
  wasn't sorted by day — so the same day repeated all over the list. Clips are now grouped
  by day (newest first), so "34 clips" actually shows all 34 together.

### Performance
- **Faster to open + lighter saves.** `config.json` had grown to ~1.6 MB (thousands of stale
  rename drafts + oversized save-points) and was parsed at launch and rewritten in full on
  every setting change. It's now slimmed and capped, roughly halving what the app loads at
  startup and writes on each save — so it opens quicker and feels snappier.

### Fixed / hardened (from a reliability + security audit)
- **Hung video tools can't wedge the app.** ffmpeg/ffprobe calls (posters, thumbnails, face
  frames, metadata, drive detection) now self-kill if they stall on a corrupt/odd clip,
  instead of deadlocking the preview pipeline or leaking processes.
- **Temp files don't pile up.** The thumbnail/poster scratch folder is cleared on startup.
- **config.json can't bloat unbounded** — the project "memory" ledger (and the AI-memory
  inbox) are now capped like every other store, so saves stay fast over time.
- **No accidental double-copy.** Starting a copy while one is already running is refused
  (it could have corrupted progress/cancel for the first).
- **Phone "what's new" is more accurate** — a video that failed to copy stays marked "new"
  (re-offered) instead of being recorded as backed-up.
- **Security hardening** — locked down window navigation/new-windows (defense-in-depth for the
  local-file viewer); fixed a file-handle leak on copy errors. (Audit found no command
  injection or XSS — the static-PowerShell + escaping patterns hold.)

## [0.3.1] — 2026-06-28

### Fixed
- **Phone scan now actually returns your photos.** The new album-scoped scan was passing the
  chosen albums in a way PowerShell collapsed into a single bogus name, so it matched no folder
  and showed “Nothing here” even for a 2,936-item Camera roll. Fixed the parsing — selecting
  Camera (and any other albums) now scans them correctly.

## [0.3.0] — 2026-06-28

### Changed
- **Phone backup, rebuilt around "what's new".** Connect your phone and it no longer scans
  the entire device or dumps a giant grid. Instead it:
  - **Asks what to back up from** — albums are shown as chips (Camera selected by default;
    Screenshots/WhatsApp/Download/etc. with counts) and it only scans what you pick.
  - **Shows just what's new** — it remembers what you've already backed up (per file) and
    offers a one-tap **“Back up N new”**, so you stop re-copying the same photos.
  - **Review / pick manually** is still one tap away for the full grid.
- **Running backups survive leaving the app.** Pulling/copying off a phone now shows the
  persistent task bubble — leave, come back, and tap it to see progress (no more "lost" task).

### Fixed
- "Select all" on the phone grid already respected the filter (0.2.1); the new chooser
  avoids the giant grid entirely for the common case.

## [0.2.2] — 2026-06-28

### Fixed
- **Phone reading tells "empty" from "couldn't read"** — if the phone is locked, on
  "Charging only", or disconnects mid-scan, you now get a clear "Couldn't read your phone…
  unlock and choose File transfer, then Rescan" message instead of a misleading "no photos".
- **Compression won't clobber same-named clips** — two source files that share a name but
  differ in format (e.g. `clip.mov` + `clip.mp4`) now produce two separate outputs instead
  of one silently overwriting/skipping the other.
- **NAS backup during Organize is verified** — files mirrored to the NAS at the Organize step
  are now content-verified (with one retry), matching the import-step guarantee, so a
  truncated/corrupt backup is never trusted.
- **Card clips date from the filename** — capture date is taken from the filename (how cameras
  name files) instead of the file's modified time, which is unreliable after card copies.
- Minor hardening: drive-polling can't double-start; removed a dead quit-handshake code path.

## [0.2.1] — 2026-06-28

### Fixed
- **Phones now open the device you actually tap** — selecting a real phone (e.g. an S23
  Ultra) no longer jumps to the "Simulated phone (testing)" entry. The simulated phone is
  also now off unless you explicitly turn it on (it was a dev/testing leftover).
- **Slow-to-wake phones are detected** — the phone-detection timeout was raised so a freshly
  plugged-in phone that takes a while to hand-shake over USB still shows up.
- **"Select all" on a phone respects the Photos/Videos filter** — it no longer secretly
  selects hidden items, and the checkbox reflects what's actually visible.
- **Card import is safer** — clips are marked "imported" and their saved names are cleared
  only **after** the copy is verified, so a bad copy is never skipped (or its name lost) on
  the next insert.
- **Photos-only cards can be backed up** — the Copy button is no longer greyed out when a
  card has only photos and no video.
- **"Undo last organize" works from the main Organize screen** — that run now records its
  moves, so you can reverse it (previously only the destination-map flow could be undone).
- **"Check for updates…" always reports back** — a manual check now shows "up to date" / an
  error instead of silently doing nothing.

## [0.2.0] — 2026-06-28

### Added
- **Automatic updates** — the installed Windows app now updates itself: it checks the release
  feed in the background, downloads new versions silently, and installs them when you quit (or
  right away via the tray's **Restart to install update**). No more re-downloading the installer.
- **One-command releases** — `npm run release` bumps the version, updates the changelog,
  syntax-checks, builds the installer, verifies it, tags & pushes, and publishes the Gitea
  release **and** the auto-update feed in a single step (`npm run release:dry` to preview).
- **In-app compression** — ffmpeg transcode (H.264 / H.265 presets) with live per-file
  progress, skip-existing, cancel, and partial-file cleanup. Plus a **compression mode**
  setting: `external` (watch-folder tool like Tdarr — the default, zero local CPU) or `app`.
- **Mega Analyze** — one button does faces → confirm (or 🤖 Auto-faces) → describe → name →
  tag, weaving recognised people into the names and **improving** any name you already wrote.
- **Photos in the AI flow (Organize screen)** — `Include photos` lists/analyzes/files photos
  like clips; face recognition now runs on still images; XMP embedded into JPGs.
- **🎬 Sort with me** — guided organize chat: watch a clip, say where it goes (tap or type),
  and it learns a filing rule so it stops guessing.
- **Global task UI** — a small task bubble → popup → full-screen "theater" with a live
  thumbnail conveyor, a per-step activity feed, ETAs, and cancel.
- **⚡ Quick analyze** — one vision call per subject (copied to siblings); ~minutes instead of
  hours on big batches. Resumable (skips already-analyzed clips).
- **Faces are confirm-first** — recognised faces are suggestions saved unconfirmed to a
  person's profile; you confirm/correct (type a name or tap a suggestion). Never auto-applied.
- **Data safety** — checksum verify before delete, NAS mirror with verify/resume, undo/move-log
  for filing, duplicate/already-imported detection, a session activity log.
- **Phone (MTP) import** — list/scan/copy photos & videos off a phone with no drive letter.
- **First-run setup wizard** (issue #1) — a guided onboarding modal that opens automatically on
  the first launch: point your **intake folder**, **Projects root**, and an optional **NAS
  backup**, pick/enable a local **AI vision model** (with a Browse-&-download shortcut), and run
  a **face-recognition check** — then hands off to the tour. Re-runnable anytime from
  **Help → Setup wizard…**, the Settings hub, and the command palette.

### Changed
- **Organize, rebuilt as one screen.** The destination map is now a single **Plan** view that
  groups every clip by where it'll be filed, shows **how confident** each placement is and
  **why**, and floats the few it's unsure about into a **“Needs you”** section you fix inline
  (one-tap destination chips + “remember” to make it a rule) — then **File**. The old
  button-bar-of-modals (Sort with me / Suggest with AI / Filing rules / Refine) folds into one
  primary **✨ Suggest with AI** action + a **More** menu, with a **Folders** toggle for the full
  colour-coded tree. Much less “pile of separate features”.
- **Smarter placement.** Suggestions now use your **filing history**: the app remembers every
  project it's filed footage into (people, subjects, places, an AI summary) and both pre-files
  obvious repeats automatically (“matches your *Lawn Mowing* shoot”) and feeds that memory to
  the AI — so it reuses the right existing project instead of guessing from a blank slate.
- **Better destination picks + honest confidence.** When you have many projects, the app now
  shows the AI a **shortlist ranked toward the current batch** (so the right folder is always
  in view instead of buried among hundreds), with a sharper prompt and a worked example. It
  then **calibrates each placement's confidence** from where the clip is actually going —
  brand-new or unclear destinations are marked low and routed to **“Needs you”** rather than
  auto-filed, and clips of the same subject are kept together — so fewer clips land in the
  wrong folder and the ones it's unsure about reliably ask you first.
- **Tool-grade UI polish (in progress).** Settings/Preferences regrouped into clear, consistent
  labelled sections with card bodies and a steady spacing rhythm (no more ad-hoc margins), so it
  reads like a precise settings panel rather than a flat list. (First pass of a wider polish
  sweep across the core screens.)
- Genericised for public use: no baked-in personal projects/clients, defaults derive from the
  OS Videos folder, dev-only phone simulation off by default.
- Renamed the misleading "Compress, Rename & Delete" home action to "Import, Rename & Clear card".
- Suggest-with-AI asks far fewer questions (auto-accepts confident folder matches); typed
  categories autocomplete and register in one step.
- **Teaching a filing rule is now reliable.** When you describe a rule in plain English
  ("vlogs are their own thing, but timelapses go with the shoot"), the app no longer relies
  on an easily-flipped yes/no flag — it reads an explicit choice ("each day = its own
  project" vs "joins the day's project"), so it stops occasionally doing the exact opposite
  of what you said. It also splits a multi-part instruction into separate rules and won't
  treat a bare shot-type word (vlog, b-roll…) as a project folder.
- **Richer searchable metadata.** Filed clips now also get a **Places** tag branch (browse by
  location in digiKam/Lightroom, like People), and tag names containing slashes no longer
  split into bogus tag-tree levels.
- **Calmer, tool-grade motion** — pared back the celebratory/"delight" animation so the app
  reads as a precise utility. Removed the decorative progress-bar shimmer, the breathing
  "glow" pulses, and the sparkle-burst on the done screen; shortened entrances to ~120–200ms
  with standard easing (no bounce/overshoot). The task theater's frame no longer breathes and
  the thumbnail conveyor no longer flings — the moving scanline stays as the "actively
  scanning" signal. Motion now explains state instead of performing. Added full
  `prefers-reduced-motion` support (decorative loops off; functional spinners keep turning).

### Fixed
- **Filing can no longer drop or overwrite a clip.** Two different clips that happen to share
  a name and file size are now told apart by content (sampled checksum) and the second is
  safely versioned instead of being skipped. Cross-drive moves copy → **verify** → then
  delete the original, so a crash or error mid-move always leaves the source intact and never
  leaves a half-written file at the destination.

### Known issues
- Vision models can hallucinate a subject → mis-placement (use 🎬 Sort with me / manual rename).
- Photos not yet in the Step-1 Rename grid ("Path B") — Organize screen only.

## [0.1.0]
- Initial internal build: USB/SD auto-detect, rename grid, copy-to-intake, delete-from-card,
  organize/finalize with XMP embed, local Ollama naming, bundled face recognition.
