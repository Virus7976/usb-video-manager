// Audit #42 — backfilling the missing test for a fix that shipped without one.
//
// "Remember" builds a match rule from a clip's subject/location. On the Organize stage those are
// usually still empty, so learnRouteFromGroup returned false and the tick did NOTHING — no rule, no
// explanation. The fix (already in the code, discovered untested) reports both outcomes.
//
// Source-level, because planChange is a closure inside showDestinationMap. What's pinned is that
// BOTH branches speak: a control that silently no-ops is the same trust bug as audit #40.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'src/mod/07-organize-map.js'), 'utf8');
const planChange = src.slice(src.indexOf('async function planChange('), src.indexOf('const expandedGroups'));

test('#42 ticking Remember confirms when a rule was actually learned', () => {
  assert.match(planChange, /if \(await learnRouteFromGroup\(/, 'it checks the RESULT, not just fires and forgets');
  assert.match(planChange, /showToast\(/, 'and says something');
});

test('#42 ticking Remember explains itself when it CANNOT learn', () => {
  // The whole bug: this branch used to be silent, so the user believed a rule existed.
  const elseBranch = planChange.slice(planChange.indexOf('else'));
  assert.match(elseBranch, /showToast\(/, 'the failure path talks too');
  assert.match(elseBranch, /subject|keyword/i, 'and names the reason, so it is actionable');
});

test('#42 learnRouteFromGroup still reports failure rather than pretending', () => {
  // If this ever returns true unconditionally, the toast lies and the bug is back — worse than
  // before, because now it claims success.
  const fn = src.slice(src.indexOf('async function learnRouteFromGroup('), src.indexOf('async function planChange('));
  assert.match(fn, /if \(!kw\.length\) return false;/, 'no keywords → honest false');
  assert.match(fn, /return true;/, 'and a real save → true');
});
