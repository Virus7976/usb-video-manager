// #66: faces:savePending stored the renderer's clusters verbatim, so base64 crops lived INLINE — the
// reason faces-pending.json ballooned to ~9 MB and was re-serialized on every 700ms save. It now
// routes each crop out to a faces/*.jpg file like the other two stores.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

test('a pending cluster crop is externalized to a file, not stored inline base64', async () => {
  app.get('config').ai = { people: [], facesPending: [], faceScenes: [], ignored: [] };
  const dataUrl = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64');
  await app.invoke('faces:savePending', [{ thumb: dataUrl, descriptor: [0.1, 0.2], clipKeys: ['a.mp4__1'] }]);
  const pending = app.getJSON('config').ai.facesPending;
  assert.equal(pending.length, 1);
  assert.ok(!String(pending[0].thumb).startsWith('data:'), 'no inline base64 left in the store');
  assert.ok(String(pending[0].thumb).startsWith('file:'), 'crop written out to a file');
});
