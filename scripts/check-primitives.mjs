#!/usr/bin/env node
// Primitive-bypass guard. The point of the dedup / component work (see DEDUP.md) is that
// ONE primitive owns each cross-cutting decision (safe copy, spawn, mkdir) and every call
// site uses it — so a fix lands everywhere and bugs don't play whack-a-mole. This guard
// stops NEW code from hand-rolling a concern that already has a primitive.
//
// Baseline is a FINGERPRINT map (file → normalized-line → count), NOT a global integer.
// So a genuinely NEW bypass fails even if an unrelated old one was removed the same commit
// (a plain count would net out add+remove to zero and let the regression through).
//
//   node scripts/check-primitives.mjs                 # enforce (used by `npm run check`)
//   node scripts/check-primitives.mjs --list          # also print every current bypass
//   node scripts/check-primitives.mjs --update-baseline  # accept current bypasses as the floor
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'main-mod');
const BASELINE = path.join(ROOT, 'scripts', 'primitives-baseline.json');

// Each rule flags a raw call that SHOULD go through a shared primitive.
const RULES = [
  { key: 'spawn',    re: /\bspawn(?:Sync)?\s*\(/,   use: 'runCapture / streamSpawn / killAfter (never a bare spawn — leak/hang risk)' },
  { key: 'copyFile', re: /\.copyFile(?:Sync)?\s*\(/, use: 'copyFileVerified (verified copy) or moveFileCrossDevice (verified move)' },
  { key: 'mkdir',    re: /\.mkdir(?:Sync)?\s*\(/,    use: 'ensureDir' },
];

// Normalize a line so reindentation/reflow doesn't churn the baseline: drop a trailing
// //-comment (so a comment mentioning spawn( isn't a bypass, and editing one can't shift
// counts), then collapse whitespace.
function normalize(line) {
  return line.replace(/\/\/.*$/, '').replace(/\s+/g, ' ').trim();
}

const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js')).sort();
const current = {};   // fingerprint "file|key|normtext" -> count
const hits = [];
for (const name of files) {
  const lines = fs.readFileSync(path.join(SRC_DIR, name), 'utf8').split('\n');
  lines.forEach((raw, i) => {
    const line = normalize(raw);
    if (!line) return;                       // pure comment / blank after normalize
    if (/^\*/.test(raw.trim())) return;      // JSDoc/block-comment body line
    for (const r of RULES) if (r.re.test(line)) {
      const fp = `${name}|${r.key}|${line}`;
      current[fp] = (current[fp] || 0) + 1;
      hits.push({ name, line: i + 1, key: r.key, text: raw.trim().slice(0, 110) });
    }
  });
}

if (process.argv.includes('--list')) for (const h of hits) console.log(`  ${h.name}:${h.line} [${h.key}] ${h.text}`);
if (process.argv.includes('--update-baseline')) {
  fs.writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  console.log(`primitives baseline updated: ${Object.keys(current).length} fingerprints, ${hits.length} total bypasses`);
  process.exit(0);
}

let baseline = {};
try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch { /* first run */ }

const offenders = [];
for (const [fp, count] of Object.entries(current)) {
  const allowed = baseline[fp] || 0;
  if (count > allowed) offenders.push({ fp, count, allowed });
}
if (offenders.length) {
  console.error('✗ New primitive bypass(es) introduced — route through the shared primitive:');
  for (const o of offenders) {
    const [name, key] = o.fp.split('|');
    const rule = RULES.find((r) => r.key === key);
    for (const h of hits.filter((x) => x.name === name && x.key === key)) console.error(`    ${h.name}:${h.line}  ${h.text}`);
    console.error(`      → use ${rule.use}`);
  }
  console.error('\nIf a bypass is genuinely a new legitimate primitive, run:');
  console.error('  node scripts/check-primitives.mjs --update-baseline');
  process.exit(1);
}
const total = Object.values(current).reduce((a, b) => a + b, 0);
console.log(`primitives guard OK: ${total} known bypasses across ${Object.keys(current).length} fingerprints`);
