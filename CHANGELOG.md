# Changelog

All notable changes to this project are documented here. Keep this updated alongside
[`AGENTS.md`](AGENTS.md) on every meaningful change.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
