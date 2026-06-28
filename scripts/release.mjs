#!/usr/bin/env node
// One-command release: bump → check → build → verify → publish.
//
// Usage:
//   npm run release            # release the version currently in package.json
//   npm run release patch      # bump x.y.Z, then release
//   npm run release minor      # bump x.Y.0, then release
//   npm run release major      # bump X.0.0, then release
//   npm run release 1.4.0      # set an explicit version, then release
//   npm run release:dry        # validate only — no build, no git/remote changes
//
// Flags:
//   --dry-run      validate + print the plan; touch nothing
//   --skip-build   reuse the existing dist/ artifacts (don't rebuild)
//   --no-publish   build + commit + tag + push, but skip the Gitea release upload
//   --yes, -y      don't prompt for confirmation
//
// Publishing needs a Gitea token with repo+release scope in GITEA_TOKEN
// (PowerShell:  $env:GITEA_TOKEN="..."   bash:  export GITEA_TOKEN=...).
// It builds the installer, then keeps TWO Gitea releases current:
//   • vX.Y.Z  — the permanent, human-facing archive of this version
//   • latest  — a fixed-tag release whose assets the installed app's auto-updater
//               polls (electron-updater "generic" feed, see package.json build.publish)

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = join(ROOT, 'package.json');
const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md');

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('-')));
const positional = argv.filter((a) => !a.startsWith('-'));
const DRY = flags.has('--dry-run');
const SKIP_BUILD = flags.has('--skip-build');
const NO_PUBLISH = flags.has('--no-publish');
const ASSUME_YES = flags.has('--yes') || flags.has('-y');
const bumpArg = positional[0]; // patch|minor|major|x.y.z|undefined

const C = { g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };
const step = (m) => console.log(`\n${C.b('▶')} ${C.b(m)}`);
const ok = (m) => console.log(`  ${C.g('✓')} ${m}`);
const info = (m) => console.log(`  ${C.d(m)}`);
const die = (m) => { console.error(`\n${C.r('✗ ' + m)}`); process.exit(1); };

const sh = (cmd, opts = {}) => execSync(cmd, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', ...opts }).trim();
const shLive = (cmd) => { const r = spawnSync(cmd, { cwd: ROOT, stdio: 'inherit', shell: true }); if (r.status !== 0) die(`command failed: ${cmd}`); };

// ---- version helpers -------------------------------------------------------
function nextVersion(current, how) {
  if (!how) return current;
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [maj, min, pat] = current.split('.').map(Number);
  if (how === 'major') return `${maj + 1}.0.0`;
  if (how === 'minor') return `${maj}.${min + 1}.0`;
  if (how === 'patch') return `${maj}.${min}.${pat + 1}`;
  die(`bad version argument "${how}" — use patch | minor | major | x.y.z`);
}

function parseRemote() {
  const url = sh('git remote get-url origin'); // https://host/owner/repo(.git)
  const m = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) die(`can't parse owner/repo from remote: ${url}`);
  return { base: `https://${m[1]}`, owner: m[2], repo: m[3] };
}

// ---- Gitea API -------------------------------------------------------------
const TOKEN = process.env.GITEA_TOKEN || '';
let API; // set in main once remote is parsed

