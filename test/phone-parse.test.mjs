// Characterization tests for the phone stack's PURE PARSERS — the most re-touched,
// most fragile surface in the app (~25 of 78 commits). This machine has no adb and no
// phone, so we exercise the parsing/derivation helpers with recorded/synthetic input
// (the exact byte-shapes PowerShell and `adb` emit), NOT by attaching a device.
//
// Everything here asserts what the code DOES today. Where a test documents a bug, the
// assertion pins the CURRENT (buggy) output and says so — see the FINAL REPORT for the
// repros and severities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

// One shared instance is fine: every function under test is pure (no config/disk state).
const m = loadMain();
const P = (v) => m.plain(v);

// ---------------------------------------------------------------------------
// parsePsJson — pull the JSON array/object out of PowerShell stdout.
// (main-mod/05-windows-phone.js:44)
// ---------------------------------------------------------------------------
test('parsePsJson: a bare JSON array is returned as-is', () => {
  assert.deepEqual(P(m.call('parsePsJson', '[{"name":"Galaxy","kind":"phone"}]')),
    [{ name: 'Galaxy', kind: 'phone' }]);
});

test('parsePsJson: a bare JSON OBJECT is normalized to a 1-element array', () => {
  // THE classic PowerShell gotcha: ConvertTo-Json emits a bare object (not a
  // 1-element array) when the pipeline yields exactly one item. parsePsJson's
  // `Array.isArray(j) ? j : [j]` is precisely the defense — so "exactly one phone"
  // does NOT silently break. This is the definitive answer to the single-element hunt.
  assert.deepEqual(P(m.call('parsePsJson', '{"name":"Galaxy","kind":"phone"}')),
    [{ name: 'Galaxy', kind: 'phone' }]);
});

test('parsePsJson: a compact single object (as ConvertTo-Json -Compress emits) wraps', () => {
  assert.deepEqual(P(m.call('parsePsJson', '{"album":"Camera","count":42}')),
    [{ album: 'Camera', count: 42 }]);
});

test('parsePsJson: JSON preceded by a profile/warning banner (no braces) is recovered', () => {
  const stdout = 'WARNING: module loaded\nSome profile banner text\n[{"name":"P","kind":"phone"}]';
  assert.deepEqual(P(m.call('parsePsJson', stdout)), [{ name: 'P', kind: 'phone' }]);
});

test('parsePsJson: empty string -> []', () => {
  assert.deepEqual(P(m.call('parsePsJson', '')), []);
});

test('parsePsJson: whitespace-only -> []', () => {
  assert.deepEqual(P(m.call('parsePsJson', '   \n\t  \r\n ')), []);
});

test('parsePsJson: JS null -> []', () => {
  assert.deepEqual(P(m.call('parsePsJson', null)), []);
});

test('parsePsJson: undefined -> []', () => {
  assert.deepEqual(P(m.call('parsePsJson', undefined)), []);
});

test('parsePsJson: non-JSON garbage -> []', () => {
  assert.deepEqual(P(m.call('parsePsJson', 'total garbage, no json here')), []);
});

test('parsePsJson: a null result -> [] (not [null])', () => {
  // JSON.parse("null") === null. Wrapping it produced [null] — a hole every caller had to
  // filter out. An empty list is what "no results" actually means.
  assert.deepEqual(P(m.call('parsePsJson', 'null')), []);
});

// ---- Regression guards: a stray stdout line must never hide the real JSON ----
// Every case below used to return [], i.e. "no phone attached", with no error surfaced.
test('parsePsJson: a banner line containing "{" does not hide the real JSON', () => {
  const stdout = 'DEBUG {module} initialized\n[{"name":"Galaxy","kind":"phone"}]';
  assert.deepEqual(P(m.call('parsePsJson', stdout)), [{ name: 'Galaxy', kind: 'phone' }],
    'a brace in the banner must not defeat recovery');
});

test('parsePsJson: a banner line starting with "[" does not hide the real JSON', () => {
  const stdout = '[notice] profile loaded\n[{"name":"Galaxy","kind":"phone"}]';
  assert.deepEqual(P(m.call('parsePsJson', stdout)), [{ name: 'Galaxy', kind: 'phone' }]);
});

