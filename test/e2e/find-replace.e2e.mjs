// Audit #73 — find & replace across names.
//
// The filter could FIND clips; nothing could change them in bulk. On a corpus of thousands that made
// a whole class of edit impractical: misspell a subject on a 400-clip shoot, or rename a project,
// and the only routes were retyping clip by clip or re-running the AI over the batch.
//
// Driven against the REAL renderer with real clips in `state`, because the risk here is not "does
// the dialog open" — it is that a bulk edit silently hits the wrong clips. Every assertion below is
// about WHICH clips changed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, read, run } from './harness.mjs';

// NOTE: read() wraps its expression in a NON-async arrow, so `await` inside it is a syntax error
// (test/e2e/README.md documents this). applyFindReplace returns a promise and Playwright resolves it
// on the way out, so calling it without `await` is both valid and correct here.

const RUN = process.env.RUN_E2E === '1';

let app;
before(async () => { if (RUN) app = await launchApp({ seed: { 'config.json': { firstRun: false } } }); });
after(async () => { if (app) await app.close(); });

// Seed the renderer's own state with clips, then call the real functions against it.
async function seed(win) {
  await run(win, `
    state.scannedFiles = [
      { name: 'a.mp4', size: 1, subject: 'mowwing', description: 'front lawn', selected: true },
      { name: 'b.mp4', size: 2, subject: 'mowwing', description: 'back lawn mowwing', selected: false },
      { name: 'c.mp4', size: 3, subject: 'skating', description: 'rail', selected: false },
      { name: 'd.mp4', size: 4, subject: 'MOWWING', description: '', selected: false },
    ];
  `);
}

test('#73 counts matches across the chosen fields, over ALL clips not just rendered ones', { skip: !RUN }, async () => {
  await seed(app.win);
  // b.mp4 matches in BOTH subject and description — hits counts occurrences, clips counts clips, and
  // the difference between those two numbers is exactly what makes the preview honest.
  const r = await read(app.win, `(() => { const m = frMatches('mowwing', { fields: ['subject','description'], selectedOnly: false, matchCase: false, wholeWord: false }); return { clips: m.clips.length, hits: m.hits }; })()`);
  assert.equal(r.clips, 3, 'a, b and d match (d differs only in case)');
  assert.equal(r.hits, 4, 'b matches twice');
});

test('#73 match-case narrows correctly', { skip: !RUN }, async () => {
  await seed(app.win);
  const r = await read(app.win, `frMatches('mowwing', { fields: ['subject'], selectedOnly: false, matchCase: true, wholeWord: false }).clips.length`);
  assert.equal(r, 2, 'MOWWING is excluded when case matters');
});

test('#73 "only ticked clips" respects the selection', { skip: !RUN }, async () => {
  await seed(app.win);
  const r = await read(app.win, `frMatches('mowwing', { fields: ['subject'], selectedOnly: true, matchCase: false, wholeWord: false }).clips.length`);
  assert.equal(r, 1, 'only the ticked clip');
});

test('#73 the find text is LITERAL — regex metacharacters cannot become a pattern', { skip: !RUN }, async () => {
  // Users type things like "GX01" and "C:\\Projects". Treating input as a regex would be a footgun:
  // a stray "." would match every character across thousands of clips.
  await run(app.win, `state.scannedFiles = [{ name: 'x.mp4', size: 1, subject: 'a.b', description: 'axb', selected: false }];`);
  const r = await read(app.win, `frMatches('a.b', { fields: ['subject','description'], selectedOnly: false, matchCase: false, wholeWord: false }).clips.length`);
  assert.equal(r, 1, 'only the literal "a.b" matched, not "axb"');
});

test('#73 replace changes exactly the matching clips and leaves the rest alone', { skip: !RUN }, async () => {
  await seed(app.win);
  const n = await read(app.win, `applyFindReplace('mowwing', 'mowing', { fields: ['subject','description'], selectedOnly: false, matchCase: false, wholeWord: false })`);
  assert.equal(n, 3, 'reports the clips it touched');
  const after = await read(app.win, `state.scannedFiles.map((c) => c.subject + '|' + c.description)`);
  assert.deepEqual(after, [
    'mowing|front lawn',
    'mowing|back lawn mowing',
    'skating|rail',          // untouched — the one that never matched
    'mowing|',               // case-insensitive match, replaced with the typed casing
  ]);
});

test('#73 an unchecked field is never modified', { skip: !RUN }, async () => {
  await seed(app.win);
  await read(app.win, `applyFindReplace('mowwing', 'mowing', { fields: ['subject'], selectedOnly: false, matchCase: false, wholeWord: false })`);
  const desc = await read(app.win, `state.scannedFiles[1].description`);
  assert.equal(desc, 'back lawn mowwing', 'description untouched because it was not ticked');
});
