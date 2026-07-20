// Three from the standing backlog, all found by audits rather than by use.
//
//   ⚠⚠ A NAME TYPED WITHIN 600ms OF SWAPPING CARDS WAS SILENTLY LOST. Both scheduleDraftSave and
//      flushDraftSave guard on `state.scannedFiles.length`, and that guard is evaluated at FIRE time.
//      startFlow empties the array and does not refill it until after `await scanVideos(...)` —
//      seconds. A save armed in the preceding 600ms fires into that window, sees length 0, and
//      no-ops. The pagehide/blur safety net has the identical guard, so it did not catch it either.
//      The UI showed a ✓ throughout.
//
//   ⚠⚠ ANALYZE AND IMPROVE HAD NO RUN GUARD while auto-enhance did. Both write
//      `state.scannedFiles[i]` BY INDEX and both flush drafts, so concurrent runs interleave and the
//      winning name is a coin toss. Worse: both open with `aiAborted = false`, so STARTING Improve
//      silently un-cancelled a running Analyze — the same defect just fixed in the "Follow AI ↓"
//      button, by another route, and it also un-does reportCardGone().
//
//   ⚠ FFMPEG'S ABSENCE WAS INVISIBLE. On a clean Windows box it is not installed, and every failure
//      is swallowed: thumbnails never appear, durations read 0, and only compress:run surfaces
//      anything — as a raw "spawn ffmpeg ENOENT". Unlike exiftool (vendored) and the face models
//      (bundled), ffmpeg is assumed. This does not bundle it — that is an ~80 MB decision on a
//      135 MB installer and his to make — but it stops the absence being silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p) => readFileSync(join(process.cwd(), ...p), 'utf8');
const strip = (s) => s.replace(/\/\/.*$/gm, '');
const core = strip(read('src', 'mod', '01-core.js'));
const tasks = strip(read('src', 'mod', '04-tasks-ai.js'));
const aiTools = strip(read('main-mod', '10-ai-tools.js'));

test('⚠⚠ drafts are flushed BEFORE the clip array is replaced', () => {
  const at = core.indexOf('state.scannedFiles = [];');
  assert.ok(at > -1, 'found where the array is emptied');
  const before = core.slice(Math.max(0, at - 300), at);
  assert.match(before, /flushDraftSave\(\);/,
    '⚠ flush first — the guard inside flushDraftSave is evaluated at fire time and would see an empty array');
});

test('the flush is not merely present somewhere earlier in the function', () => {
  // Bind to adjacency, not existence: a flush 200 lines up would satisfy a naive search while the
  // window this closes stayed wide open.
  const at = core.indexOf('state.scannedFiles = [];');
  const flushAt = core.lastIndexOf('flushDraftSave();', at);
  assert.ok(flushAt > -1 && at - flushAt < 300,
    `the flush is immediately before the reset — gap was ${at - flushAt} chars`);
});

test('⚠⚠ all three AI naming runs claim the same slot', () => {
  // One guard for all of them, or the two unguarded ones keep un-cancelling the third.
  assert.match(tasks, /let aiRunActive = '';/, 'there is one shared claim');
  const claims = (tasks.match(/if \(!beginAiRun\('(analyze|improve|enhance)'\)\) return;/g) || []);
  assert.equal(claims.length, 3, `analyze, improve and auto-enhance all claim it — found ${claims.length}`);
  for (const kind of ['analyze', 'improve', 'enhance']) {
    assert.ok(claims.some((c) => c.includes(`'${kind}'`)), `${kind} claims the slot`);
  }
});

test('⚠ and each releases it in a finally', () => {
  const releases = (tasks.match(/\} finally \{ endAiRun\(\); \}/g) || []).length;
  assert.ok(releases >= 2, `the wrapped runs release on every exit — found ${releases}`);
  // endAiRun also clears the captured array now (the card-swap guard), so assert on the CLAIM being
  // released rather than on the function's exact body — the property is "the slot is freed", not
  // "the function has one statement".
  assert.match(tasks, /function endAiRun\(\) \{[^}]*aiRunActive = '';[^}]*\}/,
    'and the release really clears the claim');
  assert.match(tasks, /function endAiRun\(\) \{[^}]*aiRunArray = null;[^}]*\}/,
    'and drops the captured clip array, so a later run is not judged stale against a dead reference');
  // auto-enhance releases inline at its existing exit rather than via a wrapper.
  assert.match(tasks, /autoEnhancing = false;\s*\n\s*endAiRun\(\);/, 'auto-enhance releases too');
});

