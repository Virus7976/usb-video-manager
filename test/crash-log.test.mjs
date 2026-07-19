// A long-lived tray process with ~150 async IPC handlers used to die SILENTLY on any unhandled
// rejection/throw (no dialog; windowless build's console goes nowhere). Global handlers now log to
// userData/crash.log and keep the process alive. This pins that the durable crash record is written.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

test('logCrash writes a timestamped entry to userData/crash.log', () => {
  app.call('logCrash', 'uncaughtException', new Error('boom-xyz'));
  const p = join(app.dirs.userData, 'crash.log');
  assert.equal(existsSync(p), true, 'crash.log exists');
  const txt = readFileSync(p, 'utf8');
  assert.match(txt, /uncaughtException: Error: boom-xyz/, 'the crash kind + message are recorded');
  assert.match(txt, /^\[\d{4}-\d{2}-\d{2}T/, 'with an ISO timestamp');
});

test('the global handlers are registered (process survives an unhandled rejection)', () => {
  // Both handlers exist so Node does not crash on an unhandled rejection/exception.
  assert.ok(process.listenerCount('uncaughtException') >= 1, 'uncaughtException handler registered');
  assert.ok(process.listenerCount('unhandledRejection') >= 1, 'unhandledRejection handler registered');
});
