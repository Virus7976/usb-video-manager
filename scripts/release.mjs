#!/usr/bin/env node
// One-command release: bump → check → build → publish to GitHub → mirror code.
//
// Code lives on Gitea (origin); the installer + auto-update feed live on GitHub
// releases (Gitea's server caps uploads at 100 MB and blocks .exe by type, so it
// can't host the ~130 MB installer — see RELEASING.md / AGENTS §8). electron-updater
// reads the latest GitHub release (build.publish in package.json).
//
// Usage:
//   npm run release            # release the version currently in package.json
//   npm run release patch      # bump x.y.Z, then release  (also minor | major | x.y.z)
//   npm run release:dry        # validate only — no build, no git/remote changes
//
// Flags:
//   --dry-run      validate + print the plan; touch nothing
//   --no-publish   build + push code/tag, but don't create the GitHub release
//   --yes, -y      don't prompt for confirmation
//
// Auth: a GitHub token with `contents:write` on the release repo, in GH_TOKEN
// (falls back to ~/.github-token). Pushing code to Gitea uses your git credential
// helper; pushing the mirror to GitHub uses the same token.

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = join(ROOT, 'package.json');
const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md');

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('-')));
const positional = argv.filter((a) => !a.startsWith('-'));
const DRY = flags.has('--dry-run');
const NO_PUBLISH = flags.has('--no-publish');
const ASSUME_YES = flags.has('--yes') || flags.has('-y');
const bumpArg = positional[0];

const C = { g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };
const step = (m) => console.log(`\n${C.b('▶')} ${C.b(m)}`);
const ok = (m) => console.log(`  ${C.g('✓')} ${m}`);
const info = (m) => console.log(`  ${C.d(m)}`);
const die = (m) => { console.error(`\n${C.r('✗ ' + m)}`); process.exit(1); };