test('⚠ the refusal names WHICH run is going, and is visible', () => {
  // "Nothing happened" on a long GPU job reads as the app ignoring him.
  const at = tasks.indexOf('function beginAiRun(kind)');
  assert.ok(at > -1, 'found the claim');
  const body = tasks.slice(at, tasks.indexOf('\n}', at));
  assert.match(body, /showToast\(/, 'it says something');
  assert.match(body, /AI_RUN_LABEL\[aiRunActive\]/, 'and names the run that is already going');
  assert.match(body, /cancel it first/, 'and tells him what he can do about it');
});

test('⚠ starting a second run can no longer un-cancel the first', () => {
  // The mechanism: both entry points open with `aiAborted = false`, so the SECOND one resurrected a
  // run the user had cancelled. Refusing the second call is what closes it — so the claim must come
  // BEFORE that assignment, not after.
  for (const fn of ['async function aiImproveSelected()', 'async function aiAnalyzeSelected(preset = null)']) {
    const at = tasks.indexOf(fn);
    assert.ok(at > -1, `found ${fn}`);
    const head = tasks.slice(at, at + 400);
    const claim = head.indexOf('beginAiRun');
    const reset = head.indexOf('aiAborted = false');
    assert.ok(claim > -1, `${fn} claims the slot`);
    if (reset > -1) assert.ok(claim < reset, `⚠ ${fn} must claim BEFORE clearing aiAborted`);
  }
});

test('⚠ ffmpeg is probed, and its absence is reported', () => {
  assert.match(aiTools, /id: 'no-ffmpeg'/, 'the health check reports it');
  assert.match(aiTools, /severity: 'high'/, 'as a real problem');
  const at = aiTools.indexOf("id: 'no-ffmpeg'");
  const body = aiTools.slice(Math.max(0, at - 600), at);
  assert.match(body, /runCapture\(config\.ffmpegPath \|\| 'ffmpeg', \['-version'\]/,
    '⚠ through runCapture, not a bare spawn — it owns the timeout and the tree-kill');
  assert.match(body, /onlyOnSuccess: true/, 'a non-zero exit reads as absent, which is the honest answer');
});

test('⚠⚠ the ffmpeg card DOES something when pressed', () => {
  // applyAiHealthFix falls through silently on an unknown fix id, and every health card renders a
  // button. A card whose button does nothing is the exact defect this codebase keeps being audited
  // for — so the fix id must be one the renderer actually handles.
  const at = aiTools.indexOf("id: 'no-ffmpeg'");
  const entry = aiTools.slice(at, at + 700);
  const m = entry.match(/fix: '([a-zA-Z]+)'/);
  assert.ok(m, 'the problem declares a fix');
  assert.ok(core.includes(`p.fix === '${m[1]}'`),
    `⚠ the renderer must handle fix '${m[1]}' — an unhandled id makes the button a no-op`);
});

test('the copyLink fix uses a bridge that exists', () => {
  // Reusing the clipboard bridge instead of inventing an open-external IPC, which would then also
  // need a preload binding and a renderer caller or the reachability test would flag it as dead.
  const at = core.indexOf("if (p.fix === 'copyLink')");
  const body = core.slice(at, core.indexOf('return;', at));
  assert.match(body, /window\.api\.clipboardWrite\(p\.arg\)/, 'it copies the link');
  assert.match(read('preload.js'), /clipboardWrite: \(text\) => ipcRenderer\.invoke\('clipboard:write', text\)/,
    'and that bridge is really exposed');
});

test('⚠⚠ an AI run stops if a NEW CARD replaces the clips underneath it', () => {
  // Every AI loop iterates INDEXES and does `state.scannedFiles[i]` fresh each iteration. If a new
  // card replaces that array mid-run, card A's results are written onto card B's clips BY POSITION —
  // silent misnaming, no error anywhere. It is reachable by an ordinary sequence: analyze is
  // deliberately non-modal, and goHome gates only on confirmLeaveTransfer(), which covers a COPY.
  assert.match(tasks, /let aiRunArray = null;/, 'the run captures the array it started on');
  assert.match(tasks, /aiRunArray = state\.scannedFiles;/, 'at claim time');
  assert.match(tasks, /function aiRunStale\(\) \{ return !!aiRunArray && state\.scannedFiles !== aiRunArray; \}/,
    '⚠ compared by IDENTITY — startFlow assigns a brand-new array, so any replacement is caught, ' +
    'while ordinary in-place edits are not');
});

test('⚠⚠ EVERY loop that indexes into the clip array checks it', () => {
  // The twin problem this repo produces most: guarding one loop and missing its siblings. Each
  // `if (aiAborted) break;` sits at the head of a loop that then does state.scannedFiles[i].
  const aborts = (tasks.match(/if \(aiAborted\) break;/g) || []).length;
  const stales = (tasks.match(/if \(aiRunStale\(\)\)/g) || []).length;
  assert.ok(stales >= 5, `every indexed loop is guarded — found ${stales} stale checks for ${aborts} abort checks`);
  assert.equal(stales, aborts, `⚠ one stale check per abort check — ${aborts} vs ${stales} means a loop was missed`);
});

test('⚠ stopping for a card swap SAYS so, rather than looking like it finished', () => {
  // A run that silently stops mid-way reads as "it finished" — the same success-over-nothing-happened
  // failure fixed repeatedly elsewhere in this app.
  assert.match(tasks, /Stopped analysing — you switched to a different card\./, 'analyze says why');
  assert.match(tasks, /Stopped improving — you switched to a different card\./, 'and improve uses its own verb');
});
