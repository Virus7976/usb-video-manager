# Changelog

All notable changes to this project are documented here. Keep this updated alongside
[`AGENTS.md`](AGENTS.md) on every meaningful change.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
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
- Genericised for public use: no baked-in personal projects/clients, defaults derive from the
  OS Videos folder, dev-only phone simulation off by default.
- Renamed the misleading "Compress, Rename & Delete" home action to "Import, Rename & Clear card".
- Suggest-with-AI asks far fewer questions (auto-accepts confident folder matches); typed
  categories autocomplete and register in one step.

### Known issues
- Vision models can hallucinate a subject → mis-placement (use 🎬 Sort with me / manual rename).
- Photos not yet in the Step-1 Rename grid ("Path B") — Organize screen only.
- No first-run setup wizard yet.

## [0.1.0]
- Initial internal build: USB/SD auto-detect, rename grid, copy-to-intake, delete-from-card,
  organize/finalize with XMP embed, local Ollama naming, bundled face recognition.
