// Audit #37, end-to-end — `organize:undo` used to move the FILES back and leave the project
// LEDGER untouched, so an undone Organize left a phantom project behind: a record still carrying
// the clip counts, dates and subjects of footage that is no longer filed there. `ledger:matchDates`
// / `search_projects` keep scoring FUTURE imports against those phantoms, so one bad Organize
// permanently poisoned placement.
//
// This drives the REAL thing: seeded stores → the renderer's own undoLastOrganize() → the real
// confirm dialog → the real organize:undo IPC → the real ledger store. Both halves at once, which
// is what PROMPT.md §2 asks for and what the vm tests alone can't prove.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, read, run } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';
const KEY = '2026/2026 - Personal/Ski';

let app; let tmp; let filed; let source;

before(async () => {
  if (!RUN) return;
  // A real filed COPY and its still-present original, so undo runs its true path (remove the copy).
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-undo-'));
  source = path.join(tmp, 'ski-run.mp4');
  filed = path.join(tmp, 'Ski', 'ski-run.mp4');
  fs.mkdirSync(path.dirname(filed), { recursive: true });
  fs.writeFileSync(source, 'footage');
  fs.writeFileSync(filed, 'footage');

  const ts = Date.now();
  app = await launchApp({
    seed: {
      'config.json': {
        firstRun: false,          // otherwise the setup wizard owns the modal layer
        lastOrganize: { ts, moves: [{ from: source, to: filed, copied: true }] },
        // The delta the filing run recorded. ts is AFTER lastOrganize.ts — that ordering is real
        // (files are filed, then the renderer calls ledger:record) and is what the staleness
        // guard keys on.
        lastLedger: {
          ts: ts + 1,
          delta: [{
            key: KEY, created: true, prevLastSeen: 0, clips: 1,
            clipNames: ['ski-run.mp4'], dates: ['2026-07-18'], subjects: ['skiing'],
            locations: [], people: [], samples: 1,
          }],
        },
      },
      'project-ledger.json': [{
        id: 'p1', rel: KEY, name: 'Ski', category: '2026/2026 - Personal',
        dates: ['2026-07-18'], subjects: ['skiing'], locations: [], people: [],
        samples: [{ subject: 'skiing', description: '', observation: '', people: [], date: '2026-07-18' }],
        clips: 1, clipNames: ['ski-run.mp4'], summary: '', summaryClips: 0, firstSeen: ts, lastSeen: ts,
      }],
    },
  });
});

after(async () => {
  if (app) await app.close();
  if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } }
});

test('#37 — undo reverses the project ledger, not just the files (full stack)', { skip: !RUN }, async () => {
  // The phantom-to-be is really in the store the app loaded.
  const before = await read(app.win, 'window.api.ledgerGet()');
  assert.equal(before.length, 1, 'the seeded project is loaded');
  assert.equal(before[0].rel, KEY);

  await run(app.win, 'undoLastOrganize();');
  await app.win.waitForSelector('.modal-overlay .modal-card', { timeout: 5000 });

  // The dialog states BOTH halves — "forget what it learned" is the reason a user undoes.
  const body = await app.win.locator('.modal-overlay .modal-card').first().innerText();
  assert.match(body, /move the 1 filed clip back/i, 'the file half');
  assert.match(body, /forget what this run added to your project memory/i, 'the memory half');

  // Click the confirm button through the DOM, not the mouse: the overlay intercepts pointer
  // events and a real click flakes (smoke.e2e.mjs hit the same thing). This still runs the
  // button's own listener, so the dialog→undo→toast wiring is genuinely exercised.
  await run(app.win, "document.querySelector('.modal-overlay .cd-ok').click();");
  await app.win.waitForFunction(
    "document.querySelector('.app-toast') && /forgotten/.test(document.querySelector('.app-toast').textContent)",
    null, { timeout: 8000 },
  );

  const toast = await read(app.win, "document.querySelector('.app-toast').textContent");
  assert.match(toast, /moved 1 clip back/i, 'the file count reaches the user');
  assert.match(toast, /1 project forgotten/i, 'and so does the ledger reversal count');

  // The actual point: the phantom is gone from the real store.
  const after = await read(app.win, 'window.api.ledgerGet()');
  assert.equal(after.length, 0, 'a project that only existed because of the undone run is removed');

  // And the file half genuinely happened: the filed COPY is gone, the original still there.
  assert.equal(fs.existsSync(filed), false, 'the filed copy was removed');
  assert.equal(fs.existsSync(source), true, 'the original is untouched — undo never costs a copy');
});
