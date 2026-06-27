// Optional dev helper: seed the app's AI memory (config.ai.memories) with a few
// GENERIC naming preferences as examples. Run ONLY while the app is closed. Dedups.
// Edit SEEDS to your own conventions — these are just sensible starting defaults.
const fs = require('fs'), path = require('path');
const cfgPath = path.join(process.env.APPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Roaming'), 'USB SD Auto-Action', 'config.json');
const SEEDS = [
  'Describe the VISIBLE action in the description — never echo the subject or a person’s name.',
  '"vlog" is a descriptor (a shot type), not its own project.',
  '"pov" is a descriptor — file it with the project it was shot in.',
  '"timelapse" is a descriptor — add it to the project shot that same day.',
  'Each shooting day of a recurring subject is its own project folder — never lump multiple days together.',
  'Match the existing folder-naming scheme in a project and continue its numbering (e.g. "Day N", "NN - person").',
  'Subjects: 1-3 lowercase hyphenated words. Descriptions: 2-4 visible-action keywords, no filler.'
];
try {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.ai = cfg.ai || {};
  if (!Array.isArray(cfg.ai.memories)) cfg.ai.memories = [];
  const have = new Set(cfg.ai.memories.map((m) => String((m && m.text) || '').toLowerCase()));
  let added = 0;
  for (const t of SEEDS) { if (!have.has(t.toLowerCase())) { cfg.ai.memories.push({ id: `seed${Date.now()}${added}`, text: t, example: '', ts: Date.now() }); added += 1; } }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  console.log(`seeded ${added} memories (total ${cfg.ai.memories.length}) → ${cfgPath}`);
} catch (e) { console.log('seed skipped:', e.message); }
