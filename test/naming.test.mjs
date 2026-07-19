// Characterization tests for the file-naming / organizing / metadata-embedding layer.
//
// Everything here is pulled out of the real main.js bundle via the vm harness (so the
// functions under test are the SAME code that ships), plus the renderer's live-preview
// keyword builder, executed straight from its real source. These tests pin CURRENT
// behavior — including two places where the renderer preview and the main-process embed
// DISAGREE (documented, with repros, in the final report). They are written to PASS
// against today's code; a divergence assertion that starts failing means someone changed
// one side of the naming rule without the other.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMain } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Pull a single top-level `function <name>(…) {…}` out of a plain (non-module) source
// file by brace-matching, and instantiate it in an isolated scope. This runs the REAL
// renderer/core source — not a transcription — so the test tracks the shipping code.
function extractFn(relFile, name, injected = []) {
  const src = readFileSync(join(ROOT, relFile), 'utf8');
  const needle = `function ${name}(`;
  const start = src.indexOf(needle);
  if (start < 0) throw new Error(`${name} not found in ${relFile}`);
  let depth = 0; let end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  const body = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(...injected, `${body}; return ${name};`);
}

const m = loadMain();
after(() => m.dispose());

const call = (name, ...args) => m.call(name, ...args);
const plain = (v) => m.plain(v);
// Flat embedded-keyword list produced by the MAIN process for a clip's meta.
const mainKeywords = (meta, parts = [], fallback = 'file.mp4') =>
  plain(call('buildEmbedTags', meta, parts, fallback)['XMP-dc:Subject'] || []);

// The renderer's live-preview keyword builder, from its real source. It closes over the
// renderer global `organizeFields`; feed it main's own config value so both sides use the
// same field taxonomy.
const organizeFields = plain(m.get('config').organizeFields);
const clipEmbedKeywords = extractFn('src/mod/03-rename.js', 'clipEmbedKeywords', ['organizeFields'])(organizeFields);
// The renderer's slug() — used to build a genuinely app-generated filename to round-trip.
const slug = extractFn('src/mod/01-core.js', 'slug')();

// The renderer never hands main a raw clip: at save it folds clip.tags (plus the
// structured fields) into meta.keywords — see src/mod/09-phone-finalize.js:963. Main reads
// `m.keywords` and never `m.tags`, so THIS is the meta shape buildEmbedTags actually sees.
// The parity contract the preview must satisfy is therefore:
//     clipEmbedKeywords(clip)  ===  mainKeywords(toMeta(clip))
const toMeta = (clip) => ({
  ...clip,
  keywords: [clip.subject, clip.location, clip.shotType, ...organizeFields.map((f) => clip[f.id]),
    ...(Array.isArray(clip.tags) ? clip.tags : [])].filter(Boolean),
});

// ---------------------------------------------------------------------------
// Token splitting
// ---------------------------------------------------------------------------
test('nameToTokens: lowercases, splits on space/hyphen, strips punctuation', () => {
  assert.deepEqual(plain(call('nameToTokens', 'Liam-Gour!! 2')), ['liam', 'gour', '2']);
  assert.deepEqual(plain(call('nameToTokens', '  The  Quick_Brown ')), ['the', 'quickbrown']); // underscore is stripped (not in the kept set), so the two words fuse
  assert.deepEqual(plain(call('nameToTokens', '')), []);
  assert.deepEqual(plain(call('nameToTokens', null)), []);
});

// ---------------------------------------------------------------------------
// cleanNameField — hyphen/underscore de-hyphenation, stopwords, generic→name swap,
// and (critically) stripping characters illegal in Windows filenames.
// ---------------------------------------------------------------------------
test('cleanNameField: splits on space/hyphen/underscore, drops stopwords, joins with hyphen', () => {
  // "the"/"a"/"over" are all stopwords; underscore is a split char here → dropped too.
  assert.equal(call('cleanNameField', 'THE a Sunset over_the hills', []), 'sunset-hills');
});

