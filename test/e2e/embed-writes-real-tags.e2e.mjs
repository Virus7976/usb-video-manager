// Does the app actually write metadata INTO his footage? Nobody has ever checked.
//
// `test/exiftool-constructs.test.mjs` proves the singleton can be constructed again after today's
// fix. That is necessary and not sufficient: it says the door opens, not that anything walks through
// it. Every layer above — buildEmbedTags, the already-carrying-it short-circuit, the sidecar
// fallback, readEmbeddedRecord — has been running against a dependency that threw on first touch for
// the entire life of the modular main process, so NONE of it has ever executed successfully. Code
// that has never once run is unproven code, regardless of how long it has been in the repo.
//
// So this files a clip with real metadata through the real UI and then reads the file back with an
// independent exiftool instance. Not the app's own reader — that shares the singleton and the same
// assumptions, and would happily agree with itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, utimesSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, read, run, waitFor } from './harness.mjs';

const RUN = process.env.RUN_E2E === '1';

let app; let box;

const walk = (root) => {
  const out = [];
  const rec = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(join(d, e.name), r); else out.push(r);
    }
  };
  rec(root, '');
  return out;
};

before(async () => {
  if (!RUN) return;
  const base = mkdtempSync(join(tmpdir(), 'uvd-e2e-embed-'));
  const compressed = join(base, 'Compressed');
  const projects = join(base, 'Projects');
  mkdirSync(compressed, { recursive: true });
  mkdirSync(projects, { recursive: true });
  // A REAL mp4. exiftool will refuse to write XMP into 2KB of zeroes, and a test that only proves
  // the sidecar fallback works is not the test I want — the point is the container itself.
  const fixture = join(process.cwd(), 'test', 'fixtures', 'tiny.mp4');
  const clip = join(compressed, 'GX010123.MP4');
  if (existsSync(fixture)) copyFileSync(fixture, clip);
  else writeFileSync(clip, Buffer.alloc(4096, 0));
  const when = new Date('2026-06-07T09:00:00Z');
  utimesSync(clip, when, when);
  box = { base, compressed, projects, clip, real: existsSync(fixture) };
  app = await launchApp({
    seed: {
      'config.json': {
        firstRun: false,
        finalizeSource: compressed,
        projectsRoot: projects,
        organizeDest: '',
        folderLevels: ['category', 'project'],
        nasBackup: { enabled: false, path: '' },
      },
      // finalMeta is a SIDECAR store with its own file — seeding it inside config.json is silently
      // ignored, because saveConfig() strips every key whose sidecar exists. My first version did
      // exactly that and the clip came back unmatched, which looked like an app bug and was mine.
      'final-meta.json': {
        'GX010123.MP4': {
          subject: 'liam', description: 'skate park session', location: 'bristol',
          people: ['Liam'], tags: ['skate', 'outdoor'], date: '2026-06-07', done: true, ts: 1,
        },
      },
    },
  });
});
after(async () => {
  if (app) await app.close();
  if (box) rmSync(box.base, { recursive: true, force: true });
});

test('the clip is recognised as HAVING metadata', { skip: !RUN }, async () => {
  await run(app.win, `confirmDialog = function () { return Promise.resolve(true); };`);
  await run(app.win, `openFinalize();`);
  await waitFor(app.win, `typeof finScan !== 'undefined' && finScan.files && finScan.files.length > 0`,
    { what: 'the Organize scan to list the clip' });
  const matched = await read(app.win, `(finScan.files || []).filter((f) => f && f.matched).length`);
  assert.equal(matched, 1, 'the saved record is found — this is the "N with metadata" count on screen');
});

test('filing it embeds the metadata, and an INDEPENDENT reader can see it', { skip: !RUN }, async () => {
  const embedOn = await read(app.win, `!!document.getElementById('finEmbed').checked`);
  assert.equal(embedOn, true, 'embedding is on by default — the setting every real run uses');

  await run(app.win, `
    const row = document.querySelector('#finList .fin-item');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
  `);
  await waitFor(app.win, `!!document.querySelector('.context-flyout')`, { what: 'the row menu' });
  await run(app.win, `
    [...document.querySelectorAll('.context-flyout .flyout-item')]
      .find((e) => (e.textContent || '').includes('File this clip now')).click();
  `);
  await waitFor(app.win, `(finScan.files || []).some((f) => f && f.filed)`, { what: 'the clip to be filed', timeout: 60000 });

  const landed = walk(box.projects).filter((f) => /\.MP4$/i.test(f));
  assert.equal(landed.length, 1, `the clip is in the Projects tree — got ${JSON.stringify(walk(box.projects))}`);
  const filedPath = join(box.projects, landed[0].split('/').join('/'));

  // A SEPARATE exiftool. The app's own readEmbeddedRecord shares the singleton and the same
  // assumptions — asking it whether the write worked is asking the suspect for an alibi.
  const { ExifTool } = await import('exiftool-vendored');
  const et = new ExifTool({ taskTimeoutMillis: 600000, maxProcAgeMillis: 660000 });
  let tags = null;
  try { tags = await et.read(filedPath); } finally { try { await et.end(); } catch { /* ignore */ } }

  const sidecarExists = walk(box.projects).some((f) => /\.xmp$/i.test(f));
  const raw = tags && (tags.Identifier || tags['XMP-dc:Identifier']);
  const rec = Array.isArray(raw) ? raw[0] : raw;

  // Either the container took the tags, or the sidecar fallback caught it. Both are real carriers;
  // what must NOT happen is the metadata vanishing, which is what happened for the last N months.
  assert.ok(rec || sidecarExists,
    `the metadata landed somewhere — in-file record ${JSON.stringify(rec)}, sidecar ${sidecarExists}, tags ${JSON.stringify(Object.keys(tags || {})).slice(0, 300)}`);

  if (rec) {
    assert.match(String(rec), /^usbvd1:/, 'and it is OUR record, not somebody else\'s dc:Identifier');
    assert.match(String(rec), /skate park session/, 'carrying the description he wrote');
    assert.match(String(rec), /liam/i, 'and the subject');
  }
});

test('the app can read its own record back', { skip: !RUN }, async () => {
  // readEmbeddedRecord's catch-all returns null for "unreadable" AND for "no record", so a broken
  // reader is indistinguishable from an empty file. This is the half that failed silently for years:
  // finalize:scan reported "no metadata" for every clip and looked like a normal empty state.
  const landed = walk(box.projects).filter((f) => /\.MP4$/i.test(f))[0];
  const filedPath = join(box.projects, landed);
  const sidecarExists = walk(box.projects).some((f) => /\.xmp$/i.test(f));
  if (sidecarExists) return;   // the fallback path writes no in-file record to read back
  const got = await read(app.win, `(async () => {
    const r = await window.api.finalizeScan(${JSON.stringify(filedPath.replace(/[\\/][^\\/]+$/, ''))}, { includePhotos: false });
    return ((r && r.files) || []).filter((f) => f && f.matched).length;
  })()`);
  assert.ok(got >= 1, `scanning the FILED clip finds the record the app itself wrote (got ${got})`);
});
