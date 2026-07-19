# End-to-end tests — drive the REAL app, no more "verify on deploy"

Most bugs in this app live in the **renderer** (see the whack-a-mole history). The `vm`-based harness in
`test/harness.mjs` tests the **main process** brilliantly, but it can't see the renderer — so renderer
fixes kept shipping "inspection-verified, needs a visual check on deploy." This layer removes that gap:
it launches the **actual Electron app** (real Chromium, real main process) and asserts against the live
DOM and the renderer's own `state`/functions.

## Run

```bash
npm run test:e2e      # launches the real app (needs a display — WSLg provides one)
npm run test:all      # fast vm suite + e2e
npm test              # fast vm suite ONLY — e2e is skipped (opt-in via RUN_E2E)
```

E2E is **opt-in** (`RUN_E2E=1`, set by the script). The fast suite never launches Electron, so
`npm test` stays instant. Files are named `*.e2e.mjs`.

## How it works (and the traps it encodes)

`harness.mjs` → `launchApp()` launches `node_modules/electron/dist/electron` via Playwright, and:
- **deletes `ELECTRON_RUN_AS_NODE`** — it leaks in through WSLENV; with it set Electron runs as plain
  Node and no window ever appears (the #1 time-sink).
- **isolates `APPDATA`** to a throwaway temp dir — the app's stores live at
  `${APPDATA}/USB SD Auto-Action`, NOT `XDG_CONFIG_HOME`. This keeps a run off the real profile and
  lets you **seed stores** by writing files there before launch (`launchApp({ seed: { 'config.json': … } })`).
- runs with `--no-sandbox --disable-gpu` (container-friendly).

Reading the renderer's internals: `renderer.js` is one classic script, so its top-level `const`s
(`state`, `uiPrefs`, `jumpNextUnnamed`, `applyBatch`, `saveVersionPoint`, …) are global-lexical and
referenceable directly from page eval. `read(win, expr)` and `run(win, body)` wrap that. This is what
makes assertions land on the **actual thing under test**, not a copy.

`scanFolder(app, win, dir)` points the source at a fixture folder and runs the app's real `startFlow()`
(scan → `buildRenameStep`), so tests start from a genuinely populated rename screen.

`fixtures.mjs` generates a few tiny real `.mp4` clips once (cached under `.fixtures/`, gitignored).

## Add a test (pattern)

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, scanFolder, read, run } from './harness.mjs';
import { ensureClipFixtures } from './fixtures.mjs';

const RUN = process.env.RUN_E2E === '1';
let app;
const dir = RUN ? ensureClipFixtures() : null;
before(async () => { if (RUN) { app = await launchApp(); await scanFolder(app.app, app.win, dir); } });
after(async () => { if (app) await app.close(); });

test('my renderer fix', { skip: !RUN }, async () => {
  const value = await read(app.win, 'state.scannedFiles.length');
  assert.equal(value, 8);
});
```

Gotchas learned here: `focusClip` focuses on a **160 ms timeout** (await it before reading
`document.activeElement`); tear modals down via the DOM, not a click (a stray overlay can intercept
pointer events); a full-page `screenshot()` hangs under WSLg — screenshot an element if you need one.
