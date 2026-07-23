// Capture README screenshots from the REAL app.
//
// Not mockups and not hand-cropped window grabs: this launches the actual Electron build through the
// same Playwright harness the e2e suite uses, seeds realistic stores, drives the real screens, and
// writes PNGs into docs/screenshots/. That means the screenshots cannot drift from the app — regenerate
// them with `node scripts/screenshots.mjs` after a UI change and the README is current again.
//
// ⚠ The data is SYNTHETIC. Jake's real library is his; nothing here reads his stores. The names
// below are made up to look like plausible shoots.
//
// ⚠ Full-page screenshots HANG in this app (see memory usb-app-driving-the-gui) — always capture the
// viewport, never `fullPage: true`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, run } from '../test/e2e/harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots');
mkdirSync(OUT, { recursive: true });

// ⚠ CAPTURE THROUGH ELECTRON, NOT PLAYWRIGHT.
//
// `page.screenshot()` times out at 30s against this app — even for the viewport, not just the
// documented full-page hang (memory: usb-app-driving-the-gui). Playwright waits for the page to go
// visually STABLE before it shoots, and this UI animates continuously (the shared motion language:
// shimmer on the task bubble, the drive-scan pulse), so that condition is never reached.
//
// `webContents.capturePage()` is the compositor's own frame grab: no stability heuristic, no font
// wait, no timeout. It is also what the app actually renders, which is the point of the exercise.
const shot = async (electronApp, name) => {
  await new Promise((r) => setTimeout(r, 900));   // let transitions settle
  const dataUrl = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const img = await w.webContents.capturePage();
    return img.toDataURL();
  });
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  writeFileSync(join(OUT, `${name}.png`), buf);
  console.log(`  ✓ ${name}.png  (${Math.round(buf.length / 1024)} KB)`);
};

// A plausible library: a few shoots across two months, some named, some not.
const SUBJECTS = ['lawn-mowing', 'gourgess-promo', 'curling-bonspiel', 'kids-sports-day', 'vlog'];
const drafts = {};
for (let i = 1; i <= 42; i += 1) {
  const s = SUBJECTS[i % SUBJECTS.length];
  drafts[`GX0100${String(i).padStart(2, '0')}.MP4__${1000 + i}__${1700000000 + i}`] = i % 4 === 0
    ? { subject: '', description: '' }
    : { subject: s, description: ['front yard pass', 'wide establishing', 'handheld follow'][i % 3] };
}

const seed = {
  'config.json': {
    projectsRoot: 'C:\\Users\\jake\\Videos\\02 - Projects\\2026',
    intakeFolder: 'C:\\Users\\jake\\Videos\\01 - Uncompressed',
    subjects: SUBJECTS,
    ai: { model: 'qwen2.5vl:7b', textModel: 'qwen3:8b', endpoint: 'http://127.0.0.1:11434' },
  },
  'drafts.json': drafts,
  'project-ledger.json': [
    { id: 'l1', rel: '2026/Gourgess Lawns', name: 'Gourgess Lawns', clips: 128, subjects: ['lawn-mowing'], dates: ['2026-06-01'], samples: [], people: [], locations: [] },
    { id: 'l2', rel: '2026/Client Work', name: 'Client Work', clips: 64, subjects: ['gourgess-promo'], dates: ['2026-05-18'], samples: [], people: [], locations: [] },
  ],
  'people.json': [
    { id: 'p1', name: 'Liam', faces: [] }, { id: 'p2', name: 'Karis', faces: [] },
    { id: 'p3', name: 'Josiah', faces: [] }, { id: 'p4', name: 'Mariah', faces: [] },
  ],
};

const app = await launchApp({ seed });
const electronApp = app.app;
const { win } = app;
console.log('App launched. Capturing…');

// ⚠ DO NOT force dark here. `applyTheme({dark:true})` flips `data-theme` and the accent variables,
// but the light theme's already-computed inline custom properties survive, so the result is
// dark-on-dark text and unreadable panels — verified by capturing it. The app follows the Windows
// system theme at runtime; the harness stubs `nativeTheme` light, and light renders correctly.
// A faithful light screenshot beats a broken dark one.

// Each capture is independent: one screen failing must not cost the rest. A screenshot script that
// aborts halfway leaves the README half-updated, which is worse than a missing image.
const step = async (name, fn) => {
  try { await fn(); await shot(electronApp, name); }
  catch (e) { console.log(`  – ${name} skipped (${(e.message || e).toString().split('\n')[0]})`); }
};

try {
  await shot(electronApp, 'home');

  // Real clicks on the real menubar, not internal calls — `openMenu` takes an event.
  await step('menu-edit', async () => {
    await win.click('.menu-trigger[data-menu="edit"]');
    await new Promise((r) => setTimeout(r, 400));
  });
  await win.keyboard.press('Escape').catch(() => {});

  await step('menu-file', async () => {
    await win.click('.menu-trigger[data-menu="file"]');
    await new Promise((r) => setTimeout(r, 400));
  });
  await win.keyboard.press('Escape').catch(() => {});

  // The naming grid, populated by a REAL scan of real (tiny) fixture clips through the real
  // scan:videos → buildRenameStep pipeline. This is the screen the app is actually about.
  await step('scan', async () => {
    const { ensureClipFixtures } = await import('../test/e2e/fixtures.mjs');
    const dir = ensureClipFixtures();
    const { scanFolder } = await import('../test/e2e/harness.mjs');
    await scanFolder(electronApp, win, dir);
    await new Promise((r) => setTimeout(r, 4000));   // let the real thumbnails finish
  });

  // A fresh card opens with the batch-naming offer over the grid — worth its own image, since
  // "name a whole shoot at once" is the answer to 4,594 clips.
  await step('batch-prompt', async () => { await new Promise((r) => setTimeout(r, 200)); });

  // Then dismiss it and show the grid itself.
  await step('rename', async () => {
    // Direct DOM click: a Playwright `:has-text` selector silently matched nothing here, and the
    // modal stayed up in the capture. Find the button by its own text and click it in-page.
    await win.evaluate(() => {
      const want = ["i'll do it myself", 'not now', 'close', 'skip'];
      const b = [...document.querySelectorAll('button')]
        .find((x) => want.includes((x.textContent || '').trim().toLowerCase()));
      if (b) b.click();
    });
    await new Promise((r) => setTimeout(r, 1000));
  });

  console.log(`\nWrote screenshots to ${OUT}`);
} finally {
  await app.close();
}
