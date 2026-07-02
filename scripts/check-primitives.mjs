#!/usr/bin/env node
// Primitive-bypass guard. The point of the dedup / component work (see DEDUP.md) is that
// ONE primitive owns each cross-cutting decision (safe copy, spawn, mkdir) and every call
// site uses it — so a fix lands everywhere and bugs don't play whack-a-mole. This guard
// stops NEW code from hand-rolling a concern that already has a primitive: it counts the
// bypasses in main-mod/** and fails if any category exceeds its committed baseline. Fixing
// bypasses (lowering the count) is always allowed; adding one is what fails.
//
//   node scripts/check-primitives.mjs                 # enforce (used by `npm run check`)
//   node scripts/check-primitives.mjs --list          # also print every current bypass
//   node scripts/check-primitives.mjs --update-baseline  # accept current counts as the new floor
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'main-mod');
const BASELINE = path.join(ROOT, 'scripts', 'primitives-baseline.json');

// Each rule flags a raw call that SHOULD go through a shared primitive. Count-based so it
// grandfathers today's known bypasses (the baseline) and only fails on new ones.
const RULES = [
  { key: 'spawn',    re: /\bspawn(?:Sync)?\s*\(/,   use: 'runCapture / streamSpawn / killAfter (never a bare spawn — leak/hang risk)' },
  { key: 'copyFile', re: /\.copyFile(?:Sync)?\s*\(/, use: 'copyFileVerified (verified copy) or moveFileCrossDevice (verified move)' },
  { key: 'mkdir',    re: /\.mkdir(?:Sync)?\s*\(/,    use: 'ensureDir' },
];

const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js')).sort();
const counts = Object.fromEntries(RULES.map((r) => [r.key, 0]));
const hits = [];
for (const name of files) {
  const lines = fs.readFileSync(path.join(SRC_DIR, name), 'utf8').split('\n');
  lines.forEach((ln, i) => {
    if (/^\s*(\/\/|\*)/.test(ln)) return;   // skip comment lines
    for (const r of RULES) if (r.re.test(ln)) { counts[r.key] += 1; hits.push({ name, line: i + 1, key: r.key, text: ln.trim().slice(0, 110) }); }
  });
}

if (process.argv.includes('--list')) {
  for (const h of hits) console.log(`  ${h.name}:${h.line} [${h.key}] ${h.text}`);
}
if (process.argv.includes('--update-baseline')) {
  fs.writeFileSync(BASELINE, JSON.stringify(counts, null, 2) + '\n');
  console.log('primitives baseline updated:', JSON.stringify(counts));
  process.exit(0);
}

let baseline = {};
try { baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch { /* first run → no baseline */ }

let failed = false;
for (const r of RULES) {
  const cur = counts[r.key] || 0;
  const base = r.key in baseline ? baseline[r.key] : cur;
  if (cur > base) {
    failed = true;
    console.error(`✗ ${r.key}: ${cur} raw call(s), baseline ${base} → ${cur - base} NEW. Use ${r.use}.`);
    for (const h of hits.filter((x) => x.key === r.key)) console.error(`    ${h.name}:${h.line}  ${h.text}`);
  }
}

if (failed) {
  console.error('\nA new primitive bypass was introduced. Route it through the shared primitive,');
  console.error('or, if it is genuinely a new legitimate helper, run:');
  console.error('  node scripts/check-primitives.mjs --update-baseline');
  process.exit(1);
}
console.log('primitives guard OK:', JSON.stringify(counts));