test('parsePsJson: valid JSON followed by a trailing warning line still parses', () => {
  const stdout = '[{"name":"Galaxy","kind":"phone"}]\nWARNING: something happened after';
  assert.deepEqual(P(m.call('parsePsJson', stdout)), [{ name: 'Galaxy', kind: 'phone' }]);
});

test('parsePsJson: a Windows path with braces in the banner does not hide the JSON', () => {
  const stdout = 'Loading C:\\Users\\{guid}\\profile.ps1\n[{"name":"Pixel","kind":"phone"}]';
  assert.deepEqual(P(m.call('parsePsJson', stdout)), [{ name: 'Pixel', kind: 'phone' }]);
});

test('parsePsJson: a brace inside a JSON string value is not treated as structure', () => {
  const stdout = 'noise {x\n[{"name":"Odd } phone","kind":"phone"}]';
  assert.deepEqual(P(m.call('parsePsJson', stdout)), [{ name: 'Odd } phone', kind: 'phone' }]);
});

test('parsePsJson: a single phone (bare object from ConvertTo-Json) still normalizes to an array', () => {
  // PowerShell emits an object, not a 1-element array, when there is exactly one result.
  const stdout = 'WARNING: {noise}\n{"name":"Solo","kind":"phone"}';
  assert.deepEqual(P(m.call('parsePsJson', stdout)), [{ name: 'Solo', kind: 'phone' }]);
});

// ---------------------------------------------------------------------------
// adbParseDevices — parse `adb devices` output. (05-windows-phone.js:335)
// The app calls `adb devices` (NOT `-l`); output is TAB-separated: "<serial>\t<state>".
// ---------------------------------------------------------------------------
test('adbParseDevices: a single authorized device', () => {
  const out = 'List of devices attached\nemulator-5554\tdevice\n';
  assert.deepEqual(P(m.call('adbParseDevices', out)), { device: 'emulator-5554', unauthorized: false });
});

test('adbParseDevices: header + trailing blank lines are ignored', () => {
  const out = 'List of devices attached\nR58N12345AB\tdevice\n\n\n';
  assert.deepEqual(P(m.call('adbParseDevices', out)), { device: 'R58N12345AB', unauthorized: false });
});

test('adbParseDevices: CRLF line endings (Windows adb) are handled', () => {
  const out = 'List of devices attached\r\nR58N12345AB\tdevice\r\n\r\n';
  assert.deepEqual(P(m.call('adbParseDevices', out)), { device: 'R58N12345AB', unauthorized: false });
});

test('adbParseDevices: an unauthorized device flags unauthorized, device stays null', () => {
  const out = 'List of devices attached\nR58N12345AB\tunauthorized\n';
  assert.deepEqual(P(m.call('adbParseDevices', out)), { device: null, unauthorized: true });
});

test('adbParseDevices: an offline device is ignored (no device, not unauthorized)', () => {
  // Offline is neither "device" nor "unauthorized" -> both fields stay falsy. adbReadyDevice
  // returns null, so nothing tries to pull from a not-ready device. This is the SAFE outcome.
  const out = 'List of devices attached\nR58N12345AB\toffline\n';
  assert.deepEqual(P(m.call('adbParseDevices', out)), { device: null, unauthorized: false });
});

test('adbParseDevices: "no permissions" is ignored (no device pulled)', () => {
  const out = 'List of devices attached\n????????????\tno permissions; see [http://...]\n';
  assert.deepEqual(P(m.call('adbParseDevices', out)), { device: null, unauthorized: false });
});

test('adbParseDevices: empty device list (header only) -> null device', () => {
  assert.deepEqual(P(m.call('adbParseDevices', 'List of devices attached\n')),
    { device: null, unauthorized: false });
});

test('adbParseDevices: empty / null / undefined input -> null device', () => {
  assert.deepEqual(P(m.call('adbParseDevices', '')), { device: null, unauthorized: false });
  assert.deepEqual(P(m.call('adbParseDevices', null)), { device: null, unauthorized: false });
  assert.deepEqual(P(m.call('adbParseDevices', undefined)), { device: null, unauthorized: false });
});

test('adbParseDevices: a Wi-Fi (ip:port) serial is captured as the device', () => {
  const out = 'List of devices attached\n192.168.1.42:37000\tdevice\n';
  assert.deepEqual(P(m.call('adbParseDevices', out)), { device: '192.168.1.42:37000', unauthorized: false });
});

