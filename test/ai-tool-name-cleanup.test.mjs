// Audit #24 — the TOOL naming path skipped the deterministic name cleanup the legacy path guarantees.
//
// `cleanNameField()` (main-mod/07-naming-organize.js) is what turns a generic crowd word into the
// person face recognition already identified: "two men repairing mower" → "josiah-repairing-mower".
// The legacy path runs every field through it. The tool path returned `{ ...r.result }` raw, so the
// exact failure the whole shoot-context design exists to fix — men-repairing-mower never becoming
// josiah-… — came back through the new path.
//
// This is a PARITY bug in the same family as PROMPT.md §2's "the two filing paths must behave
// identically": two naming paths, one deterministic post-process, applied to only one of them.
//
// NOTE this is not a prompt/tool-string change (§8) — it applies an EXISTING deterministic transform
// to the other path's output. The model's input is untouched, so nothing needs re-measuring.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app; let calls;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

function stubOllama(respond) {
  calls = [];
  app.get('globalThis').fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    calls.push({ url: String(url), body });
    const r = respond(String(url), body, calls.length);
    return { ok: r.ok !== false, status: r.status || 200, json: async () => r.json, text: async () => JSON.stringify(r.json) };
  };
}

// Drive the tool loop straight to set_clip_name with whatever fields we want to test.
const nameWith = async (fields, people) => {
  let step = 0;
  stubOllama((url) => {
    // The handler first proves a tool-capable model exists — answer Ollama's own probes, so this
    // runs with no server and no GPU.
    if (url.includes('/api/tags')) return { json: { models: [{ name: 'qwen3:8b' }] } };
    if (url.includes('/api/show')) return { json: { capabilities: ['tools'] } };
    step += 1;
    // set_clip_name `requires: ['get_shoot_context']` — the loop's protocol guard enforces that in
    // code, so walk the real prerequisite order rather than jumping straight to the terminal tool.
    const name = step === 1 ? 'get_naming_style' : step === 2 ? 'get_shoot_context' : 'set_clip_name';
    const args = name === 'set_clip_name' ? fields : {};
    return { json: { message: { content: '', tool_calls: [{ function: { name, arguments: args } }] } } };
  });
  return app.plain(await app.invoke('ai:nameFromObservation', {
    model: 'qwen3:8b',
    observation: 'two men sitting on a cut lawn beside a mower',
    subjects: ['lawn-mowing', 'vlog'],
    people: people || [],
    date: '2026-06-01',
  }));
};

test('#24 a recognised person replaces the generic crowd word', async () => {
  const r = await nameWith({ subject: 'lawn-mowing', description: 'two men repairing mower' }, ['Josiah Gour']);
  assert.equal(r.ok, true, `named: ${r.error || ''}`);
  assert.match(r.description, /josiah/i, 'the recognised name is injected — this is the whole point');
  assert.equal(/\bmen\b/i.test(r.description), false, 'and the generic word is gone');
});

test('#24 with nobody recognised the generic word is kept, not invented over', async () => {
  // The dangerous direction: injecting a name nobody identified would be a confident lie in a
  // filename, which is far worse than a vague-but-true one.
  const r = await nameWith({ subject: 'lawn-mowing', description: 'two men repairing mower' }, []);
  assert.equal(r.ok, true);
  assert.match(r.description, /men/i, 'no name known → the cleaned generic survives');
  assert.equal(/josiah/i.test(r.description), false, 'nothing is invented');
});

test('#24 the subject is cleaned the same way as the description', async () => {
  const r = await nameWith({ subject: 'Lawn Mowing', description: 'mower repair' }, []);
  assert.equal(r.ok, true);
  assert.equal(r.subject, 'lawn-mowing', 'slugged exactly like the legacy path');
});

test('#24 a clean name passes through unchanged', async () => {
  // Cleanup must be a no-op on output that is already right — otherwise it is mangling good names.
  const r = await nameWith({ subject: 'vlog', description: 'walking the dog at sunset' }, []);
  assert.equal(r.ok, true);
  assert.equal(r.subject, 'vlog');
  assert.match(r.description, /walking-the-dog|walking the dog/i);
});
