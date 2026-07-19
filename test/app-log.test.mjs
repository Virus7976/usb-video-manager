// #81 — persistent, rotating application log. The windowless packaged build sent every console.*
// nowhere, leaving no trail for a user's "it forgot my settings / just closed" report. Output now
// mirrors to userData/app.log, bounded by a roll to app.log.1 past ~1 MB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMain } from './harness.mjs';

test('appendLog writes a timestamped, levelled line to app.log', async () => {
  const app = await loadMain();
  const logFile = path.join(app.dirs.userData, 'app.log');
  try { fs.rmSync(logFile, { force: true }); } catch { /* ignore */ }
  await app.call('appendLog', 'INFO', ['hello-marker-42']);
  const body = fs.readFileSync(logFile, 'utf8');
  assert.match(body, /INFO: hello-marker-42/, 'level + message present');
  assert.match(body, /^\[\d{4}-\d\d-\d\dT[\d:.]+Z\] /m, 'ISO timestamp prefix');
});

test('appendLog stringifies non-string args (Error → stack, object → inspect) and never throws', async () => {
  const app = await loadMain();
  const logFile = path.join(app.dirs.userData, 'app.log');
  try { fs.rmSync(logFile, { force: true }); } catch { /* ignore */ }
  await app.call('appendLog', 'ERROR', ['ctx', { a: 1 }]);
  const body = fs.readFileSync(logFile, 'utf8');
  assert.match(body, /ERROR: ctx .*a: 1/, 'object serialized inline');
});

test('the log rolls to app.log.1 once it passes the size cap', async () => {
  const app = await loadMain();
  const logFile = path.join(app.dirs.userData, 'app.log');
  const rolled = `${logFile}.1`;
  fs.writeFileSync(logFile, 'x'.repeat(1024 * 1024 + 16));   // seed just over LOG_MAX_BYTES
  try { fs.rmSync(rolled, { force: true }); } catch { /* ignore */ }
  await app.call('appendLog', 'INFO', ['after-the-roll']);
  assert.ok(fs.existsSync(rolled), 'the oversized log was rolled to app.log.1');
  const body = fs.readFileSync(logFile, 'utf8');
  assert.ok(body.length < 1024 * 1024, 'a fresh, small log was started');
  assert.match(body, /after-the-roll/, 'the new line landed in the fresh log');
});
