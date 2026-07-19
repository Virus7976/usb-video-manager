// #45 — a group shot must survive a RESTART. Jake: "why isn't it remembering face scanning across
// sessions!!!" Two real launches on the SAME profile: name 2 of 3 faces in a group shot, quit, reopen —
// the shot must still show, with the 3rd (unnamed) face still reviewable. Reproduces the bug first, then
// guards the fix. Uses the app's real persistence + the real liveScenes filter (replicated with real
// faceDist), so it can't drift from what the user actually sees.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp, scanFolder } from './harness.mjs';
import { ensureFacesFixture } from './fixtures.mjs';

const RUN = process.env.RUN_E2E === '1';
const appData = RUN ? mkdtempSync(join(tmpdir(), 'usb-e2e-persist-')) : null;
const dir = RUN ? ensureFacesFixture() : null;
after(() => { if (appData) { try { rmSync(appData, { recursive: true, force: true }); } catch { /* ignore */ } } });

test('#45 — a partly-named group shot survives a restart (does not vanish)', { skip: !RUN }, async () => {
  // --- Session 1: detect the group, name 2 of 3, persist, quit ---
  const s1 = await launchApp({ appData });
  try {
    await scanFolder(s1.app, s1.win, dir);
    const setup = await s1.win.evaluate(async () => {
      // eslint-disable-next-line no-undef
      const clip = state.scannedFiles[0];
      // eslint-disable-next-line no-undef
      const ready = await ensureFaceModels();
      if (!ready.ok) return { ok: false, why: ready.error };
      // eslint-disable-next-line no-undef
      const res = await detectFacesForClip(clip);
      if (!res.scene || res.faces.length < 3) return { ok: false, why: `need 3 faces, got ${res.faces.length}` };
      // Build clusters exactly like the scan loop, one per detected face.
      // eslint-disable-next-line no-undef
      const clusters = res.faces.map((f) => ({ thumb: f.thumb, descriptor: f.descriptor, descriptors: [f.descriptor], clipKeys: new Set([clipKey(clip)]), suggest: null }));
      clusters[0].done = true; clusters[0].assignedName = 'Alice';   // name two of the three
      clusters[1].done = true; clusters[1].assignedName = 'Bob';
      // Persist through the app's REAL paths.
      // eslint-disable-next-line no-undef
      await noteFaceScene(clip, res.scene);
      // eslint-disable-next-line no-undef
      await saveFaceScenesNow();
      // eslint-disable-next-line no-undef
      await window.api.savePendingFaces(_serializePending(clusters));
      return { ok: true, faces: res.faces.length };
    });
    assert.equal(setup.ok, true, setup.why || 'session 1 set up');
  } finally {
    await s1.close();   // reuse-mode: does NOT delete appData
  }

  // --- Session 2: reopen the SAME profile, rebuild the review state, apply the real filter ---
  const s2 = await launchApp({ appData });
  try {
    await scanFolder(s2.app, s2.win, dir);
    const r = await s2.win.evaluate(async () => {
      // eslint-disable-next-line no-undef
      const clusters = await loadPendingFaces();
      // eslint-disable-next-line no-undef
      await ensureFaceScenes();
      // The exact liveScenes filter from showFaceReviewGrid, with the real faceDist.
      // eslint-disable-next-line no-undef
      const clusterOf = (desc) => clusters.findIndex((c) => c && !c.skipped && faceDist(c.descriptor, desc) < 0.5);
      const unresolved = (ci) => ci >= 0 && clusters[ci] && !clusters[ci].done && !clusters[ci].skipped;
      // eslint-disable-next-line no-undef
      const shown = faceScenes
        .map((s) => (s.faces || []).map((f) => clusterOf(f.descriptor)))
        .filter((cis) => cis.filter((ci) => ci >= 0).length >= 2 && cis.some(unresolved));
      // eslint-disable-next-line no-undef
      return { clusters: clusters.length, scenes: faceScenes.length, scenesShown: shown.length };
    });
    assert.ok(r.scenes >= 1, 'the group-shot scene itself persisted across the restart');
    assert.equal(r.scenesShown, 1,
      `the shot still resolves ≥2 faces with the unnamed one reviewable — it must NOT vanish (clusters restored: ${r.clusters})`);
  } finally {
    await s2.close();
  }
});
