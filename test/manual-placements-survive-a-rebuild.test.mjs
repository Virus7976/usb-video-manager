// The Organize map used to throw away every clip the user placed by hand — and then file his footage
// to the destinations he had just overridden.
//
// `placement` is a per-invocation local inside `showDestinationMap`. `renderFinMap()` calls that
// function FRESH on every entry to Organize step 2, and step 2 is re-entered by:
//
//     • pressing Back from step 3          (10-boot.js:250)
//     • clicking the step-2 pill           (10-boot.js:252-261)
//     • toggling "Organize"                (10-boot.js:265)
//     • toggling "Keep the originals"      (10-boot.js:268)  ← a checkbox about SOURCE files
//
// So: drag 40 clips into projects → press Back → the map is rebuilt from the auto-planner and every
// manual placement is gone.
//
// The part that makes it footage-affecting rather than cosmetic: `render()` calls `publishPlan()`,
// which overwrites `lastDestPlan`, and `lastDestPlan` is exactly what the Run button files by
// (`currentDestPlan()` at 10-boot.js:301). After a Back, Run filed to the AUTO destinations while the
// screen had shown his. A personal clip into a client project, past a confirm dialog that names the
// count and not the change — the same class of failure as the reverted ledger rung
// ([[usb-app-delete-gate]] is about the other irreversible act; this one is undo-able but silent).
//
// The fix keeps ONLY his placements sticky. The AI planner's are deliberately not: re-planning is
// cheap and expected, and freezing a suggestion he never accepted would be its own bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const raw = readFileSync(join(process.cwd(), 'src', 'mod', '07-organize-map.js'), 'utf8');
const src = raw.replace(/\/\/.*$/gm, '');   // comments must never satisfy an assertion here

test('⚠⚠ the record of his placements is MODULE-level, not per-invocation', () => {
  // The whole bug in one property. A `const manualPlacements` declared inside showDestinationMap
  // would be re-created on every rebuild and would fix nothing, while every other assertion below
  // still passed.
  const at = src.indexOf('const manualPlacements');
  assert.ok(at > -1, 'the sticky record exists');
  const fnAt = src.indexOf('async function showDestinationMap');
  assert.ok(fnAt > -1, 'found showDestinationMap');
  assert.ok(at < fnAt,
    '⚠ manualPlacements must be declared OUTSIDE showDestinationMap — inside, it dies on every rebuild');
});

test('⚠⚠ his placements are re-applied AFTER the auto-planner, so they win', () => {
  // Ordering is the assertion. Re-applying before the rules/routes/subject rungs would let the
  // planner overwrite him again, and a test that only checked "the loop exists" would not notice.
  const reapply = src.indexOf('manualPlacements.get(c.key)');
  assert.ok(reapply > -1, 'the re-apply loop exists');
  // The last auto rung to write placement[] is the descriptor pass ("own project per day").
  const lastAuto = src.lastIndexOf('descCategory(desc, c)');
  assert.ok(lastAuto > -1, 'found the last auto-placement rung');
  assert.ok(reapply > lastAuto,
    '⚠ his placements must be applied after every auto rung — otherwise the planner overwrites him');
  // And before the UI is built, or the first paint shows the auto plan.
  const ui = src.indexOf('const host = opts.host');
  assert.ok(ui > reapply, 'and before the map is rendered');
});

test('⚠ a re-applied placement is marked manual, so later rule changes leave it alone', () => {
  const at = src.indexOf('manualPlacements.get(c.key)');
  const block = src.slice(at, at + 400);
  assert.match(block, /autoKeys\.delete\(c\.key\)/,
    'dropped from autoKeys — a clip he placed is no longer auto-placed');
  assert.match(block, /setMeta\(c\.key, 'you placed it here', 1, 'manual'\)/,
    'and the plan view says so, at full confidence');
});

test('⚠⚠ EVERY manual move is recorded — not just the first one found', () => {
  // The "one path fixed, its twin missed" shape that has produced a confirmed bug on five separate
  // days in this repo. `moveKeys` is the single site tagged 'you placed it here' outside the
  // re-apply loop; if a second manual-move site is ever added, this fails and forces it to record too.
  const sites = [...src.matchAll(/setMeta\((?:c\.)?k(?:ey)?, 'you placed it here'/g)];
  assert.equal(sites.length, 2, `two sites: the move and the re-apply — found ${sites.length}`);
  const move = src.indexOf("for (const k of keys) { placement[k] = clean;");
  assert.ok(move > -1, 'found moveKeys');
  const line = src.slice(move, src.indexOf('\n', move));
  assert.match(line, /rememberManual\(k, clean\)/,
    '⚠ the manual move must persist the placement, or Back still loses it');
});

test('renaming a proposed folder carries his placements with it', () => {
  // Otherwise a Back would restore the OLD folder name for every hand-placed clip, re-creating a
  // folder he had just renamed away.
  const at = src.indexOf('function renameNewFolder');
  assert.ok(at > -1, 'found renameNewFolder');
  const body = src.slice(at, src.indexOf('\n  }', at));
  assert.match(body, /if \(manualPlacements\.has\(k\)\) rememberManual\(k, placement\[k\]\)/,
    'the sticky record follows the rename');
});

test('⚠ the AI planner’s placements are NOT made sticky', () => {
  // The deliberate limit of the fix. `rememberManual` must be called only from the two places the
  // user acts — not from the AI placement sites (which also call autoKeys.delete), or a suggestion he
  // never agreed to would freeze in place and survive every re-plan.
  const calls = (src.match(/rememberManual\(/g) || []).length;
  assert.equal(calls, 3,
    `the definition, the manual move and the rename — found ${calls}. An AI site must not call it.`);
});

test('the sticky record cannot grow without bound', () => {
  // It is keyed on sourcePath and never pruned by presence (a clip absent from THIS map may be back
  // in the next one), so the cap is what bounds it.
  assert.match(src, /while \(manualPlacements\.size > MANUAL_CAP\) manualPlacements\.delete\(/,
    'oldest entries are shed at the cap');
  assert.match(src, /manualPlacements\.delete\(key\);\s*\n?\s*manualPlacements\.set\(key, rel\)/,
    're-inserting refreshes recency, so the cap sheds the least-recently-placed');
});