test('adbParseDevices: last authorized device wins when several are attached', () => {
  const out = 'List of devices attached\nAAA\tdevice\nBBB\tdevice\n';
  assert.equal(m.call('adbParseDevices', out).device, 'BBB');
});

test('adbParseDevices [CHARACTERIZATION]: `adb devices -l` (space-aligned) is NOT parsed', () => {
  // The regex requires a TAB before the state. `adb devices -l` pads with SPACES, so it
  // would match nothing. Harmless because the app never passes -l — pinned here so a future
  // switch to -l can't silently regress device detection.
  const out = 'List of devices attached\nemulator-5554          device product:sdk model:x device:y transport_id:1\n';
  assert.deepEqual(P(m.call('adbParseDevices', out)), { device: null, unauthorized: false });
});

// ---------------------------------------------------------------------------
// adbRemotePath / adbPathToRel / adbAlbumOf — rel<->device-path mapping.
// (05-windows-phone.js:349 / :365 / :372)
// ---------------------------------------------------------------------------
test('adbRemotePath: drops the storage label and rebuilds an /sdcard path', () => {
  assert.equal(m.call('adbRemotePath', 'Internal storage/DCIM/Camera', 'IMG_0001.jpg'),
    '/sdcard/DCIM/Camera/IMG_0001.jpg');
});

test('adbRemotePath: preserves spaces and unicode in folders and filename', () => {
  assert.equal(m.call('adbRemotePath', 'Internal storage/DCIM/My Album', 'foto café.jpg'),
    '/sdcard/DCIM/My Album/foto café.jpg');
});

test('adbRemotePath: a file directly under a storage root maps to /sdcard/<name>', () => {
  assert.equal(m.call('adbRemotePath', 'Internal storage', 'x.mp4'), '/sdcard/x.mp4');
});

test('adbRemotePath: empty/nullish rel -> /sdcard/<name>', () => {
  assert.equal(m.call('adbRemotePath', '', 'x.mp4'), '/sdcard/x.mp4');
  assert.equal(m.call('adbRemotePath', null, 'x.mp4'), '/sdcard/x.mp4');
});

test('adbPathToRel: nested camera path splits into name + Internal-storage rel', () => {
  assert.deepEqual(P(m.call('adbPathToRel', '/sdcard/DCIM/Camera/IMG_0001.jpg')),
    { name: 'IMG_0001.jpg', rel: 'Internal storage/DCIM/Camera' });
});

test('adbPathToRel: handles spaces and unicode in the path', () => {
  assert.deepEqual(P(m.call('adbPathToRel', '/sdcard/DCIM/My Album/foto café.jpg')),
    { name: 'foto café.jpg', rel: 'Internal storage/DCIM/My Album' });
});

test('adbPathToRel [CHARACTERIZATION]: a trailing slash yields an empty name', () => {
  // Callers guard with `if (!name) continue;`, so a directory-looking path is skipped.
  assert.deepEqual(P(m.call('adbPathToRel', '/sdcard/DCIM/Camera/')),
    { name: '', rel: 'Internal storage/DCIM/Camera' });
});

test('adbRemotePath ∘ adbPathToRel round-trips a real device path', () => {
  const p = '/sdcard/DCIM/Camera/My Trip/clip 2.mp4';
  const { name, rel } = m.call('adbPathToRel', p);
  assert.equal(m.call('adbRemotePath', rel, name), p);
});

test('adbAlbumOf: nested file -> first folder under the root', () => {
  assert.equal(m.call('adbAlbumOf', '/sdcard/DCIM/Camera/x.jpg'), 'Camera');
});

test('adbAlbumOf: a file directly in a root -> the root name', () => {
  assert.equal(m.call('adbAlbumOf', '/sdcard/DCIM/x.jpg'), 'DCIM');
});

test('adbAlbumOf: each scan root labels correctly', () => {
  assert.equal(m.call('adbAlbumOf', '/sdcard/Pictures/Screenshots/s.png'), 'Screenshots');
  assert.equal(m.call('adbAlbumOf', '/sdcard/Movies/clip.mp4'), 'Movies');
  assert.equal(m.call('adbAlbumOf', '/sdcard/Download/WhatsApp/w.mp4'), 'WhatsApp');
});

test('adbAlbumOf: a path outside every scan root -> "Phone"', () => {
  assert.equal(m.call('adbAlbumOf', '/data/media/0/foo/x.jpg'), 'Phone');
});

