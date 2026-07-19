// BUG: phone:pull staged files by mere EXISTENCE — it stat'd the destination and pushed it, never
// comparing to the known source size. A truncated pull (MTP CopyHere timeout / dropped connection)
// left a short file that was then renamed, moved to Uncompressed, and compressed into the archive as
// a corrupt clip. The pull now stages on COMPLETENESS: a file short of its source size is declined
// (the phone still holds the original). These tests pin that with a stubbed MTP transport.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app; let dir;
before(() => { app = loadMain(); dir = mkdtempSync(join(tmpdir(), 'staging-')); });
after(() => { try { app.dispose(); } catch { /* ignore */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

// Fake the MTP copy: write each item to dest at FULL size, except any whose name contains "trunc",
// which we write 5 bytes short — simulating an interrupted transfer that left a short file behind.
function installFakeMtp() {
  app.get(`mtpCopyToDest = async (device, list, dest, prog) => {
    const fs = require('fs'); const path = require('path');
    for (const it of list) {
      const bytes = /trunc/.test(it.name) ? Math.max(0, (it.size || 0) - 5) : (it.size || 0);
      fs.writeFileSync(path.join(dest, it.name), Buffer.alloc(bytes));
      if (prog) prog(it.name);
    }
  }`);
}

test('a truncated (short) staged file is declined; the complete one is staged', async () => {
  installFakeMtp();
  const photoDest = join(dir, 'photos-a');
  const r = await app.invoke('phone:pull', {
    device: 'Phone', photoDest, videoDest: photoDest, sim: false,
    items: [
      { name: 'good.jpg', size: 200, kind: 'photo', abs: 'x' },
      { name: 'trunc.jpg', size: 200, kind: 'photo', abs: 'y' },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.incomplete, 1, 'the short file is counted as incomplete');
  assert.equal(r.copied, 1, 'only the complete file is staged');
  assert.equal(r.staged.length, 1, 'exactly one staged');
  assert.equal(r.staged[0].name, 'good.jpg', 'the corrupt clip never reaches finalize');
  assert.equal(existsSync(join(photoDest, 'trunc.jpg')), false, 'the truncated file is DELETED, not left for resume to re-trust');
  assert.equal(existsSync(join(photoDest, 'good.jpg')), true, 'the complete file stays');
});

test('when the source size is unknown (0), the file is still staged (no false reject)', async () => {
  installFakeMtp();
  const photoDest = join(dir, 'photos-b');
  const r = await app.invoke('phone:pull', {
    device: 'Phone', photoDest, videoDest: photoDest, sim: false,
    items: [{ name: 'unknown.jpg', size: 0, kind: 'photo', abs: 'z' }],
  });
  assert.equal(r.incomplete, 0);
  assert.equal(r.copied, 1, 'unknown-size devices keep the old behavior — no data dropped');
});