test('cleanNameField: strips every Windows-illegal char (<>:"/\\|?*)', () => {
  // None of < > : " / \ | ? * may survive into a value that could reach a filename.
  const out = call('cleanNameField', 'a<b>c:d"e/f\\g|h?i*j', []);
  assert.equal(out, 'b-c-d-e-f-g-h-i-j');
  assert.equal(/[<>:"/\\|?*]/.test(out), false);
});

test('cleanNameField: swaps a generic person word for the recognized first name', () => {
  assert.equal(call('cleanNameField', 'a man walking', ['Liam Gour']), 'liam-walking');
  // count word + generic ("two people") → drop the count, swap the generic
  assert.equal(call('cleanNameField', 'two people running', []), 'people-running');
  assert.equal(call('cleanNameField', 'group of guys', []), 'guys');
});

test('cleanNameField: de-duplicates tokens preserving first occurrence', () => {
  assert.equal(call('cleanNameField', 'lawn lawn mowing lawn', []), 'lawn-mowing');
});

// ---------------------------------------------------------------------------
// cleanTags
// ---------------------------------------------------------------------------
test('cleanTags: lowercases, underscores→spaces, drops <2 / >28 char + non-strings, dedups', () => {
  assert.deepEqual(
    plain(call('cleanTags', ['Golden Hour', 'golden_hour', 'x', 'ok', null, 5, 'a'.repeat(40)])),
    ['golden hour', 'ok'],
  );
});

test('cleanTags: caps the list at 10', () => {
  const many = Array.from({ length: 25 }, (_, i) => `tag${i}`);
  assert.equal(plain(call('cleanTags', many)).length, 10);
});

// ---------------------------------------------------------------------------
// uniqStrings — case-insensitive dedup, FIRST casing wins, trims, drops empties,
// coerces non-strings.
// ---------------------------------------------------------------------------
test('uniqStrings: case-insensitive dedup keeps first casing; trims; drops empty/null', () => {
  assert.deepEqual(plain(call('uniqStrings', ['A', 'a', ' b ', 'B', '', null, 1, 1])), ['A', 'b', '1']);
});

// ---------------------------------------------------------------------------
// slugFolder / subdirParts / metaLevelValue
// ---------------------------------------------------------------------------
test('slugFolder: lowercases, runs of non-alphanumerics→single hyphen, trims hyphens', () => {
  assert.equal(call('slugFolder', 'AC/DC'), 'ac-dc');
  assert.equal(call('slugFolder', 'foo.'), 'foo');
  assert.equal(call('slugFolder', '  Hello  World  '), 'hello-world');
});

test('slugFolder: path-traversal and separator-only inputs collapse to empty (no "..")', () => {
  assert.equal(call('slugFolder', '..'), '');
  assert.equal(call('slugFolder', '...'), '');
  assert.equal(call('slugFolder', '|||'), '');
  assert.equal(call('slugFolder', '   '), '');
});

test('metaLevelValue: maps level name to the meta field', () => {
  const meta = { category: 'Sport', project: 'Demo', subject: 'run', date: '2026-01-01' };
  assert.equal(call('metaLevelValue', 'category', meta), 'Sport');
  assert.equal(call('metaLevelValue', 'project', meta), 'Demo');
  assert.equal(call('metaLevelValue', 'subject', meta), 'run');
  assert.equal(call('metaLevelValue', 'date', meta), '2026-01-01');
  assert.equal(call('metaLevelValue', 'nope', meta), '');
});

test('subdirParts: KEEPS his folder names, skips empties, keeps order', () => {
  // A folder name is not a slug. His projects are `2026 - Client Work` and `Gourgess Lawns` — real
  // folders with capitals and spaces. Slugging them to `2026-client-work/gourgess-lawns` creates a
  // BRAND NEW folder beside the real one and forks his project tree a little more on every run.
  const meta = { category: 'Client Work', project: '', subject: 'Gourgess Lawns' };
  assert.deepEqual(plain(call('subdirParts', ['category', 'project', 'subject'], meta)),
    ['Client Work', 'Gourgess Lawns']);
});

test('safeFolderName: sanitizes what Windows forbids, and nothing else', () => {
  const f = (x) => call('safeFolderName', x);
  assert.equal(f('2026 - Client Work'), '2026 - Client Work', 'capitals and spaces are his, not ours');
  assert.equal(f('Josiah: the film'), 'Josiah- the film', 'a colon is illegal on NTFS');
  assert.equal(f('a/b\\c'), 'a-b-c', 'separators can never smuggle in a subfolder');
  assert.equal(f('trailing dot.'), 'trailing dot', 'Windows cannot end a name with a dot…');
  assert.equal(f('trailing space  '), 'trailing space', '…or a space');
  assert.equal(f('  lots   of   space '), 'lots of space');
  assert.equal(f('..'), '', 'and traversal is still neutralized');
  assert.equal(f('CON'), 'CON-folder', 'reserved device names still get out of the way');
});

test('subdirParts: a ".." level is neutralized to nothing (no traversal escapes)', () => {
  assert.deepEqual(plain(call('subdirParts', ['category', 'project'], { category: '..', project: 'ok' })), ['ok']);
});

// ---------------------------------------------------------------------------
// buildEmbedTags — flat keywords, the length>1 filter, dedup, date/year, hierarchy.
// ---------------------------------------------------------------------------
test('buildEmbedTags: builds flat keywords from fields + split words, dedup case-insensitively', () => {
  const t = plain(call('buildEmbedTags', { subject: 'lawn-mowing', description: 'front yard', date: '2026-06-13' }, [], 'f.mp4'));
  assert.deepEqual(t['XMP-dc:Subject'], ['lawn-mowing', '2026-06-13', '2026', 'lawn', 'mowing', 'front', 'yard']);
});

test('buildEmbedTags: single-character tokens are dropped from the flat keyword list', () => {
  // "x-ray" contributes split words x / ray; the single-char "x" is filtered out.
  const t = plain(call('buildEmbedTags', { subject: 'x-ray', date: '2026-06-13' }, [], 'f.mp4'));
  assert.deepEqual(t['XMP-dc:Subject'], ['x-ray', '2026-06-13', '2026', 'ray']);
  assert.equal(t['XMP-dc:Subject'].includes('x'), false);
});

test('buildEmbedTags: a lone single-char subject "Q" is dropped from keywords but survives as Title', () => {
  const t = plain(call('buildEmbedTags', { subject: 'Q' }, [], 'f.mp4'));
  assert.equal(t['XMP-dc:Subject'], undefined);   // nothing >1 char → no Subject tag at all
  assert.equal(t['XMP-dc:Title'], 'Q');           // but the Title preserves it
});

test('buildEmbedTags: year is derived from the date; DateCreated only for a full ISO date', () => {
  const full = plain(call('buildEmbedTags', { subject: 'zzz', date: '2026-06-13' }, [], 'f.mp4'));
  assert.equal(full['XMP-photoshop:DateCreated'], '2026-06-13');
  assert.ok(full['XMP-dc:Subject'].includes('2026'));
  const partial = plain(call('buildEmbedTags', { subject: 'zzz', date: '2026' }, [], 'f.mp4'));
  assert.equal(partial['XMP-photoshop:DateCreated'], undefined);   // not a full yyyy-mm-dd
  assert.deepEqual(partial['XMP-dc:Subject'], ['zzz', '2026']);
});

test('buildEmbedTags: hierarchical category|project|subject chain', () => {
  const t = plain(call('buildEmbedTags', { category: 'Sport', project: 'Demo', subject: 'run' }, [], 'f.mp4'));
  assert.ok(t['XMP-lr:HierarchicalSubject'].includes('Sport|Demo|run'));
});

test('buildEmbedTags: hc() sanitizer strips | / \\ so a value cannot inject extra tree levels', () => {
  // "AC/DC" as a project must NOT become AC>DC in the hierarchy.
  const t = plain(call('buildEmbedTags', { category: 'Music', project: 'AC/DC', subject: 'live' }, [], 'f.mp4'));
  assert.ok(t['XMP-lr:HierarchicalSubject'].includes('Music|AC DC|live'));
  assert.equal(t['XMP-lr:HierarchicalSubject'].some((h) => h.includes('AC|DC')), false);
});

test('buildEmbedTags: separator-only fields collapse away — no empty "a||b" hierarchy levels', () => {
  const t = plain(call('buildEmbedTags', { category: '|||', project: 'real', subject: '///' }, [], 'f.mp4'));
  const hier = t['XMP-lr:HierarchicalSubject'] || [];
  assert.equal(hier.some((h) => h.split('|').some((lvl) => lvl === '')), false);   // never an empty level
});

test('buildEmbedTags: people → PersonInImage + a People|<name> hierarchy branch', () => {
  const t = plain(call('buildEmbedTags', { subject: 'run', people: ['Liam', 'Josiah'] }, [], 'f.mp4'));
  assert.deepEqual(t['XMP-iptcExt:PersonInImage'], ['Liam', 'Josiah']);
  // MWG Region* tags were dropped — invalid without RegionAppliedToDimensions + Area, ignored by
  // digiKam, so dead XMP noise. PersonInImage + the People/ tag tree cover the people-tag case.
  assert.equal(t['XMP-mwg-rs:RegionType'], undefined);
  assert.ok(t['XMP-lr:HierarchicalSubject'].includes('People|Liam'));
  assert.ok(t['XMP-digiKam:TagsList'].includes('People/Josiah'));
});

test('buildEmbedTags: a single-char person survives as a person tag even though dropped from flat keywords', () => {
  const t = plain(call('buildEmbedTags', { subject: 'run', people: ['Q'] }, [], 'f.mp4'));
  assert.deepEqual(t['XMP-dc:Subject'], ['run']);                 // "Q" filtered out of flat keywords
  assert.deepEqual(t['XMP-iptcExt:PersonInImage'], ['Q']);        // but kept as a person
  assert.ok(t['XMP-lr:HierarchicalSubject'].includes('People|Q'));
});

test('buildEmbedTags: user tags are appended into the flat keyword list and the digiKam TagsList', () => {
  const t = plain(call('buildEmbedTags', { subject: 'beach', tags: ['surf', 'waves'] }, [], 'f.mp4'));
  assert.ok(t['XMP-dc:Subject'].includes('surf'));
  assert.ok(t['XMP-dc:Subject'].includes('waves'));
  assert.ok(t['XMP-digiKam:TagsList'].includes('surf'));
});

test('buildEmbedTags: Title/Description de-hyphenate for human reading', () => {
  const t = plain(call('buildEmbedTags', { subject: 'lawn-mowing', description: 'front-yard', shotType: 'wide', location: 'backyard', date: '2026-06-13' }, [], 'f.mp4'));
  assert.equal(t['XMP-dc:Title'], 'lawn mowing front yard');
  assert.equal(t['XMP-dc:Description'], 'lawn mowing, front yard, wide shot, at backyard, on 2026-06-13');
});

test('buildEmbedTags: an empty meta yields an empty tag set', () => {
  assert.deepEqual(plain(call('buildEmbedTags', {}, [], '')), {});
  assert.deepEqual(plain(call('buildEmbedTags', null, null, null)), {});
});

// ---------------------------------------------------------------------------
// parseNamedClip — round-trip a filename produced by the app's OWN naming rules.
// ---------------------------------------------------------------------------
test('parseNamedClip: round-trips an app-generated yyyy-mm-dd_subject_description_v# name', () => {
  const date = '2026-06-13';
  const subject = slug('Lawn Mowing');        // -> "lawn-mowing"
  const description = slug('front yard hike'); // -> "front-yard-hike"
  const name = `${date}_${subject}_${description}_v3.mp4`;
  const p = plain(call('parseNamedClip', name));
  assert.equal(p.date, date);
  assert.equal(p.subject, subject);
  assert.equal(p.description, description);
  assert.deepEqual(p.keywords, [subject]);
  assert.equal(p.derived, true);
});

test('parseNamedClip: a raw camera filename is NOT treated as app-named', () => {
  assert.equal(call('parseNamedClip', 'GX026816.mp4'), null);
});

test('parseNamedClip: a _v# tag alone (no date) still parses', () => {
  const p = plain(call('parseNamedClip', 'subject_only_v1.mov'));
  assert.equal(p.date, '');
  assert.equal(p.subject, 'subject');
  assert.equal(p.description, 'only');
});

// ---------------------------------------------------------------------------
// normalizeNaming
// ---------------------------------------------------------------------------
test('normalizeNaming: cleans subject/description, tidies tags, passes shotType/category through', () => {
  const out = plain(call('normalizeNaming', { subject: 'a MAN Running', description: 'in the park', shotType: 'wide', category: 'Sport', tags: ['x', 'grass'] }, ['Liam']));
  assert.equal(out.subject, 'liam-running');   // generic "man" → recognized name
  assert.equal(out.description, 'park');        // stopwords dropped
  assert.equal(out.shotType, 'wide');
  assert.equal(out.category, 'Sport');
  assert.deepEqual(out.tags, ['grass']);        // "x" too short for a tag
});

// ---------------------------------------------------------------------------
// DIVERGENCE: renderer preview (clipEmbedKeywords) vs main embed (buildEmbedTags).
// The renderer's live preview is supposed to show EXACTLY what main will embed. These
// tests pin where they currently AGREE and where they currently DISAGREE — the
// disagreements are BUGS (see the report); the assertions document them so a future
// fix flips a red test rather than passing silently.
// ---------------------------------------------------------------------------
test('preview vs embed AGREE on the ordinary case (same keywords, same order)', () => {
  const clip = { subject: 'lawn-mowing', description: 'front yard', date: '2026-06-13' };
  assert.deepEqual(clipEmbedKeywords(clip), mainKeywords(clip));
});

test('preview vs embed AGREE for people + user tags (same keywords, SAME ORDER)', () => {
  const clip = { subject: 'run', people: ['Liam', 'Josiah'], tags: ['grass', 'summer'] };
  assert.deepEqual(clipEmbedKeywords(clip), mainKeywords(toMeta(clip)));
});

test('preview vs embed AGREE on a case variant (both dedup case-insensitively)', () => {
  // Was a real divergence: the renderer deduped with a plain Set (case-SENSITIVE), so the
  // preview listed both "Sunset" and "sunset" while only one was ever embedded.
  const clip = { subject: 'Sunset', location: 'sunset' };
  assert.deepEqual(clipEmbedKeywords(clip), ['Sunset'], 'first casing wins, as in uniqStrings');
  assert.deepEqual(clipEmbedKeywords(clip), mainKeywords(clip));
});

test('preview vs embed AGREE on meta.keywords', () => {
  // Was a real divergence: main spreads m.keywords, the renderer only read clip.tags, so
  // the file received keywords the preview never showed.
  const clip = { subject: 'wedding', keywords: ['ceremony', 'outdoor'] };
  const preview = clipEmbedKeywords(clip);
  assert.ok(preview.includes('ceremony') && preview.includes('outdoor'));
  assert.deepEqual(preview, mainKeywords(clip));
});

test('preview vs embed AGREE across a mixed, realistic clip', () => {
  const clip = {
    subject: 'Lawn-Mowing', description: 'front yard, hot day', location: 'Denver',
    shotType: 'wide', category: 'Home', project: 'Summer 2026',
    people: ['Liam'], tags: ['grass', 'GRASS', 'summer'], date: '2026-06-13',
  };
  assert.deepEqual(clipEmbedKeywords(clip), mainKeywords(toMeta(clip)));
});

test('preview vs embed AGREE that single-character keywords are dropped by both', () => {
  const clip = { subject: 'Q', description: 'a b cd' };
  assert.deepEqual(clipEmbedKeywords(clip), mainKeywords(clip));
});
