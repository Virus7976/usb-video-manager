// ⚠⚠ A PRESET LEAVES HIS MACHINE. That is the whole design constraint.
//
// Jake asked for setups he can save and SHARE. A preset that stayed local could just be a copy of
// config.json; one he hands to someone else must carry no absolute paths (they name his drives and
// his Windows username) and none of his data — his people, his faces, his vocabulary, his library.
// And coming back the other way it is a file from outside the app, so it is untrusted input.
//
// ⚠⚠⚠ THE EXPORT IS AN ALLOWLIST, AND THESE TESTS EXIST TO KEEP IT ONE. A denylist is the obvious
// shape and is wrong in the one way that matters: it stays correct only until someone adds a config
// key, and then the next personal field added anywhere in this app ships to strangers by default,
// silently, with nothing failing. The last test in this file is the one that matters most — it
// invents a brand-new personal key and proves it does NOT travel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../core/presets.js');

// A config shaped like his: real settings, real personal data, real absolute paths.
const hisConfig = () => ({
  // settings that SHOULD travel
  folderLevels: ['category', 'project'],
  organizeFields: [{ id: 'category', label: 'Category' }],
  autoPoll: true,
  ai: {
    enabled: true, model: 'qwen2.5vl:7b', textModel: 'qwen3:8b', frames: 3, temperature: 0.2,
    routes: [{ id: 'r1', name: 'Lawn care', kind: 'route', match: ['lawn'], dest: '2026 - Client Work/Gourgess Lawns' }],
    // …and personal things that must NOT
    people: [{ id: 'p1', name: 'Liam', faces: [{ d: [0.1] }] }],
    facesPending: [{ thumb: 'x.jpg' }],
    clipObs: { 'GX010042.MP4': { obs: 'a man mowing' } },
    memories: ['he shoots lawns on Tuesdays'],
    endpoint: 'http://192.168.1.50:11434',
  },
  subjects: ['lawn-mowing', 'gourgess-promo'],
  fieldHistory: { category: ['client', 'personal'] },
  renameDrafts: { 'a.mp4': { subject: 'lawn-mowing' } },
  finalMeta: { 'a.mp4': { subject: 'lawn-mowing' } },
  projectLedger: [{ rel: '2026/Gourgess Lawns', clips: 128 }],
  // machine-specific paths
  projectsRoot: 'C:\\Users\\jakeg\\Videos\\02 - Projects\\2026',
  intakeFolder: 'C:\\Users\\jakeg\\Videos\\01 - Uncompressed',
  compressedFolder: 'L:\\Video\\02 - Compressed',
  nasBackup: { enabled: true, path: '\\\\NAS\\footage' },
  ffmpegPath: 'C:\\tools\\ffmpeg.exe',
});

const json = (o) => JSON.stringify(o);

test('⚠⚠⚠ no personal data of any kind is in an exported preset', async () => {
  const p = P.buildPreset(hisConfig(), { name: 'Jake’s rig' });
  const text = json(p);
  // ⚠ NOTE WHAT IS *NOT* IN THIS LIST, AND WHY. `Gourgess Lawns` — a client name — DOES travel,
  // inside the filing rule's relative dest. That is deliberate: a filing rule is the most useful
  // thing in a workflow preset and it is meaningless without its folder. But it is his words about
  // his clients, so it is a real disclosure and it belongs in front of him rather than hidden by a
  // test that quietly excuses it. Logged as Q9 in QUESTIONS.md.
  //
  // An earlier draft of this loop wrote `!text.includes(s) || s === 'Gourgess Lawns/'`, which made
  // that one entry pass unconditionally — an assertion that excuses its own failure is not an
  // assertion. Removed; the entry is simply not claimed.
  for (const secret of ['Liam', 'lawn-mowing', 'gourgess-promo', 'a man mowing',
    'he shoots lawns on Tuesdays', 'client', 'personal']) {
    assert.ok(!text.includes(secret), `⚠⚠⚠ "${secret}" leaked into a shareable preset`);
  }
  assert.equal(p.settings.subjects, undefined, 'his vocabulary does not travel');
  assert.equal(p.settings.fieldHistory, undefined, 'nor everything he has ever typed');
  assert.equal(p.settings.projectLedger, undefined, 'nor his library');
  assert.equal((p.settings.ai || {}).people, undefined, '⚠⚠⚠ nor his enrolled people');
  assert.equal((p.settings.ai || {}).clipObs, undefined, 'nor what the AI saw in his footage');
});