const sh = (cmd, opts = {}) => execSync(cmd, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', ...opts }).trim();
const shLive = (cmd, env) => { const r = spawnSync(cmd, { cwd: ROOT, stdio: 'inherit', shell: true, env: { ...process.env, ...env } }); if (r.status !== 0) die(`command failed: ${cmd}`); };

// ---- helpers ---------------------------------------------------------------
function nextVersion(current, how) {
  if (!how) return current;
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [maj, min, pat] = current.split('.').map(Number);
  if (how === 'major') return `${maj + 1}.0.0`;
  if (how === 'minor') return `${maj}.${min + 1}.0`;
  if (how === 'patch') return `${maj}.${min}.${pat + 1}`;
  die(`bad version argument "${how}" — use patch | minor | major | x.y.z`);
}

function ghToken() {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env.trim();
  const f = join(homedir(), '.github-token');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  return '';
}

function ghTarget() {
  const p = (JSON.parse(readFileSync(PKG_PATH, 'utf8')).build?.publish || []).find((x) => x.provider === 'github');
  if (!p) die('package.json build.publish has no github provider');
  return { owner: p.owner, repo: p.repo };
}

function promoteChangelog(version, dateStr) {
  if (!existsSync(CHANGELOG_PATH)) return false;
  let md = readFileSync(CHANGELOG_PATH, 'utf8');
  if (md.includes(`## [${version}]`)) return false;
  if (!/^## \[Unreleased\]/m.test(md)) return false;
  md = md.replace(/^## \[Unreleased\][^\n]*$/m, `## [Unreleased]\n\n## [${version}] — ${dateStr}`);
  if (!DRY) writeFileSync(CHANGELOG_PATH, md);
  return true;
}

async function confirm(question) {
  if (ASSUME_YES || DRY || !process.stdin.isTTY) return true;
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
  const { owner, repo } = ghTarget();
  const TOKEN = ghToken();
  const date = new Date().toISOString().slice(0, 10);

  console.log(C.b(`\nRelease ${current} → ${C.g(version)}  (code: Gitea/${branch} · releases: github.com/${owner}/${repo})`));
  if (DRY) console.log(C.y('DRY RUN — nothing will be built, committed, or published.'));

  // ---- preflight ----
  step('Preflight');
  if (!DRY && process.platform !== 'win32') {
    info(C.y('Not on Windows — `electron-builder --win` needs Windows (or wine) and will likely fail.'));
  }
  const dirty = sh('git status --porcelain');
  if (dirty && !DRY) {
    const stray = dirty.split('\n').map((l) => l.slice(3)).filter((f) => f && !['package.json', 'CHANGELOG.md'].includes(f));
    if (stray.length) die(`working tree has uncommitted changes:\n   ${stray.join('\n   ')}\n   Commit or stash them first.`);
  }
  if (!TOKEN && !NO_PUBLISH && !DRY) die('No GitHub token. Set GH_TOKEN or create ~/.github-token, or pass --no-publish.');
  const hasGithubRemote = sh('git remote').split('\n').includes('github');
  ok(`tag ${tag}; GitHub remote ${hasGithubRemote ? 'present' : C.y('MISSING (will be added)')}`);

  // ---- syntax check ----
  step('Syntax check');
  shLive('npm run --silent check');
  ok('main.js / preload.js / renderer.js / watch-drives.js parse clean');
  JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
  ok('config.json is valid JSON');

  if (DRY) {
    step('Plan (dry run)');
    info(`set package.json → ${version}; promote CHANGELOG → [${version}] — ${date}`);
    info(`commit + tag ${tag}; push to Gitea (origin/${branch}) and GitHub (${owner}/${repo} main)`);
    info(`build dist/USB-SD-Auto-Action-Setup-${version}.exe and publish a GitHub release`);
    console.log(`\n${C.g('Dry run OK.')}`);
    return;
  }

  if (!(await confirm(`Build ${C.b(tag)} and publish the GitHub release on ${owner}/${repo}?`))) die('aborted.');

  // ---- bump ----
  step('Bump version');
  if (version !== current) { pkg.version = version; writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n'); ok(`package.json → ${version}`); }
  else info(`version unchanged (${version})`);
  if (promoteChangelog(version, date)) ok(`CHANGELOG: [Unreleased] → [${version}] — ${date}`);

  // ---- commit + tag ----
  step('Commit & tag');
  sh('git add package.json CHANGELOG.md');
  if (sh('git status --porcelain')) { sh(`git commit -m "release ${tag}"`); ok(`committed "release ${tag}"`); } else info('nothing to commit');
  try { sh('git pull --rebase'); ok('rebased on origin'); } catch (e) { info(C.y(`pull --rebase skipped: ${e.message.split('\n')[0]}`)); }
  if (!sh(`git tag -l ${tag}`)) { sh(`git tag ${tag}`); ok(`tagged ${tag}`); }

  // ---- mirror code to Gitea + GitHub (must reach GitHub before the release is cut) ----
  step('Push code (Gitea + GitHub)');
  shLive(`git push origin ${branch}`);
  shLive(`git push origin ${tag}`);
  ok(`pushed ${branch} + ${tag} to Gitea (origin)`);
  if (!hasGithubRemote) sh(`git remote add github https://github.com/${owner}/${repo}.git`);
  // Tokenized push URL (kept out of git config; only in this process).
  const ghUrl = `https://x-access-token:${TOKEN}@github.com/${owner}/${repo}.git`;
  shLive(`git push "${ghUrl}" HEAD:refs/heads/main`);
  shLive(`git push "${ghUrl}" ${tag}`);
  ok(`mirrored HEAD→main + ${tag} to GitHub`);

  // ---- build + publish ----
  step(NO_PUBLISH ? 'Build Windows installer (no publish)' : 'Build + publish to GitHub');
  const publishArg = NO_PUBLISH ? 'never' : 'always';
  shLive(`npx electron-builder --win --publish ${publishArg}`, { GH_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN });
  ok('electron-builder finished');

  // ---- verify ----
  step('Verify artifacts');
  const dist = join(ROOT, 'dist');
  const exe = join(dist, `USB-SD-Auto-Action-Setup-${version}.exe`);
  const latestYml = join(dist, 'latest.yml');
  for (const f of [exe, `${exe}.blockmap`, latestYml]) if (!existsSync(f)) die(`missing build artifact: ${f}`);
  const ymlVer = (readFileSync(latestYml, 'utf8').match(/^version:\s*(.+)$/m) || [])[1]?.trim();
  if (ymlVer !== version) die(`latest.yml version ${ymlVer} != ${version}`);
  ok(`installer ${(statSync(exe).size / 1e6).toFixed(1)} MB; latest.yml v${ymlVer}`);

  console.log(`\n${C.g(C.b('✓ Released ' + tag))}`);
  if (!NO_PUBLISH) console.log(`  https://github.com/${owner}/${repo}/releases/tag/${tag}`);
  console.log('  Installed apps self-update from the latest GitHub release within ~6h.');
}

main().catch((e) => die(e.stack || e.message));
