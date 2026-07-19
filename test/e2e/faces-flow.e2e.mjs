// The face pipeline, end-to-end, on the REAL app — the app's most bug-prone area, and the thing that
// was truly untestable before this harness (face-api + tfjs/WebGL + ffmpeg frame extraction). Proving
// it here is the foundation for verifying the face-review fixes (#45/#46/#84) instead of guessing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchApp, scanFolder } from './harness.mjs';
import { ensureFacesFixture } from './fixtures.mjs';

const RUN = process.env.RUN_E2E === '1';
let app;
const dir = RUN ? ensureFacesFixture() : null;
before(async () => { if (RUN) { app = await launchApp(); await scanFolder(app.app, app.win, dir); } });
after(async () => { if (app) await app.close(); });

test('face detection runs end-to-end and captures the group shot (#45 foundation, #84 flag)', { skip: !RUN }, async () => {
  const r = await app.win.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const clip = state.scannedFiles[0];
    // eslint-disable-next-line no-undef
    const ready = await ensureFaceModels();
    if (!ready.ok) return { ok: false, why: ready.error };
    // eslint-disable-next-line no-undef
    const res = await detectFacesForClip(clip);
    return {
      ok: true,
      faces: res.faces.length,
      sceneFaces: res.scene ? res.scene.faces.length : 0,
      detectError: !!res.detectError,
    };
  });
  assert.equal(r.ok, true, r.why || 'face models loaded');
  assert.ok(r.faces >= 2, `merged multiple distinct faces from the clip (got ${r.faces})`);
  assert.ok(r.sceneFaces >= 2, `the group-shot scene holds >=2 faces together (got ${r.sceneFaces})`);
  assert.equal(r.detectError, false, '#84 — a clean detection run does NOT flag detectError');
});

test('#46 — ignoring a face makes matchPerson flag it (so the scan loop skips it), without sweeping up others', { skip: !RUN }, async () => {
  const r = await app.win.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const clip = state.scannedFiles[0];
    // eslint-disable-next-line no-undef
    const ready = await ensureFaceModels();
    if (!ready.ok) return { ok: false, why: ready.error };
    // eslint-disable-next-line no-undef
    const res = await detectFacesForClip(clip);
    if (res.faces.length < 3) return { ok: false, why: `need 3 faces, got ${res.faces.length}` };
    // Ignore the FIRST detected face (a statue/poster/TV in real use), then ask the matcher about it
    // and about a DIFFERENT face. #46's renderer guard is `if (m.ignored) continue`.
    // eslint-disable-next-line no-undef
    await window.api.ignoreFace({ descriptor: res.faces[0].descriptor, thumb: res.faces[0].thumb });
    // eslint-disable-next-line no-undef
    const mIgnored = await window.api.matchPerson({ descriptor: res.faces[0].descriptor, threshold: 0.54 });
    // eslint-disable-next-line no-undef
    const mOther = await window.api.matchPerson({ descriptor: res.faces[2].descriptor, threshold: 0.54 });
    return { ok: true, ignoredFlag: !!mIgnored.ignored, otherIgnored: !!mOther.ignored };
  });
  assert.equal(r.ok, true, r.why || 'detected 3 faces');
  assert.equal(r.ignoredFlag, true, 'the ignored face is flagged ignored → the scan loop continues past it');
  assert.equal(r.otherIgnored, false, 'a different person is NOT swept up by the ignore');
});
