// Audit #94 — the preload ran UNSANDBOXED for no reason.
//
// `sandbox: false` gives the preload a full Node process. preload.js needs none of it: it requires
// only electron's `contextBridge` + `ipcRenderer`, both of which a SANDBOXED preload still gets.
// So the sandbox costs nothing and hardens the one privileged surface in the app.
//
// It matters more here than in a typical Electron app because `webSecurity: false` sits right below
// it — a deliberate trade so Chromium's native file loader can seek HEVC over file://. That means
// rendered filenames and AI text run in a renderer with the brakes off. If anything ever achieves
// script execution there, the sandbox is what stops it reaching a full Node process.
//
// VERIFIED, not reasoned: the whole 40-test e2e suite (real app boot, folder scan, real face-api
// detection over WebGL, IPC round-trips, modals, seeded stores) passes with the sandbox ON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreSrc = fs.readFileSync(path.join(ROOT, 'main-mod/01-core.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');

test('#94 the preload is sandboxed', () => {
  assert.match(coreSrc, /sandbox:\s*true/, 'the privileged bridge runs sandboxed');
  assert.equal(/sandbox:\s*false/.test(coreSrc), false, 'and nothing re-opens it');
});

test('#94 the isolation around it is intact', () => {
  // The sandbox is one of three; weakening either of the others would undo the point of it.
  assert.match(coreSrc, /contextIsolation:\s*true/);
  assert.match(coreSrc, /nodeIntegration:\s*false/);
});

test('#94 the preload stays Node-free — the precondition for the sandbox', () => {
  // THIS is the guard that matters going forward. A sandboxed preload may only require 'electron';
  // adding `require('fs')` here would keep passing review and then fail at RUNTIME in the packaged
  // app, which is the worst place to find out. Fail it at test time with a message that says why.
  const requires = [...preloadSrc.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['electron'],
    'a sandboxed preload can only require "electron" — move Node work into main and expose it over IPC');
});

test('#94 webSecurity is still off, and that is WHY the sandbox matters', () => {
  // Not an endorsement — a reminder. If webSecurity is ever restored, this note should be revisited
  // rather than silently left describing something that is no longer true.
  assert.match(coreSrc, /webSecurity:\s*false/,
    'if this ever becomes true, revisit the reasoning above (the sandbox is still worth keeping)');
});
