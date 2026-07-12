// Test harness for the MAIN process.
//
// main.js is one concatenated script: every helper is a top-level `const`/`function`
// in a single shared scope, and the 151 IPC handlers register at load time. There are
// no exports, so nothing can be `require`d by a test.
//
// Rather than refactor 5,900 lines first, we load the bundle inside a `vm` context with
// a stubbed `electron`. Two properties of a vm Script make this work:
//   - top-level `const`/`let` land in the context's global lexical environment, which
//     persists across later runInContext() calls -> we can read any internal helper;
//   - `ipcMain.handle` runs at load, so a recording stub captures every channel
//     -> we can invoke real IPC handlers directly, with no Electron and no window.
//
// app.whenReady() returns a never-resolving promise on purpose: it keeps createWindow()
// and createTray() from ever firing, so loading the app has no UI side effects.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const realRequire = createRequire(join(ROOT, 'main.js'));

function makeElectronStub(paths, rec) {
  const noop = () => {};
  const app = {
    setName: noop, setAppUserModelId: noop, setPath: noop, quit: noop,
    getPath: (k) => paths[k] ?? paths.userData,
    getVersion: () => '0.0.0-test',
    commandLine: { appendSwitch: noop },
    on: (ev, fn) => { (rec.appEvents[ev] ||= []).push(fn); },
    requestSingleInstanceLock: () => true,
    // Never resolves -> createWindow()/createTray() never run.
    whenReady: () => new Promise(() => {}),
    setLoginItemSettings: noop,
    getLoginItemSettings: () => ({ openAtLogin: false }),
    isPackaged: false,
  };
  class BrowserWindow {
    static getAllWindows() { return []; }
    constructor() { this.webContents = { send: noop, on: noop, setWindowOpenHandler: noop }; }
  }
  const ipcMain = {
    handle: (ch, fn) => { rec.handlers.set(ch, fn); },
    on: (ch, fn) => { rec.listeners.set(ch, fn); },
  };
  return {
    app, BrowserWindow, ipcMain,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) },
    shell: { openPath: async () => '', showItemInFolder: noop, openExternal: async () => {} },
    globalShortcut: { register: () => true, unregisterAll: noop },
    Tray: class { constructor() {} setToolTip() {} setContextMenu() {} on() {} },
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu: noop },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }), createEmpty: () => ({}) },
    nativeTheme: { shouldUseDarkColors: false, on: noop },
    systemPreferences: { getAccentColor: () => '0078d4' },
    Notification: class { constructor() {} show() {} },
    clipboard: { writeText: noop },
  };
}

/**
 * Boot main.js in an isolated vm context backed by a throwaway userData dir.
 * Returns { get, call, invoke, send, handlers, dirs, dispose }.
 */
export function loadMain({ userData } = {}) {
  const base = userData || mkdtempSync(join(tmpdir(), 'uvd-test-'));
  const dirs = { userData: base, appData: base, temp: join(base, 'temp'), videos: join(base, 'videos'), home: base, exe: base, logs: join(base, 'logs') };
  const rec = { handlers: new Map(), listeners: new Map(), appEvents: {} };
  const electron = makeElectronStub(dirs, rec);

  const sandboxRequire = (id) => (id === 'electron' ? electron : realRequire(id));
  sandboxRequire.resolve = realRequire.resolve;

  const ctx = vm.createContext({
    require: sandboxRequire,
    module: { exports: {} }, exports: {},
    __dirname: ROOT, __filename: join(ROOT, 'main.js'),
    process, console, Buffer, URL, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask,
  });

  // The store/config dir is derived from APPDATA at load time (main-mod/01-core.js:69),
  // so point it at the throwaway dir while the bundle evaluates, then restore.
  const prevAppData = process.env.APPDATA;
  process.env.APPDATA = base;
  const src = readFileSync(join(ROOT, 'main.js'), 'utf8');
  try { new vm.Script(src, { filename: 'main.js' }).runInContext(ctx); }
  finally { if (prevAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = prevAppData; }

  return {
    dirs,
    /** Where config.json + the sidecar stores live for this instance. */
    storeDir: join(base, 'USB SD Auto-Action'),
    handlers: rec.handlers,
    appEvents: rec.appEvents,
    /** Read any top-level binding (const/let/function) out of the bundle's scope. */
    get: (name) => vm.runInContext(name, ctx),
    /**
     * Same, but re-materialized in the HOST realm. Values built inside the vm have a
     * different Array/Object prototype, so assert.deepStrictEqual on them fails a
     * prototype check even when the structure is identical. Use this for deep compares.
     */
    getJSON: (name) => JSON.parse(JSON.stringify(vm.runInContext(name, ctx) ?? null)),
    /** Re-materialize any vm-realm value in the host realm. */
    plain: (v) => JSON.parse(JSON.stringify(v ?? null)),
    /** Call a top-level function by name with real JS args (no serialization). */
    call: (name, ...args) => vm.runInContext(name, ctx)(...args),
    /** Invoke a real ipcMain.handle() channel, as the renderer would. */
    invoke: (channel, ...args) => {
      const fn = rec.handlers.get(channel);
      if (!fn) throw new Error(`no ipcMain.handle for "${channel}"`);
      return fn({ sender: { send: () => {} } }, ...args);
    },
    /** Fire an ipcMain.on() channel. */
    send: (channel, ...args) => {
      const fn = rec.listeners.get(channel);
      if (!fn) throw new Error(`no ipcMain.on for "${channel}"`);
      return fn({ sender: { send: () => {} } }, ...args);
    },
    dispose: () => { if (!userData) { try { rmSync(base, { recursive: true, force: true }); } catch {} } },
  };
}