test('adbAlbumOf: a sibling prefix (DCIMbackup) is NOT mistaken for DCIM', () => {
  // startsWith(root + '/') requires the slash, so /sdcard/DCIMbackup/... is not DCIM.
  assert.equal(m.call('adbAlbumOf', '/sdcard/DCIMbackup/x.jpg'), 'Phone');
});

// ---------------------------------------------------------------------------
// Extension regexes + the adb -iname predicate. (main-mod/01-core.js:31-33)
// The 0.4.24 regression: .mts/.m2ts were invisible on MTP because two ext lists drifted.
// Single-sourcing means EVERY listed ext must be matched by MEDIA_EXT_RX_SRC.
// ---------------------------------------------------------------------------
const VIDEO_EXT_LIST = m.get('VIDEO_EXT_LIST');
const IMAGE_EXT_LIST = m.get('IMAGE_EXT_LIST');
const MEDIA_RX = new RegExp(m.get('MEDIA_EXT_RX_SRC'), 'i');
const VIDEO_RX = new RegExp(m.get('VIDEO_EXT_RX_SRC'), 'i');

test('MEDIA_EXT_RX_SRC matches EVERY extension in VIDEO_EXT_LIST', () => {
  for (const e of VIDEO_EXT_LIST) {
    assert.ok(MEDIA_RX.test(`clip.${e}`), `.${e} should match MEDIA_EXT_RX_SRC`);
    assert.ok(MEDIA_RX.test(`CLIP.${e.toUpperCase()}`), `.${e.toUpperCase()} should match (case-insensitive)`);
  }
});

test('MEDIA_EXT_RX_SRC matches EVERY extension in IMAGE_EXT_LIST', () => {
  for (const e of IMAGE_EXT_LIST) {
    assert.ok(MEDIA_RX.test(`photo.${e}`), `.${e} should match MEDIA_EXT_RX_SRC`);
  }
});

test('the 0.4.24 regression stays fixed: .mts and .m2ts match MEDIA and VIDEO regexes', () => {
  assert.ok(MEDIA_RX.test('C0001.mts'), '.mts must be seen as media');
  assert.ok(MEDIA_RX.test('C0001.m2ts'), '.m2ts must be seen as media');
  assert.ok(VIDEO_RX.test('C0001.mts'), '.mts must classify as video');
  assert.ok(VIDEO_RX.test('C0001.m2ts'), '.m2ts must classify as video');
  // .m2ts must not be short-circuited by the .ts / .mts alternatives (end-anchored).
  assert.equal('x.m2ts'.match(MEDIA_RX)[1], 'm2ts');
});

test('VIDEO_EXT_RX_SRC classifies videos as video and photos as NOT video', () => {
  for (const e of VIDEO_EXT_LIST) assert.ok(VIDEO_RX.test(`v.${e}`), `.${e} is video`);
  for (const e of IMAGE_EXT_LIST) assert.ok(!VIDEO_RX.test(`p.${e}`), `.${e} is NOT video`);
});

test('MEDIA_EXT_RX_SRC rejects non-media and extension-as-substring', () => {
  assert.ok(!MEDIA_RX.test('notes.txt'));
  assert.ok(!MEDIA_RX.test('archive.zip'));
  assert.ok(!MEDIA_RX.test('mp4'));            // no dot
  assert.ok(!MEDIA_RX.test('song.mp3'));
  assert.ok(!MEDIA_RX.test('movie.mp4.part')); // end-anchored: .part is not media
});

test('adbInamePredicate emits an -iname clause for EVERY media extension, incl. mts/m2ts', () => {
  const pred = m.call('adbInamePredicate');
  for (const e of [...IMAGE_EXT_LIST, ...VIDEO_EXT_LIST]) {
    assert.ok(pred.includes(`-iname '*.${e}'`), `predicate should test *.${e}`);
  }
  assert.ok(pred.startsWith('\\( ') && pred.endsWith(' \\)'), 'predicate is a grouped find clause');
  assert.ok(pred.includes(' -o '), 'clauses are OR-joined');
});

