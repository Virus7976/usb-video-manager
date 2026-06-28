# Releasing & build runbook

Everything needed to **build, test, and publish a working Windows version** — and to set it up
on a new machine. This file is the source of truth; the Gitea **Wiki** mirrors it.

**Where things live:**
- **Code, issues, PRs, wiki → Gitea** (`liamgour/USB-Video-Downloader`).
- **Installer + auto-update feed → GitHub releases** (`Virus7976/usb-video-manager`).
  Gitea's server can't host the ~130 MB installer (asset type filter + 100 MB cap + reverse-proxy
  413), so releases go to GitHub, which electron-updater supports natively. See §3.

> TL;DR — on a configured Windows machine:
> ```powershell
> $env:GH_TOKEN = "<github token>"
> npm run release            # or: npm run release patch|minor|major|x.y.z
> ```
> Bumps the version, updates the changelog, syntax-checks, commits, tags, pushes the code to
> **both** Gitea and GitHub, builds the installer, and publishes the **GitHub** release.
> Installed apps then self-update.

---

## 1. One-time setup on a new machine

The installer is built **natively on Windows** (electron-builder stamps the `.exe` with tools
that need Windows; bare Linux/WSL can edit code but can't produce a faithful installer). Editing
can happen anywhere (incl. WSL); **building/releasing happens on Windows**.

1. **Install Node 20+** (pinned `.tool-versions` → `nodejs 20.20.2`; `package.json` `engines`
   requires `>=20`). Windows: install Node 20 LTS from nodejs.org.
2. **Install ffmpeg + ffprobe** on `PATH` (to *run* the app; not needed to build).
3. **Clone the code (Gitea):**
   ```powershell
   git clone https://gitea-gour.jakegour.com/liamgour/USB-Video-Downloader.git
   cd USB-Video-Downloader
   npm install
   ```
4. **GitHub token** for publishing releases (one-time): GitHub → Settings → Developer settings →
   **Fine-grained tokens** → scope it to the `Virus7976/usb-video-manager` repo with
   **Contents: Read and write**. Provide it as `GH_TOKEN` (the release script also reads
   `~/.github-token`):
   - PowerShell (this shell): `$env:GH_TOKEN = "paste"`  · persist: `setx GH_TOKEN "paste"`
   - bash/zsh: `export GH_TOKEN=paste`  ·  or `echo 'paste' > ~/.github-token`
5. **Gitea push auth**: the normal git credential helper (the same one that lets you `git push`
   to Gitea) is all that's needed — the release script pushes code there with it.

Verify with a no-op dry run (builds nothing, changes nothing):
```powershell
npm run release:dry
```

---

## 2. Cutting a release

```powershell
npm run release            # release the version currently in package.json
npm run release patch      # bump 0.2.0 -> 0.2.1, then release   (also minor | major | x.y.z)
```

`npm run release` (`scripts/release.mjs`) runs this loop, stopping at the first failure:
1. **Preflight** — clean working tree (only `package.json`/`CHANGELOG.md` may be dirty); a
   GitHub token is present; warns if not on Windows.
2. **Syntax check** — `npm run check` + `config.json` parses.
3. **Bump** — writes the version into `package.json`; promotes `CHANGELOG.md` `[Unreleased]` →
   `[x.y.z] — <date>`.
4. **Commit + tag** `vX.Y.Z`.
5. **Push code to BOTH remotes** — Gitea (`origin`, via your git creds) and GitHub
   (`HEAD→main` + tag, via the token). GitHub gets the commit *before* the release so the
   release attaches to a real commit.
6. **Build + publish** — `electron-builder --win --publish always` builds the installer and
   creates the **GitHub release** `vX.Y.Z` with the `.exe`, `.blockmap`, and `latest.yml`.
7. **Verify** — the three artifacts exist and `latest.yml`'s version matches.

Flags: `--dry-run` (validate only), `--no-publish` (build + push code/tag, skip the GitHub
release), `--yes`/`-y` (no prompt).

---

## 3. How auto-update works (why "publish" = users get it)

The installed app self-updates with **electron-updater** using the **GitHub** provider
(`package.json` → `build.publish`, `releaseType: "release"`). GitHub has a real "latest
release", so there's no fixed-tag trick: publish `vX.Y.Z`, and the app finds it.

In `main.js` → `setupAutoUpdates`: checks ~8 s after launch and every 6 h, **only** when
`app.isPackaged && process.platform === 'win32'` (a no-op in dev / non-Windows, so `npm start`
and tooling never hit the network). Downloads in the background, installs on quit, or
immediately via the tray (**Check for updates… / Restart to install update**).

So after `npm run release`, existing installs update themselves within ~6 h (or on next launch).

---

## 4. CI is a backstop, not a builder

`.gitea/workflows/release-check.yml` runs on a `v*` tag (if/when a Gitea **act_runner** is
registered — none is yet). It does **not** build (the Linux runner has no wine). It re-checks
syntax, `config.json`, tag == `package.json` version, a `CHANGELOG.md` entry, the github publish
config, and that the **GitHub release exists**. Red == the tagged commit is broken.

---

## 5. Verify a release worked

1. **GitHub** — `https://github.com/Virus7976/usb-video-manager/releases/tag/vX.Y.Z` exists with
   the `.exe`, `.blockmap`, and `latest.yml` attached, and is **not a draft/prerelease**.
2. **Feed** — that release shows as "Latest".
3. **Real install** — run the new Setup `.exe` (silent: `… /S`); confirm the version; the asar at
   `%LOCALAPPDATA%\Programs\USB SD Auto-Action\resources\app.asar` contains your change.
4. **Auto-update** — on a machine with the previous version, leave it running; within ~6 h (or
   tray **Check for updates…**) it downloads and offers to restart.

---

## 6. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `No GitHub token` | Set `GH_TOKEN` or create `~/.github-token`, or run `--no-publish`. |
| GitHub `403`/`Resource not accessible` | Token lacks **Contents: write** on `Virus7976/usb-video-manager`. |
| `missing build artifact …` | The build failed. Re-run; check the electron-builder output. |
| Build fails on Linux/WSL | Expected — build on Windows. |
| `winCodeSign` symlink permission error (Windows) | Enable Developer Mode, run the build elevated once, or pre-extract the winCodeSign cache. |
| App never updates | Confirm it's the **packaged** Windows build; check the GitHub release is the latest, non-draft; look for `[update]` lines in the app console. |
| Gitea push fails | Your git credential helper isn't set for Gitea — `git push` once manually to cache creds. |

---

## 7. Manual fallback (if the script can't run)

```powershell
npm run check
$env:GH_TOKEN = "<token>"
npx electron-builder --win --publish always   # builds + creates the GitHub release
git push origin HEAD; git push origin vX.Y.Z  # mirror code/tag to Gitea
```
The script automates exactly this (plus the version bump, changelog, and GitHub code mirror).