test('⚠⚠⚠ no absolute path is in an exported preset', () => {
  const text = json(P.buildPreset(hisConfig()));
  assert.ok(!/[A-Z]:\\\\/.test(text) && !/[A-Z]:\//.test(text), '⚠⚠⚠ a drive letter leaked');
  assert.ok(!text.includes('jakeg'), '⚠⚠⚠ his Windows username leaked');
  assert.ok(!text.includes('NAS'), '⚠⚠⚠ his NAS path leaked');
  assert.ok(!text.includes('192.168'), '⚠⚠⚠ his local network address leaked');
});

test('⚠ the NAS *flag* travels even though the path never does', () => {
  const p = P.buildPreset(hisConfig());
  assert.equal(p.settings.nasBackup.enabled, true, 'the workflow choice is portable');
  assert.equal(p.settings.nasBackup.path, undefined, '⚠ the location is not');
});

test('⚠⚠ a filing rule with an absolute dest is DROPPED, not exported with the path stripped', () => {
  // Stripping the path would leave a rule pointing somewhere arbitrary on the importer's disk, which
  // is worse than not having the rule: it looks configured and files footage somewhere unintended.
  const cfg = hisConfig();
  cfg.ai.routes = [
    { id: 'r1', name: 'ok', kind: 'route', match: ['lawn'], dest: '2026 - Client Work/Gourgess Lawns' },
    { id: 'r2', name: 'absolute', kind: 'route', match: ['x'], dest: 'C:\\Users\\jakeg\\Videos\\Thing' },
    { id: 'r3', name: 'unc', kind: 'route', match: ['y'], dest: '\\\\NAS\\share\\Thing' },
    { id: 'r4', name: 'posix', kind: 'route', match: ['z'], dest: '/mnt/l/Video/Thing' },
  ];
  const p = P.buildPreset(cfg);
  const ids = p.settings.ai.routes.map((r) => r.id);
  assert.deepEqual(ids, ['r1'], '⚠⚠ only the relative rule survives');
});

test('⚠ the settings that describe HOW he works do travel', () => {
  const p = P.buildPreset(hisConfig());
  assert.deepEqual(p.settings.folderLevels, ['category', 'project']);
  assert.equal(p.settings.ai.model, 'qwen2.5vl:7b', 'model choices are portable');
  assert.equal(p.settings.ai.frames, 3);
  assert.equal(p.settings.autoPoll, true);
  assert.equal(p.settings.ai.routes.length, 1, 'and his relative filing rules');
});

// --- IMPORT: the file is untrusted ---------------------------------------------------------------

test('⚠⚠⚠ an imported preset CANNOT set a path, however it was edited', () => {
  // The attack/accident that matters: someone hand-edits a preset (or an old one carries junk) with
  // `projectsRoot` in it. Applying that would silently repoint where his footage gets filed.
  const cfg = hisConfig();
  const before = cfg.projectsRoot;
  const evil = {
    kind: 'usb-auto-action-preset', version: 1,
    settings: {
      projectsRoot: 'D:\\somewhere-else',
      intakeFolder: 'D:\\also-here',
      folderLevels: ['project'],       // one legitimate change, so the import is not a no-op
    },
  };
  const r = P.applyPreset(cfg, evil);
  assert.equal(r.ok, true);
  assert.equal(cfg.projectsRoot, before, '⚠⚠⚠ the projects root was NOT changed by a preset');
  assert.equal(cfg.intakeFolder, 'C:\\Users\\jakeg\\Videos\\01 - Uncompressed', '⚠⚠⚠ nor the intake folder');
  assert.deepEqual(cfg.folderLevels, ['project'], 'the legitimate setting did apply');
  assert.ok(r.ignored.includes('projectsRoot'), '⚠ and it REPORTS what it ignored rather than pretending');
});

test('⚠⚠⚠ an imported preset cannot overwrite his people or his vocabulary', () => {
  const cfg = hisConfig();
  const evil = {
    kind: 'usb-auto-action-preset', version: 1,
    settings: { ai: { people: [], model: 'llava' }, subjects: [], renameDrafts: {} },
  };
  P.applyPreset(cfg, evil);
  assert.equal(cfg.ai.people.length, 1, '⚠⚠⚠ his enrolled people survive an import');
  assert.equal(cfg.subjects.length, 2, '⚠⚠⚠ his vocabulary survives');
  assert.equal(Object.keys(cfg.renameDrafts).length, 1, '⚠⚠⚠ his typed names survive');
  assert.equal(cfg.ai.model, 'llava', 'while the allowlisted setting applied');
});

test('⚠ a file that is not one of ours is refused with a readable reason', () => {
  for (const bad of [null, 'nonsense', [], {}, { kind: 'something-else', version: 1, settings: {} }]) {
    const r = P.validatePreset(bad);
    assert.equal(r.ok, false, `refused: ${JSON.stringify(bad)}`);
    assert.ok(r.error && r.error.length > 10, 'with a sentence, not a code');
  }
});

test('⚠ a preset from a NEWER app version says so instead of half-applying', () => {
  const r = P.validatePreset({ kind: 'usb-auto-action-preset', version: 99, settings: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /newer version/i, 'and tells him to update');
});

test('⚠⚠ the diff shows what WOULD change before anything does', () => {
  // A preset rewrites how his app behaves. "Apply and find out" is not an acceptable shape for that.
  const cfg = hisConfig();
  const p = { kind: 'usb-auto-action-preset', version: 1, settings: { folderLevels: ['project'], autoPoll: true } };
  const d = P.diffPreset(cfg, p);
  assert.equal(d.ok, true);
  const keys = d.changes.map((c) => c.key);
  assert.ok(keys.includes('folderLevels'), 'the real change is listed');
  assert.ok(!keys.includes('autoPoll'), '⚠ and a setting that already matches is NOT listed as a change');
  assert.equal(json(cfg.folderLevels), json(['category', 'project']), '⚠⚠ and nothing was applied');
});

// --- THE ONE THAT KEEPS THIS SAFE AS THE APP GROWS ----------------------------------------------

test('⚠⚠⚠ a NEW personal config key does not travel just because someone added it', () => {
  // The entire reason the export is an allowlist. Simulate a future field — someone adds
  // `ai.voiceprints`, or `clientContacts`, and never thinks about presets. With a denylist this
  // would ship to strangers by default and no test would fail. With an allowlist it simply is not
  // in the preset until someone deliberately adds it.
  const cfg = hisConfig();
  cfg.clientContacts = [{ name: 'Dennis', phone: '555-0100' }];
  cfg.ai.voiceprints = [{ person: 'Liam', vec: [0.1, 0.2] }];

  const text = json(P.buildPreset(cfg));
  assert.ok(!text.includes('555-0100'), '⚠⚠⚠ a future personal field must not leak by default');
  assert.ok(!text.includes('voiceprints'), '⚠⚠⚠ nor a future biometric one');
});

test('⚠ every allowlisted key is genuinely portable — no path-shaped names crept in', () => {
  // A cheap standing check on the allowlist itself: if someone adds `intakeFolder` or an `…Path`
  // key to ALLOWED, this fails immediately rather than at the moment he shares the preset.
  for (const key of P.ALLOWED) {
    assert.ok(!/(^|\.)(.*(Folder|Path|Root|Dir|endpoint))$/i.test(key),
      `⚠ "${key}" looks like a machine-specific location and must not be exportable`);
  }
  for (const banned of P.NEVER_EXPORT) {
    assert.ok(!P.ALLOWED.includes(banned), `⚠⚠ "${banned}" is on both lists — that is a contradiction`);
  }
});

// --- REACHABILITY: a preset engine nothing can call is worth nothing ------------------------------
//
// This project's recurring failure mode is a correct feature with no route to it — six capabilities
// were built, shipped and unreachable. The wiring lands with the feature, not after it.

test('⚠⚠ presets are reachable from the menu, and really call main', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const src = (p) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\/\/.*$/gm, '');
  const menus = src('src/mod/06-menus.js');
  const core = src('src/mod/01-core.js');
  const pre = src('preload.js');

  assert.match(menus, /Save this setup as a preset…/, 'export is in the menu');
  assert.match(menus, /Load a preset…/, 'import is in the menu');
  assert.match(menus, /action: savePresetFile/, 'wired to the real function');
  assert.match(menus, /action: loadPresetFile/, 'and so is import');

  assert.match(core, /await window\.api\.exportPreset\(/, '⚠⚠ export really invokes main');
  assert.match(core, /await window\.api\.previewPreset\(/, '⚠⚠ preview really invokes main');
  assert.match(core, /await window\.api\.applyPreset\(/, '⚠⚠ apply really invokes main');

  for (const m of ['exportPreset', 'previewPreset', 'applyPreset']) {
    assert.ok(pre.includes(`${m}:`), `${m} is bridged in preload`);
    // The §8h trap: a renderer function sharing a bridge method's name satisfies the reachability
    // guard while calling nothing. These are deliberately named differently.
    assert.ok(!new RegExp(`function ${m}\\\\b`).test(core), `⚠ no renderer function shadows ${m}`);
  }
});

test('⚠⚠ import is TWO steps — opening a file cannot apply it', async () => {
  // `presets:preview` reads and describes; `presets:apply` commits. If preview also applied, the
  // confirm dialog would be theatre — he would be agreeing to something already done.
  //
  // ⚠ The first draft of this test was `assert.ok(true)` with a comment claiming the behaviour was
  // pinned elsewhere. It was not, and a placeholder that always passes is worse than no test: it
  // occupies the slot where the real check should be. Asserted properly here.
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const main = readFileSync(join(process.cwd(), 'main-mod', '06-copy-transfer.js'), 'utf8');
  const at = main.indexOf("ipcMain.handle('presets:preview'");
  assert.ok(at > -1, 'the preview handler exists');
  const body = main.slice(at, main.indexOf("ipcMain.handle('presets:apply'", at));
  assert.ok(!/applyPreset/.test(body), '⚠⚠ preview must never apply');
  assert.ok(!/saveConfig\(\)/.test(body), '⚠⚠ and must never write config');
  assert.match(body, /diffPreset/, 'it describes the change instead');
});
