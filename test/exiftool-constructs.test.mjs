// ALL OF EXIFTOOL HAS BEEN DEAD SINCE 0.4.15, and nothing noticed.
//
// `getExifTool()` raised `taskTimeoutMillis` to 600000 — for a good reason, documented right above
// it: writing XMP into an MP4 makes exiftool rewrite the whole file, and a multi-GB GoPro clip can
// take minutes. But BatchCluster validates its options in the CONSTRUCTOR:
//
//     maxProcAgeMillis must be greater than or equal to 600000:
//     the max value of spawnTimeoutMillis (30000) and taskTimeoutMillis (600000)
//
// The default `maxProcAgeMillis` is below that, so `new ExifTool(...)` THREW. Every time. And since
// this one lazily-constructed singleton is what every read and every write goes through — embedding
// at finalize, reading a record back, the phone path — the app has been structurally unable to touch
// file metadata for the entire life of the modular main process.
//
// Nothing caught it because nothing ever exercised a real embed:
//   • the vm suite loads main.js but never spawns exiftool;
//   • the one existing filing e2e runs with embedding OFF;
//   • the renderer swallows it — finalize:run's per-item try/catch turns the throw into an entry in
//     `summary.errors`, so the run still reports ok and the screen still says "Done".
//
// It surfaced only when the NEW one-clip e2e filed with the embed checkbox at its real default (ON)
// and read the toast text, which is the whole argument for driving the real thing: a structural test
// cannot see a constructor that throws.
//
// This test constructs it for real. Mocking the options object would test my arithmetic, not the
// library's rule — and the library's rule is the thing that broke.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('the ExifTool singleton can actually be constructed', async () => {
  const { ExifTool } = await import('exiftool-vendored');
  // The exact options main uses. Read them out of the source rather than restating them, so this
  // test tracks the real call instead of a copy of it that can drift.
  const src = readFileSync(join(process.cwd(), 'main-mod', '02-media.js'), 'utf8').replace(/\/\/.*$/gm, '');
  const call = src.slice(src.indexOf('_exiftool = new ExifTool('));
  const opts = call.slice(call.indexOf('{'), call.indexOf('});') + 1);
  const task = Number((opts.match(/taskTimeoutMillis:\s*(\d+)/) || [])[1] || 0);
  const age = Number((opts.match(/maxProcAgeMillis:\s*(\d+)/) || [])[1] || 0);
  assert.ok(task > 0, `main sets a task timeout — parsed ${task} from ${opts}`);
  assert.ok(age > 0, `and a process age — parsed ${age} from ${opts}`);

  let et = null;
  try {
    et = new ExifTool({ taskTimeoutMillis: task, maxProcAgeMillis: age });
  } catch (e) {
    assert.fail(`new ExifTool threw with main's own options — this kills ALL metadata: ${e.message}`);
  } finally {
    if (et) { try { await et.end(); } catch { /* ignore */ } }
  }
});

test('the process is allowed to outlive the longest task it can run', () => {
  // The library's rule, stated as the invariant rather than as two magic numbers: a process that is
  // recycled sooner than a task is allowed to take can never finish that task.
  const src = readFileSync(join(process.cwd(), 'main-mod', '02-media.js'), 'utf8').replace(/\/\/.*$/gm, '');
  const call = src.slice(src.indexOf('_exiftool = new ExifTool('));
  const opts = call.slice(call.indexOf('{'), call.indexOf('});') + 1);
  const task = Number((opts.match(/taskTimeoutMillis:\s*(\d+)/) || [])[1] || 0);
  const age = Number((opts.match(/maxProcAgeMillis:\s*(\d+)/) || [])[1] || 0);
  const SPAWN_DEFAULT = 30000;   // the other half of the library's max()
  assert.ok(age >= Math.max(task, SPAWN_DEFAULT),
    `maxProcAgeMillis (${age}) must be >= max(taskTimeoutMillis ${task}, spawnTimeout ${SPAWN_DEFAULT})`);
});

test('raising the task timeout alone is what broke it', async () => {
  // Prove the failure mode is real and not a story I told about it — construct the OLD options and
  // assert they throw. If a future library version relaxes this, this test says so loudly rather
  // than leaving a mysterious constant behind.
  const { ExifTool } = await import('exiftool-vendored');
  let threw = false; let et = null;
  try {
    et = new ExifTool({ taskTimeoutMillis: 600000 });
  } catch {
    threw = true;
  } finally {
    if (et) { try { await et.end(); } catch { /* ignore */ } }
  }
  assert.equal(threw, true, 'the pre-fix options really do throw from the constructor');
});
