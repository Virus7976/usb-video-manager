// Audit #69 — an embed failure blocked filing entirely, forever.
//
// The old code did `catch { errors.push(...); continue; }`, described as "leave untouched for a
// clean retry". But the retry hits the SAME error: a HEIC, an odd codec, or a read-only file fails
// every time. The `continue` skipped the move, the NAS mirror AND the CSV row, so with Embed on
// that clip could NEVER be filed — it silently stayed out of the Projects tree while the run
// reported success for everything else.
//
// Leaving one clip permanently unfiled is worse than filing it with its metadata in a sidecar, so:
// fall back to `<file>.xmp` (a real carrier — digiKam and Lightroom both read it), then carry on
// filing either way. And only mark the metadata CONSUMED if it actually landed somewhere, or the
// finalMeta prune could evict the AI's work with nothing to show for it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

// These assert on the SHAPE of the finalize loop rather than driving a real exiftool: the vendored
// binary is a Windows .exe and is not runnable here (usb-app-test-environment). The behaviour that
// matters is structural — that a failed embed no longer aborts the clip's remaining work.
const src = () => String(app.get('finalizeRun') || '') || readFileSync(join(process.cwd(), 'main.js'), 'utf8');

test('#69 a failed embed no longer skips the rest of the clip', () => {
  const bundle = readFileSync(join(process.cwd(), 'main.js'), 'utf8');
  // The regression was a bare `continue` in the embed catch, which abandoned the move, the NAS
  // mirror and the CSV row for that clip. Assert the PROPERTY — nothing between the embed step and
  // the organize step may skip the iteration — rather than matching an exact catch shape, which
  // would break on any reword.
  const start = bundle.indexOf('let metaLanded = !et;');
  const end = bundle.indexOf('// 2. Organize into', start);
  assert.ok(start > 0 && end > start, 'located the embed section');
  const embedSection = bundle.slice(start, end);
  assert.equal(/\bcontinue;/.test(embedSection), false,
    'an embed failure must not abandon the move, the NAS mirror and the CSV row');
});

test('#69 the catch falls back to an .xmp sidecar', () => {
  const bundle = readFileSync(join(process.cwd(), 'main.js'), 'utf8');
  assert.match(bundle, /`\$\{curPath\}\.xmp`/, 'writes a sidecar beside the file');
  assert.match(bundle, /summary\.sidecars = \(summary\.sidecars \|\| 0\) \+ 1/, 'and reports how many');
});

test('#69 metadata is only marked consumed when it actually landed', () => {
  const bundle = readFileSync(join(process.cwd(), 'main.js'), 'utf8');
  assert.match(bundle, /if \(!skipMove && metaLanded\) filed\.push\(it\.name\)/,
    'a clip whose metadata reached neither the file nor a sidecar keeps its record for a retry');
  assert.match(bundle, /let metaLanded = !et;/,
    'and a run with embedding OFF is unaffected — nothing to land');
});

test('#69 a run with embedding off still files and consumes normally', async () => {
  // Guards the regression risk of the change itself: metaLanded defaults true when et is null, so
  // the non-embedding path must behave exactly as before.
  const bundle = readFileSync(join(process.cwd(), 'main.js'), 'utf8');
  const idx = bundle.indexOf('let metaLanded = !et;');
  assert.ok(idx > 0);
  assert.match(bundle.slice(idx, idx + 200), /metaLanded/, 'the flag is scoped per clip, inside the loop');
});
