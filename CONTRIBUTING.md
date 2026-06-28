# Contributing

Thanks for working on USB / SD Auto-Action! A few things to get you productive fast.

## Before you start — read the memory

1. **[`AGENTS.md`](AGENTS.md)** — the living project memory: architecture, conventions, key
   subsystems, and traps. Read it first.
2. **[`CHANGELOG.md`](CHANGELOG.md)** — what's changed recently.
3. The **Wiki** and **Issues** tabs for design notes and the live roadmap.

> ⭐ **Every meaningful change updates `AGENTS.md` (and `CHANGELOG.md`) in the same commit.**
> This project leans on that file as memory for both humans and AI assistants. Don't skip it.

## Dev setup

```bash
npm install
npm start          # run the app (Electron) in dev
npm run check      # syntax-check all JS (do this before every build)
npm run build:win  # build the Windows installer into dist/
npm run release    # bump + build + verify + tag + publish (see AGENTS.md §3)
```

- Electron 42, Node 20+. Windows only (uses MTP/COM, drive detection, ffmpeg). The installer
  must be built on Windows (or under wine); releasing is `npm run release` with `GITEA_TOKEN` set.
- **ffmpeg + ffprobe** must be on your `PATH` (or set in Settings) — thumbnails and
  compression need them.
- **Ollama** (optional) for AI features: `ollama pull qwen2.5vl`, then enable in Edit → AI.

## Workflow

- Renderer ↔ main process talk **only** through `window.api` (see `preload.js`). Adding a
  feature is usually: `ipcMain.handle('x', …)` in `main.js` → bridge in `preload.js` → UI in
  `src/renderer.js` + `src/index.html` + `src/styles.css`.
- **Syntax-check before building:** `npm run check` (covers main.js / preload.js / renderer.js / watch-drives.js).
- Keep the **native dark Fluent** look; keep AI **offline**; keep faces **confirm-first**; keep
  the app **generic** (no personal data). See `AGENTS.md` §4.

## Pull requests

- Branch off `main`, keep PRs focused, describe the change and how you tested it.
- Open an **Issue** first for anything large.
- Update `AGENTS.md` + `CHANGELOG.md`.

## Adding screenshots

Grab the focused app window to a PNG (Windows, no extra tools), then drop it in
`docs/screenshots/` and reference it from `README.md`:

```powershell
$dir = "docs\screenshots"; New-Item -ItemType Directory -Force $dir | Out-Null
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $bmp.Size)
$bmp.Save("$dir\my-screen.png"); $g.Dispose(); $bmp.Dispose()
```

> Avoid screens that show real client/project folder names in a public repo.