// ---------------------------------------------------------------------------
// parseMdnsServices — parse `adb mdns services`. (05-windows-phone.js:505)
// ---------------------------------------------------------------------------
test('parseMdnsServices: parses a connect + a pairing service (tab or space columns)', () => {
  const out = [
    'adb-serial-connect\t_adb-tls-connect._tcp.\t192.168.1.5:37000',
    'adb-serial-pair    _adb-tls-pairing._tcp.    192.168.1.5:41000',
  ].join('\n');
  assert.deepEqual(P(m.call('parseMdnsServices', out)), [
    { instance: 'adb-serial-connect', type: 'connect', host: '192.168.1.5', port: '37000' },
    { instance: 'adb-serial-pair', type: 'pairing', host: '192.168.1.5', port: '41000' },
  ]);
});

test('parseMdnsServices: CRLF endings and unrelated lines are handled/ignored', () => {
  const out = 'List of discovered mdns services\r\nfoo\t_adb-tls-connect._tcp.\t10.0.0.9:5555\r\nrandom noise line\r\n';
  assert.deepEqual(P(m.call('parseMdnsServices', out)),
    [{ instance: 'foo', type: 'connect', host: '10.0.0.9', port: '5555' }]);
});

test('parseMdnsServices: empty/nullish -> []', () => {
  assert.deepEqual(P(m.call('parseMdnsServices', '')), []);
  assert.deepEqual(P(m.call('parseMdnsServices', null)), []);
});

// ---------------------------------------------------------------------------
// destNameFor / uniqueDest — dest filename derivation. (05-windows-phone.js:971/:981)
// ---------------------------------------------------------------------------
test('destNameFor: uses the sanitized newName + original extension', () => {
  assert.equal(m.call('destNameFor', { name: 'IMG_0001.mp4', newName: 'Beach Day' }), 'Beach Day.mp4');
});

test('destNameFor: illegal filename characters are replaced with underscore', () => {
  assert.equal(m.call('destNameFor', { name: 'x.jpg', newName: 'a/b:c*d?' }), 'a_b_c_d_.jpg');
});

test('destNameFor: a blank/whitespace newName falls back to the original base', () => {
  assert.equal(m.call('destNameFor', { name: 'clip.mov', newName: '   ' }), 'clip.mov');
  assert.equal(m.call('destNameFor', { name: 'clip.mov', newName: '' }), 'clip.mov');
});

test('destNameFor: no newName keeps the original name', () => {
  assert.equal(m.call('destNameFor', { name: 'clip.mov' }), 'clip.mov');
});

test('destNameFor: an extensionless file keeps working', () => {
  assert.equal(m.call('destNameFor', { name: 'README', newName: 'notes' }), 'notes');
});

test('destNameFor: an explicit ext field overrides extname', () => {
  assert.equal(m.call('destNameFor', { name: 'clip.tar.gz', ext: '.gz', newName: 'out' }), 'out.gz');
});

test('uniqueDest: returns the plain path when nothing collides, then " (n)" on collision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uvd-uniq-'));
  try {
    const first = await m.call('uniqueDest', dir, 'clip.mp4');
    assert.equal(first, join(dir, 'clip.mp4'));
    writeFileSync(first, 'x');
    const second = await m.call('uniqueDest', dir, 'clip.mp4');
    assert.equal(second, join(dir, 'clip (1).mp4'));
    writeFileSync(second, 'x');
    const third = await m.call('uniqueDest', dir, 'clip.mp4');
    assert.equal(third, join(dir, 'clip (2).mp4'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// randToken / simPhoneRoot / simPhoneOn / lanIPv4Interfaces — light coverage.
// ---------------------------------------------------------------------------
test('randToken: returns exactly n chars drawn only from the given alphabet', () => {
  const alpha = '0123456789';
  const t = m.call('randToken', 8, alpha);
  assert.equal(t.length, 8);
  assert.ok([...t].every((c) => alpha.includes(c)));
});

test('simPhoneRoot: points at the fixed sim-phone folder under the home dir', () => {
  const r = m.call('simPhoneRoot');
  assert.ok(r.endsWith('USB-AutoAction-SimPhone'), `got ${r}`);
});

test('simPhoneOn: false by default (config.simulatePhone unset / no sim DCIM present)', () => {
  assert.equal(m.call('simPhoneOn'), false);
});

test('lanIPv4Interfaces: returns an array of non-internal IPv4 address strings', () => {
  const ips = m.call('lanIPv4Interfaces');
  assert.ok(Array.isArray(ips));
  for (const ip of ips) assert.match(ip, /^\d{1,3}(\.\d{1,3}){3}$/);
});
