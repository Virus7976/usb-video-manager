// ---------------------------------------------------------------------------
// END-TO-END harness — drives the REAL Electron app from WSL (Playwright + WSLg).
//
// This is the cure for "renderer changes are inspection-verified, need a visual check on deploy":
// it launches the actual app, in real Chromium, with the real main process, and lets a test read the
// renderer's own `state`/functions and assert on the live DOM. No mocks of the thing under test.
//
// Why this works here (learned the hard way — see memory usb-app-driving-the-gui):
//   • ELECTRON_RUN_AS_NODE leaks in via WSLENV; with it set Electron runs as plain Node and NO window
//     appears. We delete it from the child env.
//   • The app's stores live at `${APPDATA}/USB SD Auto-Action` (NOT XDG_CONFIG_HOME). We point APPDATA
//     at a throwaway temp dir so a run never touches the real profile — and so we can SEED stores by
//     writing files there before launch (state injection with zero UI driving).
//   • Drive detection is Windows-only, so there's no card. The home screen offers "Choose drive…"
//     (#manualPickBtn → drive:pick, whose own comment says "fallback / testing without hardware").
//     We stub ONLY the OS folder dialog and point it at a fixture folder of clips.
//
// Speed: launching Electron costs ~2-3s, so a test FILE launches ONCE (before) and shares the window
// across its assertions (after closes it). Prefer seeding stores + one scan over clicking through UI.
// ---------------------------------------------------------------------------
import { _electron } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ELECTRON_BIN = join(ROOT, 'node_modules', 'electron', 'dist', 'electron');

// STORE_DIR the app will use, given an isolated APPDATA.
export function storeDirFor(appData) { return join(appData, 'USB SD Auto-Action'); }

// Launch the app with an isolated profile. `seed` is a map of store filename -> object|string written
// into STORE_DIR before launch (e.g. { 'config.json': {...}, 'clip-observations.json': {...} }).
// Pass `appData` to REUSE an existing profile dir — that's how a persistence test relaunches "the same
// install" across two sessions. When reused, close() does NOT delete it (the caller owns its lifetime).
export async function launchApp({ seed = {}, args = [], appData: reuse } = {}) {
  const appData = reuse || mkdtempSync(join(tmpdir(), 'usb-e2e-'));
  const created = !reuse;
  const sdir = storeDirFor(appData);
  mkdirSync(sdir, { recursive: true });
  for (const [file, obj] of Object.entries(seed)) {
    writeFileSync(join(sdir, file), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // the WSLENV trap — must be gone or no window opens
  env.APPDATA = appData;             // isolate + enable pre-seeding
  env.USB_E2E = '1';
  const app = await _electron.launch({
    // Software WebGL via ANGLE+SwiftShader — NOT --disable-gpu. face-api's tfjs needs a real WebGL
    // backend; with --disable-gpu it falls to an uninitialised 'wasm' backend and face detection can't
    // load. SwiftShader gives a headless-safe webgl backend that detects faces (verified: 3 in sample1).
    args: ['.', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', ...args],
    cwd: ROOT,
    executablePath: ELECTRON_BIN,
    env,
    timeout: 30000,
  });
  const win = await app.firstWindow({ timeout: 20000 });
  await win.waitForSelector('#manualPickBtn, #startFlowBtn', { timeout: 20000 });
  const close = async () => {
    try { await app.close(); } catch { /* already gone */ }
    if (created) { try { rmSync(appData, { recursive: true, force: true }); } catch { /* ignore */ } }
  };
  return { app, win, appData, storeDir: sdir, close };
}

// Stub the OS open dialog (main process) so a "Choose drive…" / folder pick resolves to `dir`.
export async function stubOpenDialog(app, dir) {
  await app.evaluate(({ dialog }, d) => {
    const fps = Array.isArray(d) ? d : [d];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: fps });
    dialog.showOpenDialogSync = () => fps;
  }, dir);
}

// Stub the OS SAVE dialog so an export writes to a path the test chose. Sibling of
// stubOpenDialog — anything that saves a file needs this to be drivable without a human.
export async function stubSaveDialog(app, filePath) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
    dialog.showSaveDialogSync = () => p;
  }, filePath);
}

// Point the source at a fixture folder and run the app's REAL startFlow() (which scans the folder via
// the main process and builds the rename screen). We enter through the renderer's own entry point with
// the drive pre-set — more robust than chasing home-screen button visibility, and it still exercises
// the true scan:videos → buildRenameStep pipeline end to end.
export async function scanFolder(app, win, dir) {
  await win.evaluate(async (d) => {
    // eslint-disable-next-line no-undef
    state.drive = { mountpoint: d, description: 'E2E fixtures', size: 0, isCard: false, isUSB: false };
    // eslint-disable-next-line no-undef
    await startFlow();
  }, dir);
  await win.waitForSelector('#renameList .rename-card', { timeout: 45000 });
}

// Read the renderer's own top-level binding (state/uiPrefs/etc.) or evaluate any expression against it.
// Renderer.js is one classic script, so its top-level `const`s are global-lexical and directly
// referenceable from page eval — this is what lets a test inspect the real thing, not a copy.
export function read(win, expr) { return win.evaluate(`(() => (${expr}))()`); }
export function run(win, body) { return win.evaluate(`(() => { ${body} })()`); }

// WAIT FOR A CONDITION IN THE RENDERER — and do NOT reach for `page.waitForFunction()`.
//
// The app ships a strict CSP (`default-src 'self'`, no 'unsafe-eval'), and Playwright's
// waitForFunction evaluates its polling predicate through eval INTERNALLY — so it throws
// `EvalError: Evaluating a string as JavaScript violates the following Content Security Policy`
// regardless of whether you pass it a string or a function. It is simply unusable here.
//
// `win.evaluate` is fine (that is what read/run use), so poll with that instead. `expr` is evaluated
// exactly like read(): bare identifiers resolve against the bundle's top-level `let` bindings, which
// are in script scope and are NOT window properties — `window.finScan` is permanently undefined while
// `finScan` works.
//
// Throws on timeout rather than resolving quietly: a wait that gives up silently is indistinguishable
// from no wait at all, and the test then asserts against half-finished state.
export async function waitFor(win, expr, { timeout = 20000, every = 100, what = expr } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let ok = false;
    try { ok = await read(win, expr); } catch { ok = false; }
    if (ok) return true;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeout}ms: ${what}`);
    await new Promise((r) => setTimeout(r, every));
  }
}
