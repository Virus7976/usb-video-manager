// Renderer boot-cost guards.
//
// face-api.min.js is 1.3 MB (it bundles TensorFlow.js). It used to be a blocking <script>
// ahead of renderer.js, so every launch paid for it even when face recognition was never
// opened. It is now injected on first use by loadFaceApiLib().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// Pull a top-level `function <name>(…) {…}` out of a plain (non-module) source file by
// brace-matching, so the test runs the REAL shipping source rather than a transcription.
function extractFn(relFile, name, injected = []) {
  const src = read(relFile);
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in ${relFile}`);
  let depth = 0; let end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  // eslint-disable-next-line no-new-func
  return new Function(...injected, `let _faceLibPromise = null; ${src.slice(start, end)}; return ${name};`);
}

test('index.html does not load face-api.min.js at boot', () => {
  const html = read('src/index.html');
  const tags = [...html.matchAll(/<script[^>]*src=["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(tags, ['renderer.js'], 'renderer.js should be the ONLY boot script');
  assert.equal(/<script[^>]*face-api/.test(html), false, 'face-api must not be a blocking boot script');
});

test('face-api.min.js is still shipped, and is big enough to be worth deferring', () => {
  const bytes = readFileSync(join(ROOT, 'src/face-api.min.js')).length;
  assert.ok(bytes > 500_000, 'the library is still vendored in for lazy loading');
});

// --- loadFaceApiLib: the on-demand injector -------------------------------------------

/** Minimal window/document stubs; `behavior` decides whether the injected script "loads". */
function domStub(behavior) {
  const appended = [];
  const window = {};
  const document = {
    head: { appendChild: (el) => { appended.push(el); behavior(el, window); } },
    createElement: () => ({ src: '', onload: null, onerror: null }),
  };
  return { window, document, appended };
}

test('loadFaceApiLib injects the script exactly once and resolves with faceapi', async () => {
  const { window, document, appended } = domStub((el, win) => {
    win.faceapi = { nets: {} };            // the real library defines window.faceapi
    queueMicrotask(() => el.onload());
  });
  const loadFaceApiLib = extractFn('src/mod/08-people.js', 'loadFaceApiLib', ['window', 'document'])(window, document);

  const [a, b] = await Promise.all([loadFaceApiLib(), loadFaceApiLib()]);
  assert.equal(appended.length, 1, 'concurrent callers share ONE <script> insert');
  assert.equal(appended[0].src, 'face-api.min.js');
  assert.ok(a && a.nets);
  assert.equal(a, b);
});

test('loadFaceApiLib short-circuits once faceapi is already present', async () => {
  const { window, document, appended } = domStub(() => { throw new Error('must not inject'); });
  window.faceapi = { nets: {} };
  const loadFaceApiLib = extractFn('src/mod/08-people.js', 'loadFaceApiLib', ['window', 'document'])(window, document);
  assert.ok(await loadFaceApiLib());
  assert.equal(appended.length, 0, 'no second <script> once the lib is loaded');
});

test('loadFaceApiLib resolves null when the library is missing, and allows a retry', async () => {
  let attempt = 0;
  const { window, document, appended } = domStub((el, win) => {
    attempt += 1;
    if (attempt === 1) queueMicrotask(() => el.onerror());          // not vendored in
    else { win.faceapi = { nets: {} }; queueMicrotask(() => el.onload()); }
  });
  const loadFaceApiLib = extractFn('src/mod/08-people.js', 'loadFaceApiLib', ['window', 'document'])(window, document);

  assert.equal(await loadFaceApiLib(), null, 'a failed load degrades gracefully');
  assert.ok(await loadFaceApiLib(), 'the failure is not cached — a later attempt can retry');
  assert.equal(appended.length, 2);
});
