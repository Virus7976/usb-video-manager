// Audit #8 slice 2 — nothing may reach the observation store by raw key.
//
// The failure mode of a key migration is a FORGOTTEN site, not a wrong one. One leftover
// `clipObsCache[clipKey(x)]` reads the legacy key only: after the writes move to `name__size__mtime`
// that lookup silently returns undefined, the clip loses its AI observation, and nothing reports it.
// There were seven near-identical write blocks and eight reads before this, which is exactly the
// shape that leaves one behind.
//
// I first wrote this as an e2e checking three named functions and it did NOT catch a deliberately
// reintroduced lookup — the leftover was in a fourth function. Scanning the SOURCE is the only
// version that actually holds, which is the point of proving a guard by breaking the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MOD_DIR = join(process.cwd(), 'src', 'mod');
// 01-core.js DEFINES clipObsFor/noteClipObs and legitimately touches the map directly.
const OWNER = '01-core.js';

test('#8 only the accessors touch clipObsCache directly', () => {
  const offenders = [];
  for (const file of readdirSync(MOD_DIR).filter((f) => f.endsWith('.js') && f !== OWNER)) {
    const src = readFileSync(join(MOD_DIR, file), 'utf8');
    src.split(/\r?\n/).forEach((line, i) => {
      if (/clipObsCache\s*\[/.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(offenders, [],
    'Reach the observation store through clipObsFor(clip) / noteClipObs(clip, obs).\n'
    + 'A raw clipObsCache[clipKey(x)] reads the LEGACY key only and silently loses the clip\'s\n'
    + 'observation now that writes use name__size__mtime.\n'
    + offenders.join('\n'));
});

test('#8 the accessors themselves still exist and go through clipEntry/clipKeyV2', () => {
  // If someone "simplifies" these back to a direct lookup the guard above would still pass while the
  // migration quietly reverts, so pin the accessors too.
  const core = readFileSync(join(MOD_DIR, OWNER), 'utf8');
  assert.match(core, /function clipObsFor\(clip\) \{ return clipEntry\(clipObsCache, clip\); \}/,
    'reads go V2-then-legacy');
  assert.match(core, /function noteClipObs\(clip, obs\)[\s\S]{0,200}clipKeyV2\(clip\)/,
    'writes use the collision-free key');
});
