// Encodes usb-app-async-cleanup-rule as an INVARIANT instead of a lesson people have to remember.
//
// The rule: an IPC await can REJECT. If a handler disables a button / sets a busy flag / subscribes
// to progress and then awaits, the teardown must be in `finally` (or go through withBusyBtn) — not
// on the happy path. When that was violated, one throw left the Finalize screen dead until restart,
// and a stuck `copyInProgress` nagged "Leave the transfer view?" on every navigation for the rest of
// the session (see the comments at src/mod/10-boot.js and 09-phone-finalize.js).
//
// A 2026-07-18 sweep found the renderer CLEAN on this axis — every disable-then-await site already
// has a catch, a finally, or withBusyBtn. This test exists so it STAYS clean: the next person to add
// a busy button gets told at test time rather than after a locked file wedges a screen in the field.
//
// Deliberately a heuristic, and tuned to stay quiet: it only looks at `.disabled = true` followed by
// an `await` within the same rough block, and accepts catch / finally / withBusyBtn as protection.
// A guard that cries wolf gets deleted, which would be worse than not having it (see audit #40).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD_DIR = path.join(ROOT, 'src', 'mod');
const WINDOW = 40;   // lines to look ahead; generous, because protection can sit well below the await

function unprotectedBusySites() {
  const out = [];
  for (const file of fs.readdirSync(MOD_DIR).filter((f) => f.endsWith('.js')).sort()) {
    const lines = fs.readFileSync(path.join(MOD_DIR, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('.disabled = true')) return;
      const ahead = lines.slice(i, i + WINDOW).join('\n');
      if (!/\bawait\s/.test(ahead)) return;                 // no async work → nothing can leak
      const ctx = lines.slice(Math.max(0, i - 8), i + WINDOW).join('\n');
      if (/\}\s*finally\s*\{/.test(ctx)) return;            // teardown is protected
      if (/\bcatch\b/.test(ctx)) return;                    // rejection is absorbed
      if (/withBusyBtn\(/.test(ctx)) return;                // the helper does both
      out.push(`${file}:${i + 1}  ${line.trim().slice(0, 80)}`);
    });
  }
  return out;
}

test('every busy-button that awaits an IPC call restores itself even when the call rejects', () => {
  assert.deepEqual(unprotectedBusySites(), [],
    'disable-then-await with no catch/finally/withBusyBtn: a rejected IPC leaves this control dead '
    + 'until the app restarts. Wrap the teardown in `finally`, or use withBusyBtn.');
});

test('the guard is actually looking at something (it cannot pass vacuously)', () => {
  // If a refactor renames the pattern, the check above would silently pass forever. Prove it still
  // has material to inspect.
  const all = fs.readdirSync(MOD_DIR).filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(MOD_DIR, f), 'utf8')).join('\n');
  const busy = (all.match(/\.disabled = true/g) || []).length;
  assert.ok(busy >= 10, `the renderer still has busy-button sites to check (found ${busy})`);
  assert.match(all, /function withBusyBtn\(/, 'the helper this rule points people at still exists');
});
