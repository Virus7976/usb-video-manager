# Releasing & build runbook

Everything needed to **build, test, and publish a working Windows version** of USB SD
Auto-Action — and to set that up from scratch on a brand-new machine. This file is the
source of truth; the Gitea **Wiki** mirrors it for convenience.

> TL;DR — on a configured Windows machine:
> ```powershell
> $env:GITEA_TOKEN = "<token>"
> npm run release            # or: npm run release patch|minor|major|x.y.z
> ```
> That bumps the version, updates the changelog, syntax-checks, builds the installer,
> verifies it, tags & pushes, and publishes both Gitea releases. Installed apps then
> self-update.

---

## 1. One-time setup on a new machine

You build the Windows installer **on Windows** (electron-builder stamps the `.exe` with
tools that need Windows or wine — a bare Linux/WSL checkout can edit code but can't produce
a faithful installer). Editing/coding can happen anywhere (incl. WSL); **building/releasing
happens on Windows**.

1. **Install Node 20** (the version is pinned in `.tool-versions` → `nodejs 20.20.2`).
   - With [asdf](https://asdf-vm.com/): `asdf install nodejs 20.20.2`
   - Or install Node 20 LTS from nodejs.org. (`package.json` `engines` requires `>=20`.)
2. **Install ffmpeg + ffprobe** and put them on `PATH` (needed to *run* the app; not needed
   just to build).
3. **Clone the repo:**
   ```powershell
   git clone https://gitea-gour.jakegour.com/liamgour/USB-Video-Downloader.git
   cd USB-Video-Downloader
   npm install
   ```
4. **Create a Gitea access token** for publishing (one-time):
   - Gitea → your avatar → **Settings → Applications → Generate New Token**.
   - Scopes: **`write:repository`** (create releases + upload assets). `read:repository`
     is not enough.
   - Copy the token; you won't see it again.
5. **Make the token available to the release script.** It's read from the `GITEA_TOKEN`
   environment variable — the script never stores or prints it.
   - PowerShell (current shell): `$env:GITEA_TOKEN = "paste-token"`
   - PowerShell (persist for your user): `setx GITEA_TOKEN "paste-token"` (re-open the shell)
   - bash/zsh: `export GITEA_TOKEN=paste-token`

That's it. Verify with a no-op dry run (builds nothing, changes nothing):
```powershell
npm run release:dry
```

---

## 2. Cutting a release (the normal path)

```powershell
npm run release            # release the version currently in package.json
npm run release patch      # bump 0.2.0 -> 0.2.1, then release
npm run release minor      # bump 0.2.0 -> 0.3.0, then release
npm run release major      # bump 0.2.0 -> 1.0.0, then release
npm run release 1.4.2      # set an explicit version, then release
```

`npm run release` (`scripts/release.mjs`) runs this loop and stops at the first failure:

1. **Preflight** — checks the working tree is clean (only `package.json`/`CHANGELOG.md` may be
   dirty), that `GITEA_TOKEN` is set, and warns if you're not on Windows.
2. **Syntax check** — `npm run check` (`node --check` on main/preload/renderer/watch-drives)
   + validates `config.json` parses.
3. **Bump** — writes the new version into `package.json` and promotes the `CHANGELOG.md`
   `[Unreleased]` section to `[x.y.z] — <date>` (leaving a fresh empty `[Unreleased]`).
4. **Build** — `npm run build:win` → `dist/USB-SD-Auto-Action-Setup-x.y.z.exe`,
   its `.blockmap`, and `latest.yml`.
5. **Verify** — confirms all three artifacts exist and that `latest.yml`'s version matches.
6. **Commit / tag / push** — commits `release vX.Y.Z`, `git pull --rebase`, tags `vX.Y.Z`,
   pushes the branch **and** the tag.
7. **Publish** — creates two Gitea releases from the one build (see §3).

Flags:
- `--dry-run` (`npm run release:dry`) — validate + print the plan; build/commit/publish nothing.
- `--skip-build` — reuse an already-built `dist/` (e.g. you built once, publish failed).
- `--no-publish` — build + tag + push, but don't upload to Gitea.
- `--yes` / `-y` — skip the confirmation prompt (for automation).

---

## 3. How auto-update works (why "publish" = users get it)

The installed app updates itself with **electron-updater**. There is no GitHub-style moving
"latest" asset URL on this Gitea, so we use a **fixed-tag release** as the feed:

- `package.json` → `build.publish` is a **generic** provider pointing at
  `…/releases/download/latest`. electron-builder bakes that URL into the app and emits
  `latest.yml`.
- Every release, `release.mjs` publishes **two** Gitea releases from the same build:
  - **`vX.Y.Z`** — the permanent, human-facing archive.
  - **`latest`** — recreated each time (old one deleted, new assets uploaded). The installed
    app polls `…/releases/download/latest/latest.yml`, sees the new version, downloads the
    `.exe` in the background, and installs it on quit.
- In the app (`main.js` → `setupAutoUpdates`): checks ~8s after launch and every 6h, **only**
  when `app.isPackaged && process.platform === 'win32'` (a no-op in dev / non-Windows, so
  `npm start` and CI never hit the network). Users can also use the tray menu:
  **Check for updates…** / **Restart to install update**.

So after `npm run release`, existing installs update themselves within ~6h (or on next
launch) — no manual re-download.

---

## 4. CI is a backstop, not a builder

`.gitea/workflows/release-check.yml` runs on every `v*` tag. It does **not** build (the Linux
runner has no wine). It re-checks that the tag is internally consistent and was actually
published: syntax, `config.json`, tag == `package.json` version, a `CHANGELOG.md` entry
exists, the `build.publish` feed is configured, and **both** the `vX.Y.Z` and `latest`
releases exist on Gitea. If the check is red, the tagged commit is broken — fix and re-release.

`.gitea/workflows/ci.yml` does the same syntax/config checks on every push to `main` and PR.

---

## 5. Verify a release worked

1. **CI** — the `Release check` action for the tag is green.
2. **Releases tab** — both `vX.Y.Z` and `latest` exist, each with the `.exe`, `.blockmap`,
   and `latest.yml` attached.
3. **Feed reachable** — `…/liamgour/USB-Video-Downloader/releases/download/latest/latest.yml`
   downloads and shows the new version.
4. **Real install** — run the new `Setup .exe` (silent: `… /S`). Confirm the footer/About
   shows the new version. Substring-check the asar at
   `%LOCALAPPDATA%\Programs\USB SD Auto-Action\resources\app.asar` for your change.
5. **Auto-update** — on a machine with the previous version installed, leave it running; within
   ~6h (or via tray **Check for updates…**) it should download and offer to restart.

---

## 6. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `GITEA_TOKEN is not set` | Export it (see §1.5), or run with `--no-publish`. |
| `Gitea POST … → 403` | Token lacks `write:repository` scope, or isn't a collaborator. |
| `release vX.Y.Z already exists` | That version was already published. Bump first (`npm run release patch`). |
| `missing build artifact …` | The build failed, or you ran `--skip-build` against a stale/old `dist/`. Rebuild. |
| `latest.yml version is … expected …` | Stale `dist/`. Re-run without `--skip-build`. |
| Build fails on Linux/WSL | Expected — build on Windows (or under wine). |
| `winCodeSign` symlink permission error (Windows) | Enable Developer Mode, run the build elevated once, or pre-extract the winCodeSign cache. |
| App never updates | Confirm it's the **packaged** Windows build; check the `latest` release exists and `latest.yml` is reachable; look at the app's console for `[update]` lines. |

---

## 7. Manual fallback (if the script can't run)

```powershell
npm run check
npm run build:win
# then, in Gitea → Releases → New release:
#   tag vX.Y.Z, attach dist/USB-SD-Auto-Action-Setup-X.Y.Z.exe + .blockmap + latest.yml
#   then edit the "latest" release: delete its old assets, attach these three.
```
The script automates exactly this; do it by hand only if necessary, and keep the `latest`
release's assets in sync or auto-update breaks.
