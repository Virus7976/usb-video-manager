// FEATURES.md items 12 and 13 — upload footage from the phone, resumably.
//
// The API and the resumable core have existed and been tested for a while. Nothing on the phone
// could reach them: `server/public/review.html` was the face review and nothing else. So the
// capability was real and unusable — this project's single most repeated shape, and the reason the
// desktop ingest I added last iteration had nothing to consume in practice.
//
// ⚠ THE CONTRACT WAS PROBED, NOT ASSUMED. My first draft read `beg.received`; the core actually
// returns `offset`:
//
//     begin  -> {ok, id, offset}
//     append -> {ok, offset, complete}
//     finish -> {ok, name, bytes, path}
//
// `received` is undefined, so every upload would have restarted from byte zero — quietly defeating
// the entire point of a resumable transfer, while appearing to work on a fast connection with a
// small file. Same class as the `items`/`moves` and `q`/`query` mistakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const upload = require('../core/upload.js');
const html = readFileSync(join(ROOT, 'server/public/review.html'), 'utf8');

test('⚠ CONTROL — the resumable core really is resumable', () => {
  // Everything below rests on this. If a fresh `begin` did not report a resumable offset, the client
  // could not be written correctly no matter what it did.
  const dir = mkdtempSync(join(tmpdir(), 'up-'));
  try {
    const b = upload.begin({ dir, name: 'clip.mp4', size: 10, at: Date.now() });
    assert.equal(b.ok, true);
    assert.equal(b.offset, 0, '⚠ a new upload starts at 0');

    const half = upload.appendChunk({ dir, id: b.id, offset: 0, buf: Buffer.from('01234') });
    assert.equal(half.offset, 5, '⚠ and reports how far it got');

    // The interruption: ask again, and it must remember.
    const again = upload.status({ dir, id: b.id });
    assert.equal(again.offset, 5, '⚠⚠ an interrupted upload resumes from 5, not from 0');

    const rest = upload.appendChunk({ dir, id: b.id, offset: 5, buf: Buffer.from('56789') });
    assert.equal(rest.complete, true);
    const fin = upload.finish({ dir, id: b.id });
    assert.equal(fin.ok, true);
    assert.equal(readFileSync(fin.path, 'utf8'), '0123456789', '⚠⚠ reassembled byte-for-byte');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('⚠⚠⚠ the phone client uses the REAL field name, so resume actually resumes', () => {
  assert.match(html, /Number\(beg\.offset\)/, '⚠⚠⚠ starts from what the server already has');
  assert.match(html, /Number\(r\.offset\)/, '⚠⚠ and advances by what the server confirms');
  // ⚠ Strip comments first. The code carries a comment EXPLAINING the old field name, and the first
  // version of this assertion matched that comment and failed against correct code. A test that
  // greps source must look at the source, not at the prose about it.
  const code = html.replace(/\/\/.*$/gm, '');
  assert.ok(!/beg\.received|r\.received/.test(code),
    '⚠⚠⚠ `received` does not exist — reading it restarts every upload from zero');
});

test('⚠⚠ it sends in chunks, not one giant request', () => {
  // A single POST of a 4 GB clip restarts from zero every time the phone sleeps, which for footage
  // means it effectively never completes.
  assert.match(html, /const CHUNK = 1024 \* 1024/, 'chunked');
  assert.match(html, /file\.slice\(offset, end\)/, 'and slices from the resumed offset');
  assert.match(html, /\/api\/upload\/begin/, 'through the resumable API');
  assert.match(html, /\/finish/, 'and finishes explicitly');
});

test('⚠⚠ an interrupted upload is described as a PAUSE, not a loss', () => {
  // What he does next depends entirely on this wording. "Failed" makes him start again by hand,
  // which is the exact thing resumable uploads exist to prevent.
  assert.match(html, /is already there, pick it again to carry on/,
    '⚠⚠ it says the bytes already sent are safe');
  assert.match(html, /nothing was lost/, '⚠⚠ and the summary says so too');
});

test('⚠ a partial batch reports BOTH numbers', () => {
  // "3 sent" while 2 failed is the report shape this project has been burned by repeatedly.
  assert.match(html, /\$\{done\} sent · \$\{failed\} didn’t finish/, '⚠ both counts');
});

test('⚠⚠ the send UI is REACHABLE — hidden until paired, then shown', () => {
  assert.match(html, /id="send"/, 'the section exists');
  assert.match(html, /\$\('send'\)\.classList\.remove\('hide'\)/,
    '⚠⚠ and is revealed once paired — a screen nothing unhides is the same as no screen');
  assert.match(html, /id="pick"[^>]*type="file"/, 'with a real file picker');
});