async function gitea(method, path, { json, form, query } = {}) {
  const qs = query ? '?' + new URLSearchParams(query) : '';
  // This Gitea is behind Cloudflare, which 403s ("error code: 1010") requests with a
  // bot-ish User-Agent (Node's default undici UA gets blocked). Send a browser UA.
  const headers = {
    Authorization: `token ${TOKEN}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
  let body;
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form; // FormData sets its own content-type
  const res = await fetch(`${API}${path}${qs}`, { method, headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gitea ${method} ${path} → ${res.status} ${res.statusText} ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function getReleaseByTag(tag) {
  try { return await gitea('GET', `/releases/tags/${encodeURIComponent(tag)}`); }
  catch { return null; }
}

async function uploadAsset(releaseId, file) {
  const name = basename(file);
  const buf = readFileSync(file);
  const fd = new FormData();
  fd.append('attachment', new Blob([buf]), name);
  // Gitea rejects a second asset with the same name, so this assumes a fresh release.
  return gitea('POST', `/releases/${releaseId}/assets`, { form: fd, query: { name } });
}

// Create (or recreate) a release at `tag` with exactly these assets.
async function publishRelease({ tag, name, body, target, files, recreate }) {
  const existing = await getReleaseByTag(tag);
  if (existing && recreate) {
    info(`replacing existing "${tag}" release (#${existing.id})`);
    await gitea('DELETE', `/releases/${existing.id}`); // keeps the git tag if any
  } else if (existing) {
    die(`release ${tag} already exists — bump the version or delete it first`);
  }
  const rel = await gitea('POST', '/releases', {
    json: { tag_name: tag, target_commitish: target, name, body, draft: false, prerelease: false },
  });
  for (const f of files) { await uploadAsset(rel.id, f); ok(`uploaded ${basename(f)} → ${tag}`); }
  return rel;
}

function changelogSection(version) {
  if (!existsSync(CHANGELOG_PATH)) return '';
  const md = readFileSync(CHANGELOG_PATH, 'utf8');
  // Grab the block under "## [version]" (or "## [Unreleased]") up to the next "## ".
  const re = new RegExp(`^## \\[(?:${version.replace(/\./g, '\\.')}|Unreleased)\\][^\\n]*\\n([\\s\\S]*?)(?=^## )`, 'm');
  const m = md.match(re);
  return m ? m[1].trim() : '';
}

function promoteChangelog(version, dateStr) {
  if (!existsSync(CHANGELOG_PATH)) return false;
  let md = readFileSync(CHANGELOG_PATH, 'utf8');
  if (md.includes(`## [${version}]`)) return false; // already promoted
  if (!/^## \[Unreleased\]/m.test(md)) return false;
  md = md.replace(/^## \[Unreleased\][^\n]*$/m, `## [Unreleased]\n\n## [${version}] — ${dateStr}`);
  if (!DRY) writeFileSync(CHANGELOG_PATH, md);
  return true;
}

async function confirm(question) {
  if (ASSUME_YES || DRY) return true;
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} ${C.d('[y/N]')} `)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

// ---- main ------------------------------------------------------------------
async function main() {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const current = pkg.version;
  const version = nextVersion(current, bumpArg);
  const tag = `v${version}`;
  const branch = sh('git rev-parse --abbrev-ref HEAD');
  const { base, owner, repo } = parseRemote();
  API = `${base}/api/v1/repos/${owner}/${repo}`;
  const date = new Date().toISOString().slice(0, 10);

  console.log(C.b(`\nRelease ${repo} ${current} → ${C.g(version)}  (branch ${branch})`));
  if (DRY) console.log(C.y('DRY RUN — nothing will be built, committed, or published.'));

  // ---- preflight ----
  step('Preflight');
  if (!DRY && !SKIP_BUILD && process.platform !== 'win32') {
    info(C.y('Not on Windows — `electron-builder --win` needs wine here and will likely fail.'));
    info(C.y('Run this on a Windows machine, or build there and re-run with --skip-build.'));
  }
  const dirty = sh('git status --porcelain');
  if (dirty && !DRY) {
    // Allow only package.json / CHANGELOG.md to be dirty (this script edits them).
    const stray = dirty.split('\n').map((l) => l.slice(3)).filter((f) => f && !['package.json', 'CHANGELOG.md'].includes(f));
    if (stray.length) die(`working tree has uncommitted changes:\n   ${stray.join('\n   ')}\n   Commit or stash them first.`);
  }
  if (!TOKEN && !NO_PUBLISH && !DRY) die('GITEA_TOKEN is not set. Export it, or pass --no-publish.');
  ok(`tag ${tag} on branch ${branch}; publishing to ${owner}/${repo}`);

  // ---- syntax check ----
  step('Syntax check');
  shLive('npm run --silent check');
  ok('main.js / preload.js / renderer.js / watch-drives.js parse clean');
  // config.json must be valid JSON (it ships in the asar)
  JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
  ok('config.json is valid JSON');

  if (DRY) {
    step('Plan (dry run)');
    info(`would set package.json version → ${version}`);
    info(`would promote CHANGELOG [Unreleased] → [${version}] — ${date}`);
    info(`would build → dist/USB-SD-Auto-Action-Setup-${version}.exe`);
    info(`would commit + tag ${tag} + push origin ${branch} and ${tag}`);
    info(`would publish Gitea releases: ${tag} (archive) + latest (auto-update feed)`);
    console.log(`\n${C.g('Dry run OK.')} Re-run without --dry-run to release.`);
    return;
  }

  if (!(await confirm(`Build and publish ${C.b(tag)} to ${owner}/${repo}?`))) die('aborted.');

  // ---- bump version + changelog ----
  step('Bump version');
  if (version !== current) {
    pkg.version = version;
    writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
    ok(`package.json → ${version}`);
  } else {
    info(`version unchanged (${version})`);
  }
  if (promoteChangelog(version, date)) ok(`CHANGELOG: [Unreleased] → [${version}] — ${date}`);

  // ---- build ----
  const dist = join(ROOT, 'dist');
  const exe = join(dist, `USB-SD-Auto-Action-Setup-${version}.exe`);
  const blockmap = `${exe}.blockmap`;
  const latestYml = join(dist, 'latest.yml');
  if (SKIP_BUILD) {
    step('Build (skipped)');
    info('reusing existing dist/ artifacts');
  } else {
    step('Build Windows installer');
    shLive('npm run build:win');
    ok('electron-builder finished');
  }

  // ---- verify artifacts ----
  step('Verify artifacts');
  for (const f of [exe, blockmap, latestYml]) {
    if (!existsSync(f)) die(`missing build artifact: ${f}\n   (build failed, or version mismatch — expected v${version})`);
  }
  const ymlVer = (readFileSync(latestYml, 'utf8').match(/^version:\s*(.+)$/m) || [])[1]?.trim();
  if (ymlVer !== version) die(`latest.yml version is ${ymlVer}, expected ${version} — stale dist/, rebuild without --skip-build`);
  ok(`installer ${(statSync(exe).size / 1e6).toFixed(1)} MB; latest.yml v${ymlVer}`);

  // ---- git commit / tag / push ----
  step('Commit, tag & push');
  sh('git add package.json CHANGELOG.md');
  if (sh('git status --porcelain')) { sh(`git commit -m "release ${tag}"`); ok(`committed "release ${tag}"`); }
  else info('nothing to commit');
  try { sh('git pull --rebase'); ok('rebased on origin'); } catch (e) { info(C.y(`pull --rebase skipped: ${e.message.split('\n')[0]}`)); }
  if (!sh('git tag -l ' + tag)) { sh(`git tag ${tag}`); ok(`tagged ${tag}`); }
  shLive(`git push origin ${branch}`);
  shLive(`git push origin ${tag}`);
  ok(`pushed ${branch} and ${tag}`);

  if (NO_PUBLISH) { console.log(`\n${C.g('Built and pushed.')} Skipped Gitea release (--no-publish).`); return; }

  // ---- publish to Gitea ----
  step('Publish Gitea releases');
  const notes = changelogSection(version) || `Release ${version}.`;
  const files = [exe, blockmap, latestYml];
  await publishRelease({ tag, name: tag, body: notes, target: branch, files, recreate: false });
  ok(`archive release ${tag} published`);
  // Move the auto-update feed: recreate the fixed "latest" release with the same assets.
  await publishRelease({ tag: 'latest', name: `Latest (${version})`, body: `Auto-update feed — currently v${version}.\n\n${notes}`, target: branch, files, recreate: true });
  ok('auto-update feed "latest" updated');

  console.log(`\n${C.g(C.b('✓ Released ' + tag))}`);
  console.log(`  Archive:  ${base}/${owner}/${repo}/releases/tag/${tag}`);
  console.log(`  Installed apps will self-update from the "latest" feed within ~6h.`);
}

main().catch((e) => die(e.stack || e.message));
