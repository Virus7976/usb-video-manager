// Four separate ways the app threw away face work he had already done. All four are the same shape:
// a guard exists on one path and is missing on its twin, or a limit disagrees with its siblings.
//
//   1. ⚠⚠ `draftIsNamed` did not count a confirmed face as work, so the 60-day prune and DRAFTS_CAP
//      evicted it first. MEASURED on his real store (2026-07-20): of 4594 drafts, **200 hold
//      `people` and nothing else** — 200 clips whose only record of his face-tagging was the thing
//      being deleted. `clips:tagPerson` also writes `rec.people` without touching `rec.ts`, so those
//      records carry a stale timestamp and cross the 60-day line soonest.
//   2. `people:merge` capped at 60 while people:save / reassignFace / unignore all cap at 80 — and
//      merge is the one path that COMBINES two enrolled sets, so it applied the tightest limit at
//      the moment most likely to exceed it. Merging a "Sara" and a "Sarah" with 40 confirmed faces
//      each destroyed 20 hand-confirmed enrolments.
//   3. `collectClipFaces` never checked `m.ignored`, so every face he had dismissed re-formed a
//      "New face — name it?" card on every scan. That is the path the Organize analyze AND the
//      phone/finalize analyze both use — the two screens he actually works in.
//   4. Cancelling a phone/finalize analyze discarded every cluster it had built while the clips
//      stayed marked `_facesScanned`, so a re-scan skipped them and the faces were gone.
//
// [[usb-app-jake-workflow]]: "AI analyze must always resume" is one of his two absolutes, and 3 and 4
// are both direct violations of it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

const read = (dir, f) => readFileSync(join(process.cwd(), dir, f), 'utf8');
const people = read('src/mod', '08-people.js').replace(/\/\/.*$/gm, '');
const fin = read('src/mod', '09-phone-finalize.js').replace(/\/\/.*$/gm, '');
const feedback = read('main-mod', '08-finalize-feedback.js');

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

const named = (draft) => app.get(`draftIsNamed(${JSON.stringify(draft)})`);

test('⚠⚠ a clip whose only content is a confirmed face counts as WORK', () => {
  // The exact shape of 200 records in his real store.
  assert.equal(named({ people: ['Josiah'], facesScanned: true, selected: false, ts: 1 }), true,
    '⚠ a confirmed face is work — pruning it deletes his face-tagging');
  assert.equal(named({ people: ['Mariah', 'Robert'], ts: 1 }), true, 'and more than one');
});

test('an EMPTY people array is not work', () => {
  // The boundary that makes the fix honest: `people: []` is a record that was touched and holds
  // nothing. Counting it would make untagging unable to persist.
  assert.equal(named({ people: [], ts: 1 }), false, 'an empty list is not a confirmation');
});

test('⚠⚠ bookkeeping fields are still NOT work — or the cap stops working entirely', () => {
  // Measured, and the reason this is an explicit field list rather than "any non-clearable field":
  // `facesScanned` is present on ALL 4594 of his drafts and `date` on 4588. A generic rule would
  // make every draft permanently unprunable, which is a different bug with the same cause.
  assert.equal(named({ facesScanned: true, selected: true, ts: 1 }), false, 'a scan flag is not work');
  assert.equal(named({ date: '2026-06-01', facesScanned: true, ts: 1 }), false,
    '⚠ a capture date the app derived is not work he did — 4588 of his drafts have one');
  assert.equal(named({}), false, 'and an empty record is not work');
  assert.equal(named(null), false, 'nor a missing one');
});

test('the fields he types are all still counted', () => {
  for (const k of ['subject', 'description', 'location', 'category', 'shotType', 'observation']) {
    assert.equal(named({ [k]: 'x' }), true, `${k} is work`);
  }
  assert.equal(named({ tags: ['b-roll'] }), true, 'tags are work');
});

test('⚠ draftIsNamed stays free of module-level consts (it runs before they exist)', () => {
  // A real crash, not a style rule. `const` does not hoist across the bundle and 01-core.js calls
  // this at MODULE-INIT time in the DRAFTS_CAP boot trim — which fires on his 4594-draft store. A
  // const referenced from here is a TDZ error at launch. I wrote it that way first; this pins it.
  const at = feedback.indexOf('function draftIsNamed');
  const body = feedback.slice(at, feedback.indexOf('\n}', at));
  assert.doesNotMatch(body, /DRAFT_CLEARABLE|DRAFT_WORK_FIELDS/,
    '⚠ the field list must be inline — a const here crashes the app on launch');
  assert.match(body, /'people'/, 'and it still covers face confirmations');
});

test('⚠⚠ every face cap agrees — merge no longer sheds confirmed enrolments', () => {
  const caps = [...feedback.matchAll(/capFacesKeepingConfirmed\([^;]*?,\s*(\d+)\)/g)].map((m) => m[1]);
  assert.ok(caps.length >= 4, `found all the cap sites — got ${caps.length}`);
  assert.deepEqual([...new Set(caps)], ['80'],
    `⚠ one cap, everywhere. A tighter limit on merge destroys confirmed faces — got ${caps.join(', ')}`);
});

test('⚠⚠ BOTH scan paths drop a face he has dismissed', () => {
  // The sibling gap. One path had the #46 guard and the other did not, and the one without it is
  // the one behind the Organize and phone analyze screens.
  const guards = (people.match(/if \(m && m\.ignored\) continue;/g) || []).length;
  assert.equal(guards, 2,
    `⚠ both collectClipFaces and scanFacesForClips must skip ignored faces — found ${guards}`);
});

test('⚠⚠ a cancelled analyze still keeps the faces it found', () => {
  // The clips are marked scanned as the run goes, so discarding the clusters on cancel loses them
  // permanently — a re-scan skips those clips.
  const at = fin.indexOf('if (faceClusters.length) {');
  assert.ok(at > -1, 'the unconditional persist block exists');
  // Bound to THIS block's closing brace. A fixed-width window spilled into the next `if`, which
  // legitimately mentions aiAborted, so the negative assertion could never fail.
  const block = fin.slice(at, fin.indexOf('\n    }', at));
  assert.ok(block.length > 0 && block.length < 400, `sliced just the persist block — got ${block.length} chars`);
  assert.match(block, /savePendingNow\(faceClusters\); saveFaceScenesNow\(\);/, 'it saves');
  assert.doesNotMatch(block, /aiAborted/,
    '⚠ this save must NOT be gated on the run finishing — that is the bug');
  // And it happens before the branch that decides whether to show the grid.
  assert.ok(at < fin.indexOf('if (faceClusters.length && !aiAborted)'), 'saved before the grid opens');
});
