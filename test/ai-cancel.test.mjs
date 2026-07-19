// Audit #78 — Ollama requests were not cancellable, so "Cancel" waited out the full timeout.
//
// `ollamaFetch` attached only `AbortSignal.timeout(...)`. The renderer's `aiAborted` flag is checked
// BETWEEN clips, so pressing Cancel mid-request left the current call running to completion — up to
// 180 s for a vision call, and up to the whole tool loop for naming. "Cancelling…" sitting there for
// minutes per stuck clip is the single most trust-destroying thing a long job can do.
//
// The fix is a shared cancel token every in-flight request also listens to. The subtle part is what
// happens AFTER a cancel: if the token isn't renewed, every later request aborts instantly and the
// AI is dead until restart — a far worse bug than the one being fixed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

// Capture the signal each request is issued with, and hold the request open until we release it.
function stubCapturing() {
  const seen = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  app.get('globalThis').fetch = async (url, init) => {
    seen.push(init && init.signal);
    await gate;
    return { ok: true, status: 200, json: async () => ({ message: { content: 'hi', tool_calls: [] } }), text: async () => '{}' };
  };
  return { seen, release: () => release() };
}

test('#78 every Ollama request carries a signal', async () => {
  const { seen, release } = stubCapturing();
  const p = app.call('ollamaFetch', '/api/tags', {}, 5000);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(seen[0], 'a signal is attached');
  assert.equal(typeof seen[0].aborted, 'boolean');
  release(); await p;
});

test('#78 ai:cancel aborts a request that is already in flight', async () => {
  const { seen, release } = stubCapturing();
  const p = app.call('ollamaFetch', '/api/chat', {}, 180000);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen[0].aborted, false, 'still running before the cancel');

  await app.invoke('ai:cancel');
  assert.equal(seen[0].aborted, true, 'the in-flight request is aborted — not left to run out its 180s');
  release(); await p.catch(() => {});
});

test('#78 a cancel does NOT poison the next run', async () => {
  // THE regression that would matter most: if the shared token is not renewed after an abort, every
  // subsequent request fails instantly and the AI never works again until the app restarts.
  await app.invoke('ai:cancel');
  const { seen, release } = stubCapturing();
  const p = app.call('ollamaFetch', '/api/tags', {}, 5000);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen[0].aborted, false, 'the next request starts with a FRESH, unaborted token');
  release(); await p;
});

test('#78 cancelling twice is harmless', async () => {
  await app.invoke('ai:cancel');
  const r = await app.invoke('ai:cancel');
  assert.notEqual(r, undefined, 'a second cancel with nothing in flight is a no-op, not a throw');
});
