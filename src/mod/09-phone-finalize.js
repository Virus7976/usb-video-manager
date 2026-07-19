// ---------------------------------------------------------------------------
// Phone backup (MTP) — pull photos + videos off a plugged-in phone.
// ---------------------------------------------------------------------------
const phoneState = { device: null, media: [], filter: 'all', dest: '', copying: false };
// The phone media currently visible under the All/Photos/Videos filter — single source
// (was the same .filter() inline in 3 places).
function phoneVisibleMedia() { return phoneState.media.filter((m) => phoneState.filter === 'all' || m.kind === phoneState.filter); }

async function openPhone(device) {
  closePopover();
  $('flow').classList.add('hidden');
  $('finalize').classList.add('hidden');
  $('actionList').classList.add('hidden'); $('driveList').classList.add('hidden'); hideHomeExtras();
  $('driveBanner').classList.add('hidden');
  $('phone').classList.remove('hidden');
  $('phCopyWrap').classList.add('hidden');
  $('phChooser').classList.add('hidden');
  $('phBar').classList.add('hidden');
  await phoneDetect(device);
}

async function phoneDetect(preferred) {
  $('phDeviceName').textContent = 'Looking for a phone…';
  $('phDeviceSub').textContent = 'Plug your phone in and choose “File transfer / MTP” on it.';
  $('phBar').classList.add('hidden');
  $('phGrid').innerHTML = '';
  $('phCopyBtn').disabled = true;
  let phones = [];
  try { phones = await window.api.listPhones(); } catch { phones = []; }
  if (!phones.length) {
    $('phDeviceName').textContent = 'No phone detected';
    $('phDeviceSub').textContent = 'Plug in via USB, then on the phone pick “File transfer / Android Auto / MTP” (not “Charging only”), then Rescan.';
    $('phGrid').innerHTML = `<div class="ph-empty"><span class="illo">${ILLO_PHONE}</span>
      <p class="ph-empty-tx">Connect your phone to back it up</p>
      <p class="muted small">USB cable in → tap <b>“File transfer / MTP”</b> on your phone → it shows up here. Then press <b>Rescan</b>.</p></div>`;
    return;
  }
  // Honor the device the user actually clicked; fall back to the first phone.
  const sel = (preferred && phones.find((p) => p.name === preferred.name && !!p.sim === !!preferred.sim)) || phones[0];
  phoneState.device = sel.name;
  phoneState.sim = !!sel.sim;
  $('phDeviceName').textContent = sel.name;
  $('phDeviceSub').textContent = 'Choose what to back up';
  await phoneEnterChooser();
}

// --- Smart chooser: pick albums, see what's new, back it up without a full scan ---
async function phoneEnterChooser() {
  phoneState.reviewMode = false;
  $('phChooser').classList.remove('hidden');
  $('phBar').classList.add('hidden');
  $('phGrid').innerHTML = '';
  $('phCopyWrap').classList.add('hidden');
  $('phCopyBtn').classList.remove('hidden');   // restored after a pull was hidden it (see phoneCopy)
  $('phAlbums').innerHTML = '<span class="muted small">Finding albums…</span>';
  $('phNewSummary').textContent = 'Checking what’s new…';
  $('phNewSub').textContent = '';
  $('phBackupNew').disabled = true; $('phReview').disabled = true;
  let ar = { ok: false, albums: [] };
  try { ar = await window.api.phoneAlbums(phoneState.device); } catch (e) { ar = { ok: false, albums: [], reason: (e && e.message) }; }
  if (ar && ar.ok === false) { phoneShowScanError(); $('phAlbums').innerHTML = ''; return; }
  const albums = (ar.albums || []).filter((a) => a && a.album).sort((a, b) => (b.count || 0) - (a.count || 0));
  phoneState.albums = albums;
  // Default scope: Camera if it exists, else the biggest album. (Empty → scan all DCIM.)
  const cam = albums.find((a) => /^camera$/i.test(a.album));
  phoneState.selectedAlbums = cam ? [cam.album] : (albums[0] ? [albums[0].album] : []);
  renderPhoneAlbums();
  renderPhFast();
  await phoneScanScoped();
  // AUTO MODE: no clicks — pull everything new/unfinished now. You still stop to batch
  // photos at the rename step. Pulling only COPIES off the phone; nothing is deleted.
  if (autoMode() && !phoneState.reviewMode && !phoneState.copying && Array.isArray(phoneState.media)) {
    const act = phoneState.media.filter((m) => m._act);
    if (act.length) {
      phoneState.media.forEach((m) => { m.selected = !!m._act; });
      showToast(`⚡ Auto mode — pulling ${act.length} off ${phoneState.device}…`, 3500);
      phoneCopy();
    }
  }
}

// Fast-transfer (ADB) status + one-tap enable, shown under the chooser. ADB is far
// faster than MTP for big Android rolls; enabling downloads ADB once and guides the
// phone's "USB debugging" toggle. Transfers fall back to MTP if it's not ready.
async function renderPhFast() {
  const el = $('phFast'); if (!el) return;
  let st = {}; try { st = await window.api.adbStatus(); } catch { st = {}; }
  // "Pair over Wi-Fi (QR)" button — works whether or not fast transfer is on yet
  // (pairing enables ADB itself), so the whole flow can be done without a cable.
  const wifiBtn = '<button type="button" class="btn ghost" id="phPairWifi">📶 Pair over Wi-Fi (QR)</button>';
  if (st.useAdb) {
    if (st.device) {
      el.innerHTML = st.wireless
        ? '⚡ Fast transfer on — <b>connected wirelessly</b>. You can unplug the cable. ' + wifiBtn
        : '⚡ Fast transfer on (USB). ' + wifiBtn;
    } else if (st.unauthorized) {
      el.innerHTML = '⚡ Fast transfer on — unlock your phone and tap <b>Allow</b> for USB debugging.';
    } else {
      el.innerHTML = '⚡ Fast transfer on — pair over Wi-Fi, or plug in with <b>USB debugging</b> enabled. ' + wifiBtn;
    }
  } else {
    el.innerHTML = 'Transfers use MTP (slow for big camera rolls). '
      + '<button type="button" class="btn ghost" id="phFastOn">⚡ Turn on fast transfer</button> ' + wifiBtn;
  }
  const b = el.querySelector('#phFastOn');
  if (b) b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = 'Setting up…';
    let r = {}; try { r = await window.api.adbEnable(); } catch (e) { r = { ok: false, error: (e && e.message) }; }
    if (!r.ok) { showToast(`Couldn’t set up fast transfer: ${r.error || 'failed'}`, 6000); renderPhFast(); return; }
    if (r.unauthorized) showToast('Almost there — on your phone tap “Allow” for USB debugging, then back up.', 8000);
    else if (!r.device) showToast('Fast transfer ready. Pair over Wi-Fi, or enable USB debugging and reconnect.', 9000);
    else showToast('⚡ Fast transfer on — your phone will back up much faster now.', 5000);
    renderPhFast();
  });
  const w = el.querySelector('#phPairWifi');
  if (w) w.addEventListener('click', () => showWirelessPairModal());
}

// QR wireless-pairing dialog — mirrors Android Studio: show the ADB pairing QR, the
// phone scans it under Wireless debugging → "Pair device with QR code", and the main
// process discovers it over mDNS, pairs, and connects. Manual pairing-code entry is
// offered as a fallback for networks that block mDNS discovery.
async function showWirelessPairModal() {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card wl-pair" style="width:min(460px,94vw);text-align:center">
    <h3>📶 Pair phone over Wi-Fi</h3>
    <div class="wl-body"><p class="muted small">Setting up…</p></div>
    <div class="modal-actions" style="justify-content:center">
      <button type="button" class="btn wl-close">Close</button>
    </div></div>`;
  document.body.appendChild(ov);
  const body = ov.querySelector('.wl-body');
  let unsub = null; let closed = false;
  // ONE place that drops the wireless:status subscription. It used to be open-coded in each
  // exit path, and the success path (finishOk) forgot it — so every successful pairing
  // orphaned a live listener holding a detached statusEl for the life of the app.
  const dropSub = () => { if (unsub) { try { unsub(); } catch { /* */ } unsub = null; } };
  const cleanup = () => { closed = true; dropSub(); try { window.api.wirelessCancel(); } catch { /* */ } ov.remove(); };
  ov.querySelector('.wl-close').addEventListener('click', cleanup);
  ov.addEventListener('click', (e) => { if (e.target === ov) cleanup(); });

  const finishOk = (address) => {
    body.innerHTML = `<p class="wl-ok">✅ Connected wirelessly${address ? ` (${escapeHtml(address)})` : ''}! Your phone now appears under <b>Devices</b> — pick it to back up over Wi-Fi, no cable needed.</p>`;
    showToast('📶 Phone paired over Wi-Fi — it’s now under Devices.', 5000);
    renderPhFast();
    try { refreshDriveList(); } catch { /* not on the home screen */ }
    setTimeout(() => { if (!closed) { closed = true; dropSub(); ov.remove(); } }, 2800);
  };
  const showManual = () => {
    try { window.api.wirelessCancel(); } catch { /* */ }
    dropSub();
    body.innerHTML = `
      <p class="small" style="text-align:left">On the phone open <b>Wireless debugging → Pair device with pairing code</b>. It shows an <b>IP address &amp; port</b> and a <b>6-digit code</b> — type those two here:</p>
      <label class="pref-label">Pairing IP address &amp; port</label>
      <input type="text" class="wl-hostport" placeholder="192.168.1.42:37135" style="width:100%" />
      <label class="pref-label" style="margin-top:8px">Pairing code</label>
      <input type="text" class="wl-code" placeholder="123456" inputmode="numeric" style="width:100%" />
      <details style="margin-top:10px;text-align:left"><summary class="small muted" style="cursor:pointer">Didn’t connect after pairing? Add the connect address</summary>
        <p class="small muted" style="margin-top:6px">On the phone go <b>back one screen</b> to the main <b>Wireless debugging</b> page — it shows an <b>IP address &amp; Port</b> at the top (a different port). Type that here:</p>
        <input type="text" class="wl-connect" placeholder="192.168.1.42:41099" style="width:100%" />
      </details>
      <p class="wl-status muted small"></p>
      <div class="modal-actions" style="justify-content:center;margin-top:10px">
        <button type="button" class="btn primary wl-do">Pair</button>
      </div>`;
    const stEl = body.querySelector('.wl-status');
    body.querySelector('.wl-do').addEventListener('click', async () => {
      const hostport = body.querySelector('.wl-hostport').value.trim();
      const code = body.querySelector('.wl-code').value.trim();
      const connectAddr = body.querySelector('.wl-connect').value.trim();
      if (!hostport || !code) { stEl.textContent = 'Enter both the address and the code.'; return; }
      stEl.textContent = 'Pairing…';
      let r = {}; try { r = await window.api.wirelessManualPair({ hostport, code, connectAddr }); } catch (e) { r = { ok: false, error: (e && e.message) }; }
      if (r.ok) finishOk(r.address);
      else stEl.textContent = r.error || 'Pairing failed — check the address and code.';
    });
  };

  let begin = {};
  try { begin = await window.api.wirelessBegin(); } catch (e) { begin = { ok: false, error: (e && e.message) }; }
  if (closed) return;
  if (!begin.ok) { body.innerHTML = `<p class="wl-err">Couldn’t start pairing: ${escapeHtml(begin.error || 'failed')}</p>`; return; }

  const mdnsWarn = begin.mdnsOk ? '' : '<p class="wl-warn small" style="color:#c77">⚠ Wi-Fi discovery looks blocked on this network — if the phone doesn’t connect, use “Enter code manually”.</p>';
  body.innerHTML = `
    <p class="small">On your phone: <b>Settings → Developer options → Wireless debugging → Pair device with QR code</b>, then point it at this code.</p>
    <img class="wl-qr" src="${begin.qr}" alt="ADB pairing QR" style="width:240px;height:240px;image-rendering:pixelated;margin:10px auto;display:block;border-radius:8px;background:#fff;padding:8px" />
    <p class="wl-status muted small">Waiting for your phone to scan…</p>
    ${mdnsWarn}
    <p style="margin-top:6px"><button type="button" class="btn ghost wl-manual">Enter code manually instead</button></p>`;
  const statusEl = body.querySelector('.wl-status');
  unsub = window.api.onWirelessStatus((p) => {
    if (!statusEl || closed) return;
    if (p.phase === 'waiting') statusEl.textContent = 'Waiting for your phone to scan…';
    else if (p.phase === 'pairing') statusEl.textContent = 'Phone found — pairing…';
    else if (p.phase === 'connecting') statusEl.textContent = 'Paired — connecting…';
  });
  body.querySelector('.wl-manual').addEventListener('click', showManual);

  let res = {};
  try { res = await window.api.wirelessAwait(); } catch (e) { res = { ok: false, error: (e && e.message) }; }
  if (closed || res.cancelled) return;   // user closed, or switched to manual entry
  if (res.ok) finishOk(res.address);
  else {
    body.innerHTML = `<p class="wl-err">${escapeHtml(res.error || 'Pairing failed.')}</p>
      <p style="margin-top:6px"><button type="button" class="btn ghost wl-manual2">Enter code manually</button></p>`;
    body.querySelector('.wl-manual2').addEventListener('click', showManual);
  }
}

function renderPhoneAlbums() {
  const host = $('phAlbums'); if (!host) return;
  const albums = phoneState.albums || [];
  if (!albums.length) { host.innerHTML = '<span class="muted small">No albums found — will scan everything.</span>'; return; }
  const sel = new Set(phoneState.selectedAlbums || []);
  host.innerHTML = albums.map((a) => `<button type="button" class="ph-chip${sel.has(a.album) ? ' on' : ''}" data-album="${escapeAttr(a.album)}">${escapeHtml(a.album)}<span class="ph-chip-n">${a.count}</span></button>`).join('');
  host.querySelectorAll('.ph-chip').forEach((b) => b.addEventListener('click', async () => {
    if (phoneState.copying) return;
    const name = b.dataset.album;
    const s = new Set(phoneState.selectedAlbums || []);
    if (s.has(name)) s.delete(name); else s.add(name);
    if (!s.size) s.add(name);   // keep at least one album selected
    phoneState.selectedAlbums = [...s];
    renderPhoneAlbums();
    await phoneScanScoped();
  }));
}

async function phoneScanScoped() {
  if (!phoneState.device) return;
  const scanEl = $('phScanState');
  const scope = (phoneState.selectedAlbums || []).join(', ') || 'your phone';
  scanEl.classList.remove('hidden');
  let secs = 0;
  scanEl.innerHTML = `<div class="scan-busy"><span class="illo scan-illo">${ILLO_SCAN}</span><p class="scan-busy-tx" id="phScanTxt">Reading ${escapeHtml(scope)}…</p></div>`;
  const txtEl = scanEl.querySelector('#phScanTxt');
  const tick = setInterval(() => { secs += 1; if (txtEl) txtEl.textContent = `Reading ${scope}… (${secs}s)`; }, 1000);
  $('phBackupNew').disabled = true; $('phReview').disabled = true;
  $('phNewSummary').textContent = 'Checking what’s new…'; $('phNewSub').textContent = '';
  let res = { ok: true, media: [] };
  try { res = await window.api.scanPhone(phoneState.device, phoneState.selectedAlbums || []); } catch (e) { res = { ok: false, media: [], reason: (e && e.message) }; }
  clearInterval(tick);
  scanEl.classList.add('hidden');
  if (Array.isArray(res)) res = { ok: true, media: res };
  if (res && res.ok === false) { phoneShowScanError(); return; }
  // "Pick up from anywhere": photos already sitting in Photos Temp from an earlier,
  // unfinished session are recognized so they're not re-offered as new.
  let pulledNames = new Set();
  try { pulledNames = new Set((await window.api.phonePulledNames()) || []); } catch { /* ignore */ }
  // Default-select only what's genuinely NEW: not backed up before (shared import memory)
  // AND not already pulled to Photos Temp.
  const photosTemp = phoneStagingDests().photo.replace(/[\\/]+$/, '');
  phoneState.media = ((res && res.media) || []).map((m, i) => {
    const imported = importedSet.has(importKey({ name: m.name, size: m.size }));
    const pulled = m.kind === 'photo' && pulledNames.has(String(m.name || '').toLowerCase());
    const isNew = !imported && !pulled;
    // A photo only sitting in Photos Temp from an interrupted session isn't finished yet
    // (still needs rename → copy → organize), so it still counts as "to back up". Only
    // items in the import memory are truly done. Both new + unfinished are default-selected.
    const needsFinish = pulled && !imported;
    const act = isNew || needsFinish;
    // Already-pulled photos have a LOCAL copy in Photos Temp → show its real thumbnail
    // (free, no phone access). Not-yet-pulled items keep the placeholder icon.
    const abs = m.abs || (pulled ? `${photosTemp}\\${m.name}` : '');
    return { ...m, _i: i, _new: isNew, _pulled: pulled, _needsFinish: needsFinish, _act: act, abs, selected: act };
  });
  const total = phoneState.media.length;
  const actOnes = phoneState.media.filter((m) => m._act);
  const actN = actOnes.length;
  const newN = phoneState.media.filter((m) => m._new).length;
  const finishN = phoneState.media.filter((m) => m._needsFinish).length;
  const actPh = actOnes.filter((m) => m.kind === 'photo').length;
  const actVid = actN - actPh;
  const doneN = total - actN;
  const finishNote = finishN ? ` · ${finishN} to finish` : '';
  const doneNote = doneN ? ` · ${doneN} backed up` : '';
  if (!total) {
    $('phNewSummary').textContent = 'Nothing here';
    $('phNewSub').textContent = 'No photos or videos in the selected album(s).';
  } else if (!actN) {
    $('phNewSummary').textContent = 'All backed up ✓';
    $('phNewSub').textContent = `${total} item${total !== 1 ? 's' : ''} here — all already backed up. Use Review to back any up again.`;
  } else {
    $('phNewSummary').textContent = (finishN && !newN) ? `${finishN} to finish` : `${actN} to back up`;
    $('phNewSub').textContent = `${actPh} photo${actPh !== 1 ? 's' : ''} · ${actVid} video${actVid !== 1 ? 's' : ''}${finishNote}${doneNote} · ${total} in selection`;
  }
  $('phBackupNew').textContent = actN ? `Back up ${actN}` : 'Nothing new';
  $('phBackupNew').disabled = !actN || phoneState.copying;
  $('phReview').textContent = total ? `Review all ${total}` : 'Review';
  $('phReview').disabled = !total || phoneState.copying;
}

function phoneShowScanError() {
  $('phNewSummary').textContent = 'Couldn’t read your phone';
  $('phNewSub').textContent = 'Unlock it and choose “File transfer / MTP” (not “Charging only”), then press Rescan.';
  $('phBackupNew').disabled = true; $('phReview').disabled = true;
  phoneState.media = [];
}

// Manual-review mode: reveal the full grid for the current (scoped) scan.
function phoneEnterReview() {
  phoneState.reviewMode = true;
  $('phChooser').classList.add('hidden');
  $('phBar').classList.toggle('hidden', !phoneState.media.length);
  phoneRenderGrid();
  phoneUpdateBar();
}

// Most phone cameras name files with the capture date — pull a YYYY-MM-DD out of the
// filename (e.g. 20260604_214438.jpg, IMG_20260604.jpg, PXL_20260604.jpg) for display.
function phoneDateOf(name) {
  // Scan ALL YYYYMMDD-looking runs and take the first that's a VALID calendar date, so a
  // long numeric ID (e.g. lv_7572921339120454965_20260125…) can't yield "2045-49-65".
  const s = String(name || '');
  const rx = /(20\d{2})[-_]?(\d{2})[-_]?(\d{2})/g;
  let m;
  while ((m = rx.exec(s))) {
    const mo = +m[2]; const da = +m[3];
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return '';
}

// The capture date for one pulled item (audit #58).
//
// This used to be `phoneDateOf(name) || toDateStr(mtimeMs)`, and mtime after an MTP/ADB pull is when
// the file LANDED ON DISK — i.e. today. Plenty of phone media carries no date in its name (WhatsApp,
// screenshots, many Android cameras), so a shoot from last month arrived dated today. That is not
// cosmetic: the shoot DATE predicts the subject ~88% of the time (usb-app-shoots-in-batches) and
// drives day-grouping, ledger same-shoot matching, and get_shoot_context — the AI's strongest signal.
//
// Order matters. The FILENAME wins when it has a date: it is authoritative and free, whereas probing
// spawns an ffprobe per file — unaffordable across a card of hundreds when most names already carry
// the date.
//
// VIDEOS ONLY. The container's `creation_time` is what ffprobe can read. Stills need
// EXIF:DateTimeOriginal and ffprobe returns EMPTY tags for a JPEG (verified), so probing a photo
// costs a spawn and yields nothing — the photo half needs the vendored Windows exiftool and is
// deliberately left for a session that can run it, rather than guessed at.
async function captureDateFor(sourcePath, name, mtimeMs, isPhoto) {
  const fromName = phoneDateOf(name);
  if (fromName) return fromName;
  if (!isPhoto && sourcePath) {
    try {
      const meta = await window.api.getMeta(sourcePath);
      const iso = meta && meta.dateISO;
      if (iso) { const d = toDateStr(Date.parse(iso)); if (d) return d; }
    } catch { /* unreadable → fall through to mtime, never fail staging over a date */ }
  }
  return toDateStr(mtimeMs);
}

function phoneRenderGrid() {
  const host = $('phGrid');
  const items = phoneVisibleMedia();
  host.innerHTML = items.map((m) => { const d = phoneDateOf(m.name); return `<label class="ph-tile${m.selected ? ' sel' : ''}${m.kind === 'photo' ? ' is-photo' : ''}" data-i="${m._i}">
      <input type="checkbox" class="ph-cb" ${m.selected ? 'checked' : ''} data-i="${m._i}" />
      ${mediaKindChip(m.kind)}
      <span class="ph-thumb" data-thumb="${m._i}"><span class="ph-tile-ic keep-emoji">${m.kind === 'video' ? '🎬' : '📷'}</span></span>
      <span class="ph-tile-name" title="${escapeAttr(m.name)}">${escapeHtml(m.name)}</span>
      <span class="ph-tile-meta">${fmtBytes(m.size || 0)}${d ? ` · ${d}` : ''}</span>
    </label>`; }).join('') || `<div class="ph-empty"><span class="illo">${ILLO_EMPTY}</span><p class="ph-empty-tx">${phoneState.media.length ? 'No ' + phoneState.filter + 's here' : 'No photos or videos found'}</p><p class="muted small">${phoneState.media.length ? 'Switch the filter above to see your other media.' : 'Nothing in this phone’s camera roll yet.'}</p></div>`;
  host.querySelectorAll('.ph-cb').forEach((cb) => cb.addEventListener('change', () => {
    const m = phoneState.media[+cb.dataset.i]; if (m) m.selected = cb.checked;
    const tile = cb.closest('.ph-tile'); if (tile) tile.classList.toggle('sel', cb.checked);
    phoneUpdateBar();
  }));
  // Real thumbnails for media we can read locally (sim phone / any local path) — the
  // photo IS its own thumb; a video gets one ffmpeg frame. Lazy via an observer so a
  // big roll doesn't extract hundreds of frames up front.
  if (phonePreviewObserver) phonePreviewObserver.disconnect();
  phonePreviewObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const el = e.target; phonePreviewObserver.unobserve(el);
      const m = phoneState.media[+el.dataset.thumb];
      if (!m || !m.abs || m._thumbed) continue;
      m._thumbed = true;
      window.api.getPoster(m.abs).then((url) => { if (url && el.isConnected) el.innerHTML = `<img src="${url}" loading="lazy"/>`; }).catch(() => { /* keep icon */ });
    }
  }, { root: host, rootMargin: '250px' });
  host.querySelectorAll('.ph-thumb').forEach((el) => phonePreviewObserver.observe(el));
}
let phonePreviewObserver = null;

function phoneUpdateBar() {
  const sel = phoneState.media.filter((m) => m.selected);
  const bytes = sel.reduce((s, m) => s + (m.size || 0), 0);
  $('phSummary').textContent = sel.length ? `${sel.length} selected · ${fmtBytes(bytes)}` : 'Nothing selected';
  $('phCopyBtn').disabled = !sel.length || phoneState.copying;
  $('phCopyBtn').textContent = sel.length ? `Pull ${sel.length} off phone & rename` : 'Pull off phone & rename';
  const vis = phoneVisibleMedia();
  const all = $('phSelectAll'); if (all) all.checked = vis.length > 0 && vis.every((m) => m.selected);
}

// Where phone media stages locally before the rename flow. Photos go to "04 - Photos
// Temp" (the user's chosen spot) "before they go anywhere"; videos to a sibling temp,
// to be renamed and then copied to the compression intake like GoPro clips.
function phoneStagingDests() {
  const intake = (cfg && cfg.intakeFolder) || 'L:\\Videos\\02 - Projects\\Compression\\01 - Uncompressed';
  const base = intake.replace(/[\\/]+[^\\/]*$/, '');   // …\Compression
  const photo = (cfg && cfg.photosTempFolder) || `${base}\\04 - Photos Temp`;
  const video = `${base}\\_Phone Video Temp`;
  return { photo, video };
}

async function phoneCopy() {
  const sel = phoneState.media.filter((m) => m.selected);
  if (!sel.length || phoneState.copying) return;
  const dests = phoneStagingDests();
  const nVid = sel.filter((m) => m.kind === 'video').length;
  const nPho = sel.length - nVid;
  phoneState.copying = true; phoneUpdateBar();
  $('phChooser').classList.add('hidden');
  $('phCopyWrap').classList.remove('hidden');
  // Hide the "Pull N off phone & rename" primary button while the pull runs — the progress panel has
  // its own Cancel, and leaving the Pull button sitting under a 62% bar reads as a broken screen.
  // phoneEnterChooser() brings it back when we return to choosing.
  $('phCopyBtn').classList.add('hidden');
  $('phCopyBar').style.width = '0%'; $('phCopyPct').textContent = '0%';
  $('phCopyLabel').textContent = 'Pulling off your phone…';
  $('phCopySub').textContent = `${nPho} photo${nPho !== 1 ? 's' : ''} → Photos Temp · ${nVid} video${nVid !== 1 ? 's' : ''} → Video Temp`;
  // Fill the (otherwise blank) grid area with a live "pulling" state so the step reads as
  // busy-and-fine, not broken.
  $('phGrid').innerHTML = `<div class="ph-pulling">
      <span class="illo scan-illo">${typeof ILLO_SCAN !== 'undefined' ? ILLO_SCAN : ''}</span>
      <p class="ph-pulling-tx" id="phPullTx">Pulling everything off ${escapeHtml(phoneState.device || 'your phone')}…</p>
      <p class="muted small" id="phPullSub">Copying ${nPho} photo${nPho !== 1 ? 's' : ''} + ${nVid} video${nVid !== 1 ? 's' : ''} into your temp folders so you can name and organize them. This is the big copy — you can Cancel any time.</p>
    </div>`;
  const items = sel.map((m) => ({ rel: m.rel, name: m.name, size: m.size, kind: m.kind, abs: m.abs }));
  // Register a persistent task so leaving the window and coming back still shows it (tap to return).
  setTask('phone', 'Backing up phone', 0, sel.length, 'pulling', '');
  clearActivity();
  pushActivity(`Pulling ${sel.length} item${sel.length !== 1 ? 's' : ''} off ${phoneState.device || 'your phone'}…`, 'step');
  const isVid = (n) => VIDEO_RX.test(n || '');
  const off = window.api.onPhoneCopyProgress((p) => {
    const pct = pctOf(p.done, p.total);
    $('phCopyBar').style.width = `${pct}%`; $('phCopyPct').textContent = `${pct}%`;
    $('phCopyLabel').textContent = `Pulling off your phone… ${p.done}/${p.total}`;
    $('phCopySub').textContent = p.name || '';
    const tx = $('phPullTx'); if (tx) tx.textContent = `Pulling off your phone… ${p.done}/${p.total}`;
    setTask('phone', 'Backing up phone', p.done || 0, p.total || sel.length, 'pulling', p.name || '');
    try { window.api.setProgress(p.total ? p.done / p.total : -1); } catch { /* ignore */ }   // native taskbar bar
    if (p.name && (p.done % 6 === 0 || p.done === p.total)) pushActivity(`Pulled ${p.name}`, isVid(p.name) ? 'frame' : 'done');
  });
  let res;
  try { res = await window.api.pullFromPhone({ device: phoneState.device, items, photoDest: dests.photo, videoDest: dests.video, sim: phoneState.sim }); }
  catch (e) { res = { ok: false, error: e.message || String(e) }; }
  off();
  clearTask('phone');
  try { window.api.setProgress(-1); } catch { /* ignore */ }   // clear the taskbar bar
  phoneState.copying = false;
  const cancelBtn = $('phCopyCancel'); if (cancelBtn) { cancelBtn.disabled = false; cancelBtn.textContent = 'Cancel'; }
  if (res && res.cancelled) {
    showToast(`Cancelled — the ${(res.staged || []).length} already pulled are kept (they'll pick up where you left off next time).`, 5500);
    goHome();
    return;
  }
  if (res && res.ok && Array.isArray(res.staged) && res.staged.length) {
    if (typeof pcNotify === 'function') pcNotify('Phone ready', `${nPho} photo${nPho !== 1 ? 's' : ''} in Photos Temp · ${nVid} video${nVid !== 1 ? 's' : ''} ready to name.`);
    // #87: some selected items can fail to transfer (device declined the file, or it staged
    // truncated and was rejected) even on an otherwise-successful pull. The progress bar hitting
    // 100% otherwise implies EVERYTHING came off the phone — call out the ones that didn't, since
    // they're still on the phone and a re-pull will retry them.
    const missed = res.incomplete || 0;
    if (missed > 0) showToast(`Heads up: ${missed} item${missed !== 1 ? 's' : ''} didn’t transfer off the phone and ${missed !== 1 ? 'were' : 'was'} left on it — pull again to retry ${missed !== 1 ? 'them' : 'it'}.`, 6500);
    enterRenameWithPhoneFiles(res.staged);
  } else {
    $('phCopyLabel').textContent = `Couldn’t prepare media${res && res.error ? `: ${res.error}` : ''}`;
    showToast(`Phone pull failed${res && res.error ? `: ${res.error}` : ''}`, 6000);
    phoneUpdateBar();
  }
}

// Load the staged local files into the rename flow as clips — so phone photos AND
// videos get the FULL treatment (AI naming, faces, tags) in the normal rename screen.
async function enterRenameWithPhoneFiles(staged) {
  // scannedDrive below IS the phone marker — isPhoneFlow() derives from it.
  state.scannedDrive = '__phone__';
  resetClipFilter();   // same as the card path — a stale filter must not hide this batch's clips
  // state.copied is "what THIS flow copied, and may therefore offer to delete from its source".
  // It was only ever cleared in startFlow's fresh-scan branch, so entering the phone flow after
  // a card import left the PREVIOUS CARD's clips in it — and the shared "3 Delete" step pill
  // (:520 gates on state.copied.length) would happily list them. You were one pill-click from
  // deleting a card from inside the phone flow. A new flow starts with nothing to delete.
  state.copied = [];
  state.scannedFiles = await Promise.all(staged.map(async (f) => {
    const clip = {
      ...f,
      origBase: f.name.slice(0, f.name.length - (f.ext || '').length),
      date: await captureDateFor(f.sourcePath, f.name, f.mtimeMs, f.kind === 'photo'),
      dateLocked: !!phoneDateOf(f.name),
      subject: '', description: '', version: 1, selected: false,
      isPhoto: f.kind === 'photo'
    };
    for (const fld of organizeFields) clip[fld.id] = '';
    return clip;
  }));
  $('phone').classList.add('hidden');
  $('finalize').classList.add('hidden');
  $('actionList').classList.add('hidden'); $('driveList').classList.add('hidden'); hideHomeExtras();
  $('driveBanner').classList.add('hidden');
  $('flow').classList.remove('hidden');
  setStep(1);
  $('scanState').classList.add('hidden');
  // Restore any naming/tags from a prior session (drafts are keyed by filename+size), so
  // a re-pull or a crash+relaunch doesn't lose your batching work.
  try { const drafts = await window.api.getDrafts(); const restored = applyDraftsToClips(drafts || {}); if (restored) showToast(`Restored your names on ${restored} clip${restored !== 1 ? 's' : ''} ✓`, 4000); } catch { /* ignore */ }
  // Re-bind the AI question queue, exactly as the CARD scan does after it builds scannedFiles.
  // Every pending question carries a clipIndex INTO that array, and we have just replaced it — so
  // without this, questions asked about card clips render (and APPLY) against whichever PHONE clip
  // now sits at that index. Silent misnaming of footage, with no error anywhere.
  // Questions whose clip isn't here are dropped; the queue is cleared even if nothing was saved.
  await restoreAiQuestions();
  buildRenameStep();
  // The staged files live on disk in the temp folders — naming + the final copy both run
  // off those, NOT the phone. Remember this as a resumable session so you can carry on
  // WITHOUT plugging the phone back in (relaunch reopens it; Home shows a "continue" card).
  saveSession({ view: 'phone', step: 1, sourcePath: phoneStagingDests().video, sourceDesc: 'Phone media', sourceKind: 'phone' });
  const nPh = state.scannedFiles.filter((c) => c.isPhoto).length;
  const nVid = state.scannedFiles.length - nPh;
  showToast(nVid
    ? `Photos pulled ✓ — name what you like, then Continue to copy your ${nVid} video${nVid !== 1 ? 's' : ''} off the phone.`
    : `${state.scannedFiles.length} pulled off your phone — name them, then continue ✓`, 6000);
}

// The phone-staged files sit locally in the temp folders after a pull — so naming/organizing
// them needs NO phone. Re-scan those folders to recover unfinished staged media. Videos live
// in "_Phone Video Temp" (session-specific — MOVED out when you send them to Uncompressed, so
// its contents mean "unfinished"); photos in "Photos Temp" are COPIED out and can linger, so
// they only ride along, they don't by themselves signal unfinished work.
async function scanPhoneStagedDir(dir) {
  if (!dir) return [];
  let r; try { r = await window.api.scanVideos(dir); } catch { r = null; }
  return (r && r.ok && Array.isArray(r.files)) ? r.files : [];
}
async function scanPhoneStaged() {
  const { photo, video } = phoneStagingDests();
  const videos = await scanPhoneStagedDir(video);
  const photos = await scanPhoneStagedDir(photo);
  return { videos, photos, unfinished: videos.length };   // `unfinished` drives the Home card
}
// Continue naming/organizing already-pulled phone media WITHOUT the phone connected.
// Returns false when nothing's staged (already finished) so callers fall back to Home.
async function resumePhoneStaged() {
  const { videos, photos } = await scanPhoneStaged();
  const seen = new Set();
  const staged = [...videos, ...photos].filter((f) => { const k = f.sourcePath || `${f.name}|${f.size}`; return seen.has(k) ? false : (seen.add(k), true); });
  if (!staged.length) return false;
  await enterRenameWithPhoneFiles(staged);
  return true;
}

// Jump straight to the Name & copy (rename) flow from any screen.
async function goToRename() {
  closePopover();
  if (!state.scannedFiles || !state.scannedFiles.length) { showToast('Choose a drive first — then you can name & copy its clips'); return; }
  $('finalize').classList.add('hidden');
  $('actionList').classList.add('hidden'); $('driveList').classList.add('hidden'); hideHomeExtras();
  $('flow').classList.remove('hidden');
  buildRenameStep();
}

document.querySelectorAll('.steps .step').forEach((stepEl) => {
  stepEl.addEventListener('click', async () => {
    const n = Number(stepEl.dataset.step);
    if (copyInProgress) {
      if (n === 2) { const cs = await window.api.copyStatus(); if (cs && cs.active) goToCopyProgress(cs); return; }
      if (!(await confirmLeaveTransfer())) return;
    }
    // Say WHY a step won't open. These guards used to fail completely silently: you clicked the
    // pill, nothing happened, nothing was said, and there was no way to tell whether the app was
    // broken or you'd missed a prerequisite.
    if (n === 1 && !state.scannedFiles.length) { showToast('Nothing scanned yet — pick a drive first.'); return; }
    if (n === 2 && !state.scannedFiles.length) { showToast('Nothing scanned yet — pick a drive first.'); return; }
    if (n === 3 && !state.copied.length) { showToast('Nothing has been copied off this card yet — copy first, then you can clear it.', 4000); return; }
    if (n === 1) buildRenameStep();
    else if (n === 2) buildUploadStep();
    else if (n === 3) buildDeleteStep();
  });
});

(async function initSpeed() {
  const info = await window.api.getPlayerInfo();
  const sp = (info && info.defaultSpeed) ? Number(info.defaultSpeed) : 1;
  currentSpeed = sp || 1;
})();

// Step 1 → Step 2: show what will be copied, with final names.
$('renameDoneBtn').addEventListener('click', buildUploadStep);

let copyInProgress = false;
let unsubProgress = null;

// A clip counts as "renamed" once a subject or description has been set.
function isRenamed(clip) { return !!(slug(clip.subject) || slug(clip.description)); }
function filesToCopy() {
  recomputeVersions();
  let list = state.scannedFiles;
  // PHOTOS never go to the video intake — they're backed up to Photos Temp + your
  // chosen destinations separately. Only VIDEOS are copied here.
  if (list.some((c) => c.kind === 'photo')) list = list.filter((c) => c.kind !== 'photo');
  if ($('onlyRenamed') && $('onlyRenamed').checked) list = list.filter(isRenamed);
  if ($('skipImported') && $('skipImported').checked) list = list.filter((c) => !c._imported);
  return list;
}
function clipPhotos() { return state.scannedFiles.filter((c) => c.kind === 'photo'); }

function buildUploadStep() {
  setStep(2);
  $('copyProgressWrap').classList.add('hidden');
  $('copyBar').style.width = '0%';
  $('copyPct').textContent = '0%';
  $('copyStartBtn').classList.remove('hidden');
  $('cancelCopyBtn').classList.add('hidden');
  $('backToRenameBtn').disabled = false;
  // Already-imported clips: show the skip toggle (default on) with a count.
  const dupN = state.scannedFiles.filter((c) => c.kind !== 'photo' && c._imported).length;
  const dupRow = document.getElementById('skipImportedRow');
  if (dupRow) {
    dupRow.style.display = dupN ? '' : 'none';
    const cnt = document.getElementById('skipImportedCount'); if (cnt) cnt.textContent = dupN ? ` — ${dupN} look already imported (same name & size)` : '';
  }
  renderUploadList();
  renderPhoneDest();
  refreshUploadFreeSpace();
  if (isPhoneFlow()) $('copyStartBtn').textContent = 'Copy out';
  // AUTO MODE: once you've named/batched and continued, copy out on its own — no extra click.
  //
  // This was gated on isPhoneFlow(), so on a CARD auto mode did nothing at all — despite the
  // toggle promising "Pick a device — it pulls, copies & analyzes." A GoPro card is a device.
  // Safe by construction: we're on the copy step (so naming is done), runCopy still does its
  // free-space check and still asks before copying into a volume that can't hold it, and copying
  // never deletes — clearing the card remains a deliberate act on the Delete step.
  if (autoMode() && !copyInProgress) {
    showToast(isPhoneFlow() ? '⚡ Auto mode — copying to Uncompressed…' : '⚡ Auto mode — copying to intake…', 3000);
    setTimeout(() => { if (!copyInProgress && !$('step2').classList.contains('hidden')) runCopy(); }, 800);
  }
}
// Show free space on the intake volume vs. the import size, so a shortfall is obvious
// before copying (turns red when there isn't enough room).
async function refreshUploadFreeSpace() {
  const el = $('upDestFree'); if (!el) return;
  el.textContent = ''; el.classList.remove('low');
  try {
    const need = filesToCopy().reduce((s, f) => s + (f.size || 0), 0);
    const fsr = await window.api.freeSpace(state.intakeFolder);
    if (!fsr || !fsr.ok) return;
    const enough = fsr.free >= need + 250 * 1024 * 1024;
    el.textContent = `${fmtBytes(fsr.free)} free · this import is ${fmtBytes(need)}${enough ? '' : ' — not enough room'}`;
    el.classList.toggle('low', !enough);
  } catch { /* ignore */ }
}

// Phone backup destinations — videos go to the Uncompressed intake; the renamed
// photos can ALSO be backed up to this computer and/or the NAS (flat). "Either or."
function renderPhoneDest() {
  let box = document.getElementById('phoneDestBox');
  const photos = clipPhotos().length;
  if (!isPhoneFlow() && !photos) { if (box) box.remove(); return; }
  if (!box) {
    box = document.createElement('div'); box.id = 'phoneDestBox'; box.className = 'phone-dest';
    const slot = document.getElementById('phoneDestSlot');
    if (slot) slot.appendChild(box); else $('intakePathLine').after(box);
  }
  box.innerHTML = `
    <p class="muted small phd-lead">Videos → <b>01 - Uncompressed</b> (compress them next). Back up the ${photos} renamed photo${photos !== 1 ? 's' : ''} to — pick either or both:</p>
    <label class="org-toggle"><input type="checkbox" id="pdComputer" ${cfg.phoneDestComputer ? 'checked' : ''}/> <span>This computer</span></label>
    <div class="pref-row pd-row" data-for="computer"><input type="text" class="pref-path" id="pdComputerPath" readonly value="${escapeAttr(cfg.phoneComputerFolder || '')}" placeholder="Choose a folder on this PC…"/><button type="button" class="btn pd-browse" data-for="computer">Browse…</button></div>
    <label class="org-toggle"><input type="checkbox" id="pdNas" ${cfg.phoneDestNas ? 'checked' : ''}/> <span>NAS — flat (one folder)</span></label>
    <div class="pref-row pd-row" data-for="nas"><input type="text" class="pref-path" id="pdNasPath" readonly value="${escapeAttr(cfg.phoneNasFolder || '')}" placeholder="Choose your NAS folder…"/><button type="button" class="btn pd-browse" data-for="nas">Browse…</button></div>`;
  const sync = () => {
    box.querySelector('.pd-row[data-for="computer"]').style.display = $('pdComputer').checked ? '' : 'none';
    box.querySelector('.pd-row[data-for="nas"]').style.display = $('pdNas').checked ? '' : 'none';
  };
  $('pdComputer').addEventListener('change', (e) => { cfg.phoneDestComputer = e.target.checked; window.api.setPrefs({ phoneDestComputer: e.target.checked }); sync(); });
  $('pdNas').addEventListener('change', (e) => { cfg.phoneDestNas = e.target.checked; window.api.setPrefs({ phoneDestNas: e.target.checked }); sync(); });
  box.querySelectorAll('.pd-browse').forEach((b) => b.addEventListener('click', async () => {
    const which = b.dataset.for;
    const cur = which === 'nas' ? (cfg.phoneNasFolder || '') : (cfg.phoneComputerFolder || '');
    const p = await window.api.pickFolder({ title: which === 'nas' ? 'Choose your NAS backup folder' : 'Choose a folder on this computer', defaultPath: cur });
    if (!p) return;
    if (which === 'nas') { cfg.phoneNasFolder = p; window.api.setPrefs({ phoneNasFolder: p }); $('pdNasPath').value = p; }
    else { cfg.phoneComputerFolder = p; window.api.setPrefs({ phoneComputerFolder: p }); $('pdComputerPath').value = p; }
  }));
  sync();
}

function renderUploadList() {
  recomputeVersions();
  const listEl = $('fileList');
  listEl.innerHTML = '';
  const files = filesToCopy();
  const total = files.reduce((s, f) => s + f.size, 0);
  for (const clip of files) {
    const renamed = finalName(clip) !== clip.name;
    const li = document.createElement('li');
    li.className = 'up-row';
    li.innerHTML = `
      <span class="del-ficon">${DEL_FILE_GLYPH}</span>
      <span class="up-meta">${renamed
        ? `<span class="up-newname">${escapeHtml(finalName(clip))}</span><span class="up-oldname muted small">${escapeHtml(clip.name)}</span>`
        : `<span class="up-newname">${escapeHtml(clip.name)}</span><span class="up-oldname muted small up-unnamed">not renamed yet</span>`}</span>
      <span class="del-size">${fmtBytes(clip.size)}</span>`;
    listEl.appendChild(li);
  }
  const n = files.length;
  const photoN = clipPhotos().length;
  if (n === 0 && photoN > 0) {
    // Photos-only card: no videos to copy, but the stills can still be backed up.
    $('copyStartBtn').textContent = `Back up ${photoN} photo${photoN !== 1 ? 's' : ''}`;
    $('copyStartBtn').disabled = false;
  } else {
    $('copyStartBtn').textContent = `Copy ${n} file${n !== 1 ? 's' : ''} (${fmtBytes(total)}) to intake`;
    $('copyStartBtn').disabled = n === 0;
  }
}

$('onlyRenamed').addEventListener('change', () => { renderUploadList(); refreshUploadFreeSpace(); });
{ const si = document.getElementById('skipImported'); if (si) si.addEventListener('change', () => { renderUploadList(); refreshUploadFreeSpace(); }); }
$('backToRenameBtn').addEventListener('click', () => buildRenameStep());

function subscribeProgress() {
  if (unsubProgress) return;
  unsubProgress = window.api.onCopyProgress((p) => {
    const pct = pctOf(p.copiedBytes, p.totalBytes);
    if (p.phase === 'copying' || p.phase === 'done') {
      $('copyBar').style.width = `${pct}%`;
      $('copyPct').textContent = `${pct.toFixed(0)}%`;
      if (p.phase === 'copying') {
        $('copyLabel').textContent = `Copying ${p.currentIndex + 1}/${p.totalFiles}: ${p.currentName}`;
        $('copySub').textContent = `${fmtBytes(p.copiedBytes)} of ${fmtBytes(p.totalBytes)}`;
      }
    }
    updateCopyChip(p);
  });
}
function unsubscribeProgress() { if (unsubProgress) { unsubProgress(); unsubProgress = null; } }

function showCopyingUI() {
  $('copyProgressWrap').classList.remove('hidden');
  $('copyStartBtn').classList.add('hidden');
  $('cancelCopyBtn').classList.remove('hidden');
  $('cancelCopyBtn').disabled = false;
  $('cancelCopyBtn').textContent = 'Cancel copy';
  $('backToRenameBtn').disabled = true;
}

// Show progress for an already-running copy (resume after reopening / chip click).
function goToCopyProgress(status) {
  $('actionList').classList.add('hidden'); $('driveList').classList.add('hidden'); hideHomeExtras();
  $('driveBanner').classList.add('hidden');
  $('flow').classList.remove('hidden');
  setStep(2);
  $('fileList').innerHTML = '';
  showCopyingUI();
  subscribeProgress();
  updateCopyChip(status);
  if (status && status.totalBytes) {
    const pct = pctOf(status.copiedBytes, status.totalBytes);
    $('copyBar').style.width = `${pct}%`;
    $('copyPct').textContent = `${pct.toFixed(0)}%`;
    $('copyLabel').textContent = `Copying ${(status.currentIndex || 0) + 1}/${status.totalFiles}: ${status.currentName}`;
    $('copySub').textContent = `${fmtBytes(status.copiedBytes)} of ${fmtBytes(status.totalBytes)}`;
  }
}

$('copyStartBtn').addEventListener('click', runCopy);

// Does this clip match a standing filing rule (e.g. lawn-mowing → Acme Co)?
// If so it ALSO files into the Projects tree, not just the flat NAS backup.
function phoneRouteFor(clip) {
  const hay = `${clip.subject || ''} ${clip.description || ''} ${clip.location || ''} ${(clip.tags || []).join(' ')}`.toLowerCase();
  for (const r of routesCache) {
    if (r.kind === 'descriptor' || !r.dest) continue;
    if ((r.match || []).some((k) => k && hay.includes(String(k).toLowerCase()))) return r;
  }
  return null;
}

// Build the copy jobs to back up renamed PHOTOS: optionally into "04 - Photos Temp"
// (GoPro stills that aren't there yet), then the chosen computer/NAS destinations,
// then the Projects tree for any that match a filing rule. Shared by phone + GoPro.
// `includePhotosTemp` is TRUE only for the card/GoPro flow (distributeFlowPhotos) and false for the
// phone flow, so it doubles as "is this a card import?" — which is what decides the NAS below.
function buildPhotoJobs(photos, includePhotosTemp) {
  const jobs = [];
  const photosTemp = phoneStagingDests().photo.replace(/[\\/]+$/, '');
  const dests = [];
  if (cfg.phoneDestComputer && cfg.phoneComputerFolder) dests.push(cfg.phoneComputerFolder.replace(/[\\/]+$/, ''));
  if (cfg.phoneDestNas && cfg.phoneNasFolder) dests.push(cfg.phoneNasFolder.replace(/[\\/]+$/, ''));
  // THE CARD'S NAS BACKUP — the one the setup wizard configures (config.nasBackup), which copy:start
  // uses to mirror every VIDEO off a card. Photos never reach copy:start, so they were excluded from
  // it entirely and their only NAS route was the separate phone-preferences setting above. Enable NAS
  // backup in the wizard, never open phone preferences, insert a card: every clip mirrored off-machine
  // and not one still — while the summary still said "Photos backed up".
  //
  // Card flow only. The phone flow has its own phoneNasFolder, and adding this there would copy every
  // phone photo into two NAS folders. Deduped against `dests` because the two settings can legitimately
  // point at the SAME folder, and a second job for one file collides with the first and versions it
  // into _v2.
  if (includePhotosTemp && cfg.nasBackup && cfg.nasBackup.enabled && cfg.nasBackup.path) {
    const cardNas = cfg.nasBackup.path.replace(/[\\/]+$/, '');
    if (cardNas && !dests.includes(cardNas)) dests.push(cardNas);
  }
  const projRoot = (organizeDest || (cfg && cfg.projectsRoot) || '').replace(/[\\/]+$/, '');
  let routedN = 0;
  for (const p of photos) {
    const fname = finalName(p);
    // The AI's record rides WITH the copy job so phone:distribute can embed it into the photo file —
    // videos get this via finalize:run, photos got nothing but copied bytes. Same shape as finalMeta.
    const meta = flowMetaOf(p);
    if (includePhotosTemp && photosTemp) jobs.push({ src: p.sourcePath, dest: `${photosTemp}\\${fname}`, meta });
    for (const d of dests) jobs.push({ src: p.sourcePath, dest: `${d}\\${fname}`, meta });
    if (projRoot) {
      const route = phoneRouteFor(p);
      if (route) { const sub = `${route.dest.replace(/\//g, '\\')}${route.byDay && p.date ? `\\${p.date}` : ''}`; jobs.push({ src: p.sourcePath, dest: `${projRoot}\\${sub}\\${fname}`, meta }); routedN += 1; }
    }
  }
  return { jobs, dests, routedN };
}

// Back up the flow's photos (GoPro/card stills): copy renamed into Photos Temp + the
// chosen computer/NAS destinations + Projects (for matches). Returns a summary string.
async function distributeFlowPhotos() {
  const photos = clipPhotos();
  if (!photos.length) return '';
  const { jobs, routedN } = buildPhotoJobs(photos, true);
  if (!jobs.length) return '';
  $('copyLabel').textContent = 'Backing up photos…'; $('copySub').textContent = '';
  let copied = 0; let failed = 0; let results = [];
  try { const r = await window.api.distributePhotos({ jobs }); copied = (r && r.copied) || 0; failed = (r && r.failed) || 0; results = (r && r.results) || []; } catch { failed = jobs.length; }

  // Photos are FOOTAGE too, and they were being treated as a side-effect: they never entered
  // state.copied (so they could never be cleared off the card — the delete step simply didn't
  // know they existed) and they never got a finalMeta record (so everything the AI worked out
  // about them was thrown away the moment they left the card). Both are fixed here, off the
  // per-job results, so a photo whose copy FAILED is never offered for deletion.
  const landed = new Map();   // sourcePath -> the first destination that verified
  for (const r of results) { if (r && r.ok && !landed.has(r.src)) landed.set(r.src, r.dest); }
  const safePhotos = photos.filter((p) => landed.has(p.sourcePath));
  if (safePhotos.length) {
    for (const p of safePhotos) {
      state.copied.push({ sourcePath: p.sourcePath, destPath: landed.get(p.sourcePath), name: p.name, ext: p.ext, size: p.size });
    }
    try {
      window.api.recordCopied(safePhotos.map((p) => ({
        key: clipKeyV2(p), source: p.sourcePath, dest: landed.get(p.sourcePath), name: p.name,   // #8
      })));
    } catch { /* non-fatal */ }
    saveFlowFinalMeta(safePhotos);   // carry the AI's work forward to Organize, same as videos
    // …and the LAST two things the video path does after verification, which photos never got:
    // mark them imported and drop their drafts. Without this, re-inserting a card re-offered and
    // re-copied every still (time, not data — the collision guard full-hashes and skips an identical
    // destination) and, worse, their drafts were never cleared, so they counted against DRAFTS_CAP
    // forever and kept re-offering a name the user had already dealt with.
    //
    // Only safePhotos, exactly as the video path uses only verified clips: a photo that failed to
    // copy anywhere must stay un-imported and keep its draft so the card re-offers it. Drafts are
    // cleared under clipKeyV2 — the form buildDraftMap wrote them under (#8).
    try {
      const pkeys = safePhotos.map(importKey);
      if (pkeys.length) { window.api.importsAdd(pkeys); pkeys.forEach((k) => importedSet.add(k)); }
      window.api.clearDrafts(safePhotos.map((p) => clipKeyV2(p)));
    } catch { /* non-fatal */ }
  }
  const names = [cfg.phoneDestComputer && cfg.phoneComputerFolder ? 'computer' : '', cfg.phoneDestNas && cfg.phoneNasFolder ? 'NAS' : ''].filter(Boolean).join(' + ') || 'Photos Temp';
  // Surface partial failures instead of implying every photo copied (the copy is now
  // fingerprint-verified, so "failed" means a real, unverifiable copy — worth showing).
  const warn = failed ? ` — ⚠ ${failed} failed to copy` : '';
  return `${copied}/${photos.length} photo${photos.length !== 1 ? 's' : ''} → ${names}${routedN ? ` (${routedN} into Projects)` : ''}${warn}`;
}

// Phone backup copy step: photos are ALREADY in "04 - Photos Temp"; here we copy the
// VIDEOS off the device into the Uncompressed intake (renamed), GoPro-style. Sim
// videos are a local copy; real-phone videos get pulled off MTP at this moment.
async function runPhoneCopy() {
  maybeFlushEdits(true);
  recomputeVersions();
  const vids = state.scannedFiles.filter((c) => c.kind === 'video');
  const photos = state.scannedFiles.filter((c) => c.kind === 'photo');
  const intake = (state.intakeFolder || '').replace(/[\\/]+$/, '');
  const vtemp = phoneStagingDests().video.replace(/[\\/]+$/, '');
  // Videos were already pulled into _Phone Video Temp and STAY there. Moving them into
  // "01 - Uncompressed" now would make Tdarr start compressing before you're ready (and
  // with the wrong names). So we just RENAME them in the temp folder to their final names,
  // and remember a "send to Uncompressed" job for when YOU choose to compress. Nothing
  // touches Tdarr's watched folder yet.
  const renameJobs = vids.map((v) => ({ src: v.sourcePath || `${vtemp}\\${v.name}`, size: v.size, dest: `${vtemp}\\${finalName(v)}` }));
  phonePendingVideos = vids.map((v) => ({ src: `${vtemp}\\${finalName(v)}`, size: v.size, dest: `${intake}\\${finalName(v)}` }));
  copyInProgress = true; showCopyingUI();
  $('copyBar').style.width = '0%'; $('copyPct').textContent = '0%';
  $('copyLabel').textContent = vids.length ? 'Naming your videos…' : 'Finishing…';
  $('copySub').textContent = '';
  setTask('phone-copy', 'Finishing phone backup', 0, renameJobs.length || 1, 'naming', '');
  const off = window.api.onPhoneCopyProgress((p) => {
    const pct = pctOf(p.done, p.total);
    $('copyBar').style.width = `${pct}%`; $('copyPct').textContent = `${pct}%`;
    $('copyLabel').textContent = `Naming videos… ${p.done}/${p.total}`;
    $('copySub').textContent = p.name || '';
    setTask('phone-copy', 'Finishing phone backup', p.done || 0, p.total || renameJobs.length || 1, 'naming', p.name || '');
    try { window.api.setProgress(p.total ? p.done / p.total : -1); } catch { /* ignore */ }
  });
  let res = { ok: true, copied: 0 };
  let distributed = 0;
  let pjobs = []; let dests = {}; let routedN = 0;
  // The two awaits below are individually try/caught, but buildPhotoJobs() between them is
  // NOT — and a sync throw there would unwind past `copyInProgress = false`, jamming the
  // worst latch in the app (it nags "Leave the transfer view?" on every navigation, hijacks
  // the step pills and blocks auto-mode, permanently). The latch release belongs in a
  // finally so it holds no matter what runs in here.
  try {
    if (renameJobs.length) { try { res = await window.api.copyPhoneVideos({ jobs: renameJobs }); } catch (e) { res = { ok: false, error: e.message }; } }

    // Distribute the renamed PHOTOS (already in Photos Temp) to computer/NAS + Projects.
    ({ jobs: pjobs, dests, routedN } = buildPhotoJobs(photos, false));
    if (pjobs.length) {
      $('copyLabel').textContent = 'Backing up photos…'; $('copySub').textContent = '';
      try { const r2 = await window.api.distributePhotos({ jobs: pjobs }); distributed = (r2 && r2.copied) || 0; } catch { /* non-fatal */ }
    }
  } finally {
    off(); clearTask('phone-copy'); copyInProgress = false; hideCopyChip();
    try { window.api.setProgress(-1); } catch { /* ignore */ }
  }
  // Remember what we just backed up (by original phone name+size) so next time the
  // smart chooser knows it's no longer "new". Photos were already pulled to Photos Temp
  // (failed ones never reach scannedFiles); videos only count if NONE failed to copy —
  // a failed video stays "new" so it's re-offered, never silently marked backed-up.
  try {
    const okVids = (res && res.failed) ? [] : vids;
    const keys = [...photos, ...okVids].map((c) => importKey({ name: c.name, size: c.size }));
    if (keys.length) { window.api.importsAdd(keys); keys.forEach((k) => importedSet.add(k)); }
  } catch { /* non-fatal */ }
  // Remember each clip's batched metadata (keyed by final name) and analyze in the
  // background — like the card flow — so phone footage arrives at Organize already named
  // and analyzed (this feeds the "already analyzed" count on the home banner). Point the
  // video clips at their intake copy so analysis can read them. Never deletes anything.
  try {
    // Videos stay in _Phone Video Temp under their final names — point analysis/preview at
    // the renamed file, but ONLY for ones that actually got renamed (a failed rename left
    // the file at its original name, so keep that sourcePath).
    const okSet = new Set((res && res.okDests) || []);
    vids.forEach((v) => { const dp = `${vtemp}\\${finalName(v)}`; v.destPath = dp; if (!res || !res.okDests || okSet.has(dp)) v.sourcePath = dp; });
    saveFlowFinalMeta(state.scannedFiles);
    autoBackgroundEnrich(state.scannedFiles);   // silent face-tag (auto mode) + vision analysis (from temp)
  } catch { /* non-fatal */ }
  $('copyBar').style.width = '100%'; $('copyPct').textContent = '100%';
  const destNames = [cfg.phoneDestComputer && cfg.phoneComputerFolder ? 'computer' : '', cfg.phoneDestNas && cfg.phoneNasFolder ? 'NAS' : ''].filter(Boolean).join(' + ');
  const routedNote = routedN ? ` (${routedN} also filed into Projects)` : '';
  const photoLine = (dests.length || routedN) ? `${distributed} photo cop${distributed !== 1 ? 'ies' : 'y'} → ${destNames || 'Projects'}${routedNote}` : `${photos.length} photo${photos.length !== 1 ? 's' : ''} in 04 - Photos Temp`;
  const nVid = phonePendingVideos.length;
  const vidLine = nVid ? `${nVid} video${nVid !== 1 ? 's' : ''} named &amp; staged in _Phone Video Temp (Tdarr won't touch them yet)` : '';
  // Reveal a deliberate "Send to Uncompressed" button so YOU decide when Tdarr compresses.
  const sendBtn = document.getElementById('phSendUncompressedBtn');
  if (sendBtn) { sendBtn.classList.toggle('hidden', !nVid); sendBtn.textContent = nVid ? `Send ${nVid} video${nVid !== 1 ? 's' : ''} to Uncompressed` : 'Send to Uncompressed'; sendBtn.disabled = false; }
  showDone(`${[vidLine, photoLine].filter(Boolean).join(' · ')}. When you're ready to compress, hit “Send to Uncompressed”.`);
  if (typeof pcNotify === 'function') pcNotify('Phone backup', `${nVid} video${nVid !== 1 ? 's' : ''} staged in Video Temp · ${photoLine}.`);
}
// Videos wait in _Phone Video Temp (renamed) until the user sends them to Uncompressed —
// so Tdarr never compresses before they're ready. { src: tempPath, dest: intakePath }.
let phonePendingVideos = [];
async function sendPendingVideosToUncompressed() {
  const jobs = (phonePendingVideos || []).slice();
  if (!jobs.length) { showToast('No staged videos to send'); return; }
  const btn = document.getElementById('phSendUncompressedBtn');
  const restoreLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  setTask('phone-send', 'Sending to Uncompressed', 0, jobs.length, 'moving', '');
  const off = window.api.onPhoneCopyProgress((p) => setTask('phone-send', 'Sending to Uncompressed', p.done || 0, p.total || jobs.length, 'moving', p.name || ''));
  let res = { copied: 0 };
  let err = null;
  try { res = await window.api.copyPhoneVideos({ jobs }); } catch (e) { err = (e && e.message) || String(e); }
  finally { off(); clearTask('phone-send'); }
  // This used to `catch { /* ignore */ }` and then claim success with a ✓ regardless — a
  // failed send reported "0 videos → Uncompressed ✓" and cleared the pending list, so the
  // videos were silently never sent and the button vanished. Keep them pending on failure.
  if (err) {
    if (btn) { btn.disabled = false; btn.textContent = restoreLabel; }
    showToast(`Couldn’t send to Uncompressed — ${err}. They’re still pending — try again.`, 6000);
    logIssue('Phone', `Send to Uncompressed failed: ${err}`);
    return;
  }
  phonePendingVideos = [];
  if (btn) { btn.classList.add('hidden'); }
  showToast(`${(res && res.copied) || 0} video${((res && res.copied) !== 1) ? 's' : ''} → 01 - Uncompressed — Tdarr can compress them now ✓`, 5000);
}

async function runCopy() {
  if (isPhoneFlow()) return runPhoneCopy();   // derived from the clips actually loaded — a flag could drift
  maybeFlushEdits(true);   // learn from any AI-name edits before this batch leaves
  const clips = filesToCopy();
  const files = clips.map((f) => ({
    sourcePath: f.sourcePath, name: f.name, ext: f.ext, size: f.size, newName: finalStem(f)
  }));
  if (!files.length) {
    // Photos-only card (no video) → back up the photos, then offer the Delete step exactly as the
    // video path does. Photos used to dead-end here: backed up, but invisible to the delete step,
    // so a photos-only card could never be cleared through the app at all.
    if (clipPhotos().length) {
      const s = await distributeFlowPhotos();
      showDone(s || 'Photos backed up');
      const watching = !$('flow').classList.contains('hidden') && !$('step2').classList.contains('hidden');
      if (state.copied.length && watching) setTimeout(() => buildDeleteStep(), 500);
    }
    return;
  }
  // SPACE CHECK — make sure the intake (and NAS) can actually hold this import before
  // starting, so a 50 GB copy never fails or corrupts halfway from a full disk.
  const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
  const HEADROOM = 250 * 1024 * 1024;   // leave a little breathing room
  const spaceTargets = [{ label: 'your computer', path: state.intakeFolder }];
  if (cfg && cfg.nasBackup && cfg.nasBackup.enabled && cfg.nasBackup.path) spaceTargets.push({ label: 'the NAS', path: cfg.nasBackup.path });
  for (const t of spaceTargets) {
    try {
      const fsr = await window.api.freeSpace(t.path);
      if (fsr && fsr.ok && fsr.free < totalBytes + HEADROOM) {
        const proceed = await confirmDialog(
          `Low space on ${t.label}`,
          `This import is about ${fmtBytes(totalBytes)}, but only ${fmtBytes(fsr.free)} is free on ${t.label} (${fsr.path}). The copy may not finish. Copy anyway?`,
          'Copy anyway', 'Cancel'
        );
        if (!proceed) { buildUploadStep(); return; }
      }
    } catch { /* never block the copy on a failed space probe */ }
  }
  copyInProgress = true;
  showCopyingUI();
  subscribeProgress();
  // startCopy moves multi-GB across removable media — the likeliest call in the app to
  // REJECT (card yanked, disk full, EPERM). The teardown below therefore has to be in a
  // `finally`: a stuck `copyInProgress` doesn't just leak the progress subscription, it
  // nags "Leave the transfer view?" on every navigation (08-people.js:1436), hijacks the
  // step pills into copyStatus() (:514) and blocks auto-mode from ever copying again
  // (:571) — for the rest of the session. Nothing short of a restart cleared it.
  let res = null; let err = null;
  try {
    res = await window.api.startCopy(files, state.intakeFolder);
  } catch (e) {
    err = (e && e.message) || String(e);
  } finally {
    copyInProgress = false;
    unsubscribeProgress();
    hideCopyChip();
  }
  if (err) {
    buildUploadStep();
    $('copyLabel').textContent = `Copy failed: ${err}`;
    showToast(`Copy failed — ${err}`, 6000);
    logIssue('Copy', err);
    return;
  }

  // A cancelled or failed copy STILL copied some files, and those are complete and verified —
  // copy:start only pushes a file into `copied` after it has been fingerprint-checked against the
  // card. Both of these paths used to just `return`, throwing that list away: the clips were on
  // disk, but the app had forgotten them. So they could never be cleared off the card, and the next
  // run copied them AGAIN, landing beside the originals as " (1)" duplicates. Record what landed.
  const keepPartial = (why) => {
    const done = (res && Array.isArray(res.copied)) ? res.copied : [];
    if (!done.length) return;
    state.copied = done;
    try {
      window.api.recordCopied(done.map((c) => ({ key: clipKeyV2(c), source: c.sourcePath, dest: c.destPath, name: c.name })));   // #8
    } catch { /* non-fatal */ }
    showToast(`${done.length} clip${done.length !== 1 ? 's' : ''} copied and verified before the ${why} — they're safe, and you can clear them from the Delete step.`, 7000);
  };

  if (res && res.cancelled) {
    keepPartial('cancel');
    buildUploadStep();
    $('copyLabel').textContent = `Copy cancelled${state.copied.length ? ` — ${state.copied.length} already copied and kept` : ''}`;
    return;
  }
  if (!res || !res.ok) {
    keepPartial('failure');
    logIssue('Copy', (res && res.error) || 'unknown error');
    $('copyLabel').textContent = `Copy failed: ${res ? res.error : 'unknown error'}`;
    $('copyStartBtn').classList.remove('hidden');
    $('copyStartBtn').disabled = false;
    $('cancelCopyBtn').classList.add('hidden');
    $('backToRenameBtn').disabled = false;
    return;
  }
  if (res.nas && res.nas.failed) logIssue('NAS backup', `${res.nas.failed} file(s) failed to back up to NAS`);
  // The NAS never came up at all: nothing was attempted, so `failed` is 0 and the check above cannot
  // see it. This is the one that matters before a card delete — the user asked for a second copy and
  // does not have one.
  if (res.nas && res.nas.setupError) {
    const msg = `NAS backup did not run — ${res.nas.setupError}. These clips have ONE copy, in the intake folder.`;
    showToast(msg, 12000);
    logIssue('NAS backup', msg);
  }
  state.copied = res.copied;
  // Remember what we copied, DURABLY. Clearing the card is deliberately a separate, later act —
  // compress, organize days on, and only then wipe. But this list used to live only in memory, so
  // a restart made the Delete step a silent no-op and the ONLY way to clear a card was to copy the
  // whole thing again. Keyed by the stable name__size fingerprint → survives replug and restart.
  try {
    window.api.recordCopied(state.copied.map((c) => ({
      key: clipKeyV2(c), source: c.sourcePath, dest: c.destPath, name: c.name,   // #8
    })));
  } catch { /* non-fatal — the in-memory list still drives this session */ }
  // Persist a metadata record keyed by the FINAL filename so the Finalize step can
  // match the re-encoded compressed file and write its metadata (incl. observation/
  // people, which is what lets Organize place footage correctly).
  saveFlowFinalMeta(clips);
  // VERIFY every copy against the card now — so integrity is checked even if you keep
  // the originals (the delete step only verified what you were about to delete).
  $('copyLabel').textContent = 'Verifying copies…';
  const vres = await verifyFlowCopies();
  // ONLY AFTER verification: mark the verified copies as imported (name+size) and drop
  // their drafts. A clip that failed verification stays un-imported and keeps its draft,
  // so re-inserting the card re-offers it — never trust (or forget the name of) a bad copy.
  try {
    const okSrc = new Set((state.copied || []).filter((c) => c._verified).map((c) => c.sourcePath));
    const verifiedClips = clips.filter((c) => okSrc.has(c.sourcePath));
    const keys = verifiedClips.map(importKey);
    if (keys.length) { window.api.importsAdd(keys); keys.forEach((k) => importedSet.add(k)); }
    window.api.clearDrafts(verifiedClips.map((f) => clipKeyV2(f)));   // #8: the SAME form buildDraftMap wrote
  } catch { /* non-fatal */ }
  // Back up any photos on the card alongside the videos.
  const photoSummary = await distributeFlowPhotos();
  const vnote = vres.fail ? ` · ⚠ ${vres.fail} failed verification` : ' · all verified ✓';
  $('copyLabel').textContent = (photoSummary ? `Copy complete · ${photoSummary}` : 'Copy complete') + vnote;
  $('copyBar').style.width = '100%';
  $('copyPct').textContent = '100%';
  // Auto-analyze the copied footage in the BACKGROUND (if AI is on) so it's already
  // analyzed by the time you organize — then re-save its metadata. Fire-and-forget.
  // Photos are analysable — getContactSheet feeds the vision model the photo ITSELF rather than an
  // ffmpeg frame grid (main-mod/06-copy-transfer.js:731). But `clips` here is filesToCopy(), which
  // strips photos out, so on a card they were silently never enriched: no observation, no people,
  // no tags, nothing for Organize to place them by. (The phone path already passes everything.)
  autoBackgroundEnrich([...clips, ...clipPhotos()]);   // silent face-tag (auto mode) + vision analysis
  // Only auto-advance to Delete if the user is still watching the copy; if they
  // navigated away, leave them be (they can reach Delete via the step tabs).
  const watching = !$('flow').classList.contains('hidden') && !$('step2').classList.contains('hidden');
  if (watching) setTimeout(() => buildDeleteStep(), 500);
}
// Verify every copied file against its card source (content fingerprint), tag each
// with `_verified`, and warn if any didn't copy correctly — runs after every copy so
// a bad copy is caught even when the user keeps the originals.
async function verifyFlowCopies() {
  if (!state.copied || !state.copied.length) return { ok: 0, fail: 0 };
  let results = [];
  // #86: verification HASHES the whole of every copy, so a big card sat on "Verifying copies…" for
  // minutes looking frozen. Reflect per-clip progress in the label; detach the listener in finally.
  const label = $('copyLabel');
  const off = (window.api.onVerifyProgress && label) ? window.api.onVerifyProgress((p) => {
    if (p && p.total) label.textContent = `Verifying copies… ${Math.min(p.done + 1, p.total)}/${p.total}`;
  }) : null;
  try { results = await window.api.verifyCopies(state.copied.map((c) => ({ source: c.sourcePath, dest: c.destPath }))); }
  catch { results = []; }
  finally { if (off) { try { off(); } catch { /* ignore */ } } }
  const bySrc = {}; results.forEach((r) => { if (r) bySrc[r.source] = r; });
  let ok = 0; let fail = 0;
  for (const c of state.copied) { const v = bySrc[c.sourcePath]; c._verified = !!(v && v.ok); c._verifyReason = (v && v.reason) || ''; if (c._verified) ok += 1; else { fail += 1; logIssue('Copy verify', `${c.name}: ${c._verifyReason || 'mismatch'}`); } }
  state.copyVerify = { ok, fail };
  if (fail) showToast(`⚠ ${fail} file${fail !== 1 ? 's' : ''} didn’t copy correctly — re-copy before clearing the card`, 7000);
  return { ok, fail };
}
// Persist each clip's full metadata keyed by its final filename (carry-forward to
// Organize). Called after copy and again after background analysis enriches it.
// The canonical AI-derived record for a clip/photo — the same shape finalMeta stores and
// buildEmbedTags reads. Shared so the photo copy jobs can carry it into the file (see buildPhotoJobs
// → phone:distribute) instead of it living only in a sidecar the photo never reaches.
function flowMetaOf(clip) {
  const rec = {
    subject: clip.subject || '', description: clip.description || '', date: clip.date || '',
    location: clip.location || '', context: clip.context || '',
    shotType: clip.shotType || '', observation: clip.observation || '',
    people: Array.isArray(clip.people) ? clip.people : [],
    peopleAuto: Array.isArray(clip.peopleAuto) ? clip.peopleAuto : []   // unconfirmed face guesses
  };
  for (const fld of organizeFields) rec[fld.id] = clip[fld.id] || '';
  rec.tags = Array.isArray(clip.tags) ? clip.tags : [];
  rec.ledgerRel = clip._ledgerRel || clip.ledgerRel || '';
  rec.keywords = [clip.subject, clip.location, clip.shotType, ...organizeFields.map((f) => clip[f.id]), ...rec.tags].filter(Boolean);
  return rec;
}
function saveFlowFinalMeta(clips) {
  const map = {};
  for (const clip of clips) {
    const rec = flowMetaOf(clip);
    // The same-shoot decision the user ALREADY confirmed ("Part of an existing project?" →
    // "Will file N clips into 'X' at the organize step"). It was only ever persisted into
    // renameDrafts — and the drafts for copied clips are deleted immediately after the copy —
    // so by the time Organize ran, the answer was gone and the promise was quietly broken. It
    // has to ride in finalMeta, which is what actually survives the trip to the Organize step.
    rec.ledgerRel = clip._ledgerRel || clip.ledgerRel || '';
    rec.keywords = [clip.subject, clip.location, clip.shotType, ...organizeFields.map((f) => clip[f.id]), ...rec.tags].filter(Boolean);
    map[finalName(clip)] = rec;
  }
  window.api.saveFinalMeta(map);
}
// Background AI analysis of the just-copied footage — vision only (no face-review
// popups), conveyor-visible, cancellable via the footer task. Re-saves finalMeta so
// Organize gets the observations. Uses sample-per-subject on big batches.
let autoAnalyzeRunning = false;
async function autoAnalyzeAfterCopyRun(clips) {
  if (autoAnalyzeRunning || !aiReady()) return;
  const obsOf = (c) => (c.observation && c.observation.trim()) || (clipObsFor(c) && clipObsFor(c).obs) || '';
  const need = clips.filter((c) => c && c.sourcePath && !obsOf(c));
  if (!need.length) return;
  autoAnalyzeRunning = true; aiAborted = false;
  const key = (c) => slug(c.subject || c.location || '') || 'x';
  const groups = {}; for (const c of need) (groups[key(c)] = groups[key(c)] || []).push(c);
  const sample = need.length > 24 && Object.keys(groups).length < need.length;
  const reps = sample ? Object.values(groups).map((g) => g[0]) : need;
  showToast(`Analyzing ${sample ? `${reps.length} subject${reps.length !== 1 ? 's' : ''}` : `${reps.length} clip${reps.length !== 1 ? 's' : ''}`} in the background for organizing…`, 4500);
  setAiRunClips(reps);
  let done = 0;
  // The per-clip suggest is already guarded, but setTask/aiStageAdvance/saveFlowFinalMeta
  // are not — and our ONLY caller (08-people.js:214) wraps this whole call in a
  // `catch { /* non-fatal */ }`. So a throw in here used to leave autoAnalyzeRunning stuck
  // true with NO error surfaced anywhere, and the guard at the top of this function then
  // silently refused every later auto-analyze for the rest of the session.
  try {
    for (const c of reps) {
      if (aiAborted) break;
      const i = state.scannedFiles.indexOf(c);
      setTask('ai', aiModelLabel(), done + 1, reps.length, 'analyzing', c.name);
      aiStageAdvance(c, 'analyzing');
      try { if (i >= 0) await aiSuggestClip(i, 'empty', { quiet: true }); } catch { /* keep going */ }
      if (sample) {
        const obs = obsOf(c);
        for (const sib of (groups[key(c)] || [])) { if (sib !== c && obs && !obsOf(sib)) { sib.observation = obs; noteClipObs(sib, obs); } }
      }
      done += 1;
    }
    saveFlowFinalMeta(clips);   // re-save so Organize gets the new observations/people
    if (!aiAborted) showToast('Footage analyzed — it’ll place itself correctly when you organize ✓', 4000);
  } catch (e) {
    logIssue('AI', `Background analysis stopped: ${(e && e.message) || e}`);
  } finally {
    clearTask('ai'); aiStageClose();
    autoAnalyzeRunning = false;
  }
}

$('cancelCopyBtn').addEventListener('click', async () => {
  const ok = await confirmDialog('Cancel the copy?', 'Files already copied stay in the intake folder.', 'Cancel copy', 'Keep copying');
  if (!ok) return;
  // If cancelCopy REJECTED, the button stayed disabled on "Cancelling…" forever — meaning a
  // runaway copy had no working stop button at all. Restore it so the cancel can be retried.
  await withBusyBtn($('cancelCopyBtn'), 'Cancelling…', () => window.api.cancelCopy(),
    (msg) => showToast(`Couldn’t cancel — ${msg}. Try again.`, 6000));
});

// ---------------------------------------------------------------------------
// Copy status chip (header) + generic confirm dialog
// ---------------------------------------------------------------------------
function updateCopyChip(p) {
  if (!p) { hideCopyChip(); return; }
  if (p.phase === 'done' || p.phase === 'cancelled' || p.active === false) { hideCopyChip(); return; }
  const pct = pctOf(p.copiedBytes, p.totalBytes);
  $('copyChipText').textContent = `Copying ${(p.currentIndex || 0) + 1}/${p.totalFiles} · ${pct.toFixed(0)}%`;
  $('copyChip').classList.remove('hidden');
}
function hideCopyChip() { $('copyChip').classList.add('hidden'); }
$('copyChip').addEventListener('click', async () => {
  const cs = await window.api.copyStatus();
  if (cs && cs.active) goToCopyProgress(cs);
});

// Keyboard-navigable choice dialog: ↑/↓ to move, Enter to pick, Esc cancels.
// options: [{ label, value }]. Resolves the chosen value, or null if cancelled.
function keyChoiceDialog(message, detail, options) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal-card modal-form">
      <h3>${escapeHtml(message)}</h3>
      ${detail ? `<p class="muted small">${escapeHtml(detail)}</p>` : ''}
      <div class="kc-choices">${options.map((o, i) =>
        `<button type="button" class="btn kc-choice${i === 0 ? ' kc-sel' : ''}" data-i="${i}">${escapeHtml(o.label)}</button>`
      ).join('')}</div></div>`;
    document.body.appendChild(ov);
    const btns = [...ov.querySelectorAll('.kc-choice')];
    let idx = 0;
    const setSel = (n) => { idx = (n + btns.length) % btns.length; btns.forEach((b, i) => b.classList.toggle('kc-sel', i === idx)); btns[idx].focus(); };
    const done = (v) => { document.removeEventListener('keydown', onKey, true); ov.remove(); resolve(v); };
    function onKey(e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); setSel(idx + 1); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); setSel(idx - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); done(options[idx].value); }
      else if (e.key === 'Escape') { e.preventDefault(); done(null); }
    }
    document.addEventListener('keydown', onKey, true);
    btns.forEach((b, i) => {
      b.addEventListener('click', () => done(options[i].value));
      b.addEventListener('mouseenter', () => setSel(i));
    });
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(null); });
    setSel(0);
  });
}

// Decide whether the date should be copied when applying to selected clips.
// Returns true / false, or null if the user cancels the ask-popup.
async function decideCopyDate() {
  if (copyDateMode === 'always') return true;
  if (copyDateMode === 'never') return false;
  return keyChoiceDialog('Apply to selected clips', 'Copy the date to the other clips too?', [
    { label: 'Copy date too', value: true },
    { label: 'Keep each clip’s own date', value: false }
  ]);
}

function confirmDialog(message, detail, okLabel, cancelLabel) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal-card modal-form">
      <h3>${escapeHtml(message)}</h3>
      ${detail ? `<p class="muted small">${escapeHtml(detail)}</p>` : ''}
      <div class="modal-actions">
        <button type="button" class="btn primary cd-ok">${escapeHtml(okLabel || 'OK')}</button>
        <button type="button" class="btn cd-cancel">${escapeHtml(cancelLabel || 'Cancel')}</button>
      </div></div>`;
    document.body.appendChild(ov);
    const done = (v) => { ov.remove(); resolve(v); };
    ov.querySelector('.cd-ok').addEventListener('click', () => done(true));
    ov.querySelector('.cd-cancel').addEventListener('click', () => done(false));
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(false); });
  });
}

// (The quit-time "save your progress?" popup was removed — rename work now
// auto-saves continuously and atomically, so quitting needs no confirmation.)

// ---------------------------------------------------------------------------
// Step 3 — delete from source
// ---------------------------------------------------------------------------
// A small video-file glyph for the delete rows (theme-aware).
const DEL_FILE_GLYPH = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="6" width="14" height="12" rx="2" class="del-g-st"/><path d="M17 10l4-2v8l-4-2z" class="del-g-ac"/></svg>`;
function buildDeleteStep() {
  setStep(3);
  const listEl = $('deleteList');
  listEl.innerHTML = '';

  state.copied.forEach((clip, i) => {
    const full = clip.sourcePath || '';
    const base = full.split(/[\\/]/).pop() || full;
    const folder = full.slice(0, Math.max(0, full.length - base.length)).replace(/[\\/]+$/, '');
    const li = document.createElement('li');
    li.className = 'del-row sel';
    li.innerHTML = `
      <label class="del-check"><input type="checkbox" data-del="${i}" checked /><span class="del-box"></span></label>
      <span class="del-ficon">${DEL_FILE_GLYPH}</span>
      <span class="del-meta"><span class="del-name">${escapeHtml(base)}</span>${folder ? `<span class="del-path muted small">${escapeHtml(folder)}</span>` : ''}</span>
      <span class="del-size">${fmtBytes(clip.size)}</span>`;
    listEl.appendChild(li);
  });

  updateDeleteSummary();
  listEl.querySelectorAll('[data-del]').forEach((cb) => {
    cb.addEventListener('change', updateDeleteSummary);
  });
}

function selectedDeleteIndices() {
  return [...document.querySelectorAll('[data-del]')]
    .filter((cb) => cb.checked)
    .map((cb) => Number(cb.dataset.del));
}

function updateDeleteSummary() {
  const idx = selectedDeleteIndices();
  const bytes = idx.reduce((s, i) => s + (state.copied[i].size || 0), 0);
  const total = state.copied.reduce((s, c) => s + (c.size || 0), 0);
  $('deleteSummary').textContent = `${idx.length} selected · ${fmtBytes(bytes)}`;
  const all = document.querySelectorAll('[data-del]').length;
  $('selectAll').checked = idx.length === all && all > 0;
  // Reclaim panel — the headline "free up" figure + animated fill of the copied total.
  const big = $('reclaimBig'); if (big) big.innerHTML = fmtBytes(bytes).replace(' ', '&nbsp;');
  const cnt = $('reclaimCount'); if (cnt) cnt.textContent = `${idx.length} file${idx.length !== 1 ? 's' : ''}`;
  const fill = $('reclaimFill'); if (fill) fill.style.width = `${pctOf(bytes, total)}%`;
  const oft = $('reclaimOfTotal'); if (oft) oft.textContent = total ? `of ${fmtBytes(total)} copied` : '';
  // Keep each row's selected styling in sync (covers Select-all too).
  document.querySelectorAll('#deleteList [data-del]').forEach((cb) => {
    const row = cb.closest('.del-row'); if (row) row.classList.toggle('sel', cb.checked);
  });
  // Make the danger button concrete: count + size, and disable when nothing's ticked.
  const btn = $('deleteConfirmBtn');
  if (btn) {
    btn.disabled = idx.length === 0;
    btn.textContent = idx.length ? `Delete ${idx.length} from card · ${fmtBytes(bytes)}` : 'Select files to delete';
  }
}

$('selectAll').addEventListener('change', (e) => {
  document.querySelectorAll('[data-del]').forEach((cb) => { cb.checked = e.target.checked; });
  updateDeleteSummary();
});

$('deleteConfirmBtn').addEventListener('click', async () => {
  const idx = selectedDeleteIndices();
  if (idx.length === 0) { finishFlow('No files deleted from the card.'); return; }
  const btn = $('deleteConfirmBtn');
  const restore = btn.textContent;
  // SAFETY: verify each copy still matches the card before any permanent delete.
  // Reuse the post-copy verification; only re-check files not already verified.
  const toCheck = idx.filter((i) => !state.copied[i]._verified);
  let verify = [];
  if (toCheck.length) {
    btn.disabled = true; btn.textContent = 'Verifying copies…';
    // #86: full-hash verify before the irreversible delete — show progress so this critical wait
    // never looks hung. Listener detached in finally regardless of outcome.
    const off = window.api.onVerifyProgress ? window.api.onVerifyProgress((p) => {
      if (p && p.total) btn.textContent = `Verifying copies… ${Math.min(p.done + 1, p.total)}/${p.total}`;
    }) : null;
    try { verify = await window.api.verifyCopies(toCheck.map((i) => ({ source: state.copied[i].sourcePath, dest: state.copied[i].destPath }))); }
    catch { verify = []; }
    finally { if (off) { try { off(); } catch { /* ignore */ } } }
    btn.disabled = false; btn.textContent = restore;
  }
  const bySource = {}; verify.forEach((v) => { if (v) bySource[v.source] = v; });
  const isVerified = (i) => state.copied[i]._verified || (bySource[state.copied[i].sourcePath] && bySource[state.copied[i].sourcePath].ok);
  const verifiedIdx = idx.filter(isVerified);
  const failedIdx = idx.filter((i) => !verifiedIdx.includes(i));
  if (!verifiedIdx.length) {
    const why = (bySource[state.copied[failedIdx[0]].sourcePath] || {}).reason || state.copied[failedIdx[0]]._verifyReason || 'the copy could not be checked';
    await confirmDialog('Can’t safely delete', `None of the ${idx.length} copies matched what's on the card (${why}). Nothing was deleted — re-copy first.`, 'OK', 'Close');
    return;
  }
  let body = 'Each copy was checked against the card and matches. On most cards this is permanent (no Recycle Bin).';
  if (failedIdx.length) body += ` ⚠ ${failedIdx.length} file${failedIdx.length > 1 ? 's' : ''} could NOT be verified and will be KEPT on the card.`;
  const ok = await confirmDialog(`Delete ${verifiedIdx.length} verified file${verifiedIdx.length > 1 ? 's' : ''} from the card?`, body, 'Delete verified', 'Cancel');
  if (!ok) return;
  // Send {source, dest} pairs, not bare paths: delete:source re-verifies every file against
  // its copy in the main process and REFUSES anything it can't prove was copied. This gate is
  // deliberately duplicated there — it must not depend on this renderer being correct.
  const items = verifiedIdx.map((i) => ({ source: state.copied[i].sourcePath, dest: state.copied[i].destPath }));
  btn.disabled = true; btn.textContent = 'Deleting…';
  // Card yanked / permission denied is precisely when a delete rejects — and that used to
  // strand the button disabled at "Deleting…" with step 3 never completing.
  let results = null;
  try {
    results = await window.api.deleteSource(items);
  } catch (e) {
    const msg = (e && e.message) || String(e);
    showToast(`Couldn’t delete from the card — ${msg}`, 6000);
    logIssue('Delete', msg);
    return;
  } finally {
    btn.disabled = false; btn.textContent = restore;
  }
  results = Array.isArray(results) ? results : [];
  // The card no longer holds these — drop them from the durable copied log so a later scan of this
  // card doesn't keep offering to delete files that are already gone. (A REFUSED file was NOT
  // deleted and must stay in the log, so it can still be dealt with.)
  try {
    const deleted = new Set(results.filter((r) => r.ok).map((r) => r.path));
    const gone = state.copied.filter((c) => deleted.has(c.sourcePath)).map((c) => clipKey(c));
    if (gone.length) window.api.forgetCopied(gone);
  } catch { /* non-fatal */ }
  const okCount = results.filter((r) => r.ok).length;
  // A REFUSED file is not a failed delete — it means the main-process gate caught a file this
  // screen believed was verified when it wasn't. That's the safety net firing, and it points at
  // a real bug, so say so plainly instead of burying it in "couldn't be deleted".
  const refused = results.filter((r) => r.refused);
  const delFail = results.filter((r) => !r.ok && !r.refused).length;
  if (refused.length) {
    refused.forEach((r) => logIssue('Delete', `REFUSED (kept on card): ${r.path} — ${r.error}`));
    showToast(`⚠ ${refused.length} file${refused.length > 1 ? 's were' : ' was'} NOT deleted — the safety check couldn’t confirm the copy. They’re still on the card.`, 8000);
  }
  let msg = `Copied ${state.copied.length} clip${state.copied.length > 1 ? 's' : ''} to intake · ${okCount} verified & removed from card`;
  if (delFail) msg += ` · ${delFail} couldn’t be deleted`;
  if (refused.length) msg += ` · ${refused.length} kept (safety check)`;
  if (failedIdx.length) msg += ` · ${failedIdx.length} kept (couldn’t verify)`;
  finishFlow(msg);
});

$('skipDeleteBtn').addEventListener('click', () => {
  finishFlow(`Copied ${state.copied.length} clip${state.copied.length > 1 ? 's' : ''} to intake · originals kept on card.`);
});

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------
function finishFlow(summary) {
  showDone(summary);
}

$('openIntakeBtn').addEventListener('click', () => window.api.openFolder(state.intakeFolder));
$('finishBtn').addEventListener('click', () => window.api.hideWindow());
{ const b = document.getElementById('doneOrganizeBtn'); if (b) b.addEventListener('click', () => openFinalize()); }
{ const b = document.getElementById('phSendUncompressedBtn'); if (b) b.addEventListener('click', sendPendingVideosToUncompressed); }

// ---------------------------------------------------------------------------
// Organize & back up (Finalize) — a self-contained, stepped flow (Match →
// Organize → Run), mirroring the Compress & Rename flow. All of its settings
// (destination, folder structure, NAS) live on this screen — there's no
// separate settings dialog.
// ---------------------------------------------------------------------------
// Folder levels you can pick from: the custom organizing fields, plus the two
// naming fields that make sense as folders (Subject, Date).
function finAllLevels() {
  return [...organizeFields, { id: 'subject', label: 'Subject' }, { id: 'date', label: 'Date' }];
}
const finLevelLabel = (id) => (finAllLevels().find((a) => a.id === id) || {}).label || id;

let finScan = { dir: '', files: [] };
let finUnsub = null;
let finDestMode = 'inplace';            // 'inplace' | 'custom'
let finCustomDest = '';                 // remembered custom destination
let finLevels = ['category', 'project']; // per-run editable copy of the schema
let finNasPathVal = '';                 // per-run NAS path
let finRan = false;                     // a run completed in this session

// Slug a value into a folder name (mirrors the main process's slugFolder).
function finSlugFolder(v) { return slug(v) || 'unsorted'; }

// The effective destination root for this run: the Compressed folder itself
// (in-place) or the separate folder the user picked.
function finEffectiveDest() { return finDestMode === 'custom' ? finCustomDest : finScan.dir; }

// Reset step 3 to its pre-run state (so navigating back into it offers Run again).
function finResetRunUI() {
  $('finRunBtn').classList.remove('hidden');
  $('finRunBtn').disabled = false;
  $('finProgressWrap').classList.add('hidden');
  $('finStats').classList.add('hidden');
  $('finResultList').classList.add('hidden');
  $('finOpenDestBtn').classList.add('hidden');
  $('finDoneHome').classList.add('hidden');
  $('finLabel').classList.remove('done');
}

function setFinStep(n) {
  ['1', '2', '3'].forEach((s) => {
    const pill = document.querySelector(`.fin-step[data-finstep="${s}"]`);
    if (pill) { pill.classList.toggle('active', s === String(n)); pill.classList.toggle('complete', Number(s) < n); }
    $(`finStep${s}`).classList.toggle('hidden', s !== String(n));
  });
  if (n === 2) { finRenderLevels(); renderFinMap(); }
  if (n === 3) { finResetRunUI(); finRenderRunSummary(); }
}

// The Organize step IS the destination map now — render it inline into Step 2.
// Apply embeds metadata (when ticked) and files clips into the real Projects tree.
// "I would like to be able to select what footage goes back here onto my computer."
//
// He is filing from a 73 GB archive on L: (2.3 TB free) into projects on C: (31 GB free). It does not
// all fit, and that is not a bug — it is why he wants to choose. So show him the two numbers that
// decide it, BEFORE he presses Run: how much he has selected, and how much room is left. finalize:run
// refuses a run that will not fit, but a refusal at the end of a long think is a worse answer than a
// number he could see all along.
async function renderFinSpace(sel) {
  const el = $('finSpaceLine'); if (!el) return;
  if (!$('finOrganize').checked || !sel.length) { el.classList.add('hidden'); return; }

  const need = sel.reduce((n, f) => n + (f.size || 0), 0);
  let dest = '';
  try { dest = await window.api.getProjectsRoot(); } catch { dest = ''; }
  if (!dest) { el.classList.add('hidden'); return; }

  let free = null;
  try { const r = await window.api.freeSpace(dest); if (r && r.ok) free = r.free; } catch { free = null; }

  const GB = (n) => `${(n / 1e9).toFixed(1)} GB`;
  const n = sel.length;
  // A copy adds bytes to the destination; a move does not. Only warn about the thing that can happen.
  const copying = $('finKeepSource') ? $('finKeepSource').checked : true;
  const tight = copying && free !== null && need + 2e9 > free;

  el.classList.remove('hidden');
  el.classList.toggle('tight', !!tight);
  el.innerHTML = `<span class="fsl-what"><b>${n} clip${n !== 1 ? 's' : ''}</b> · ${escapeHtml(GB(need))}</span>`
    + `<span class="fsl-arrow">→</span>`
    + `<span class="fsl-where">${escapeHtml(dest)}</span>`
    + (free === null ? '' : `<span class="fsl-free">${escapeHtml(GB(free))} free</span>`)
    + (tight ? `<span class="fsl-warn">Won't fit — untick some clips, or file fewer shoots</span>` : '');
}

function renderFinMap() {
  const host = $('finMapHost'); if (!host) return;
  const sel = (finSelected().length ? finSelected() : finMatched());
  renderFinSpace(sel);
  if (!sel.length) { host.innerHTML = '<p class="muted small">No matched clips — go back to the Match step and tick some.</p>'; return; }
  // _ledgerRel closes the loop on the same-shoot offer: the destination map reads it (07-organize-
  // map.js:86,166,277) to file these clips straight into the project the user already confirmed.
  // It was never carried out of finalMeta into here, so the map always saw '' and the clips fell
  // through to _Unsorted — the app asked, the user answered, and then it ignored the answer.
  showDestinationMap(sel.map((f) => ({ name: f.name, sourcePath: f.sourcePath, subject: f.meta && f.meta.subject, description: f.meta && f.meta.description, location: f.meta && f.meta.location, date: f.meta && f.meta.date, people: (f.meta && f.meta.people) || [], shotType: f.meta && f.meta.shotType, tags: (f.meta && f.meta.tags) || [], _ledgerRel: (f.meta && f.meta.ledgerRel) || '', _ref: f })), {
    editable: true,
    host,
    embedMeta: () => $('finEmbed').checked,
    onEditMeta: (f, patch) => {
      f.meta = f.meta || {};
      if (patch.subject != null) f.meta.subject = patch.subject;
      if (patch.location != null) f.meta.location = patch.location;
      try { window.api.saveFinalMeta({ [f.name]: { ...f.meta } }); } catch { /* non-fatal */ }
    },
    onApplied: (r) => {
      const okN = (r.results || []).filter((x) => x.ok).length;
      const failN = (r.results || []).length - okN;
      showToast(`Filed ${okN}${failN ? `, ${failN} failed` : ''} into your Projects tree ✓`, failN ? 6000 : 4000);
      // Files have moved out of the source — drop them from the scan so re-render is honest.
      if (finScan && Array.isArray(finScan.files)) {
        const moved = new Set((r.results || []).filter((x) => x.ok).map((x) => x.from));
        finScan.files = finScan.files.filter((f) => !moved.has(f.sourcePath));
      }
      renderFinMap();
    }
  });
}

async function openFinalize() {
  closePopover();
  $('flow').classList.add('hidden');
  $('actionList').classList.add('hidden'); $('driveList').classList.add('hidden'); hideHomeExtras();
  $('driveBanner').classList.add('hidden');
  $('finalize').classList.remove('hidden');

  // Seed the per-run controls from saved defaults (still editable on screen).
  finDestMode = 'inplace';
  finCustomDest = organizeDest || '';
  // Keep only levels that still exist as fields/naming columns.
  const validIds = new Set(finAllLevels().map((a) => a.id));
  finLevels = (Array.isArray(folderLevels) && folderLevels.length ? folderLevels : ['category', 'project'])
    .filter((id) => validIds.has(id));
  if (!finLevels.length) finLevels = organizeFields.map((f) => f.id);
  finRan = false;
  $('finEmbed').checked = true;
  $('finCsv').checked = false;
  $('finOrganize').checked = true;
  $('finNas').checked = !!nasBackup.enabled;
  finNasPathVal = nasBackup.path || '';
  const inplaceRadio = document.querySelector('input[name="finDestMode"][value="inplace"]');
  if (inplaceRadio) inplaceRadio.checked = true;
  $('finMatchedOnly').checked = !!uiPrefs.finMatchedOnly;
  if ($('finPhotos')) $('finPhotos').checked = !!uiPrefs.finalizePhotos;
  if ($('finQuick')) $('finQuick').checked = uiPrefs.quickAnalyze !== false;
  if ($('finAuto')) $('finAuto').checked = !!uiPrefs.autoTagFaces;
  finQuery = '';
  $('finSearch').value = '';
  $('finSearchClear').classList.add('hidden');
  syncFinOptionRows();

  $('finProgressWrap').classList.add('hidden');
  $('finResultList').classList.add('hidden');
  $('finOpenDestBtn').classList.add('hidden');
  $('finDoneHome').classList.add('hidden');
  $('finRunBtn').classList.remove('hidden');
  setFinStep(1);

  const src = await window.api.getFinalizeSource();
  finScan.dir = src || '';
  // Remember we're organizing → next launch reopens Organize straight away.
  saveSession({ view: 'finalize', step: null, sourcePath: src || '', sourceDesc: 'Organize', sourceKind: 'finalize' });
  $('finSourceLine').textContent = src || 'Not chosen yet';
  if (src) finRunScan();
  else {
    $('finList').innerHTML = `<li class="fin-empty-state"><span class="illo">${ILLO_COMPRESS}</span>
      <p class="fin-empty-tx">Choose your <b>Compressed</b> folder to begin</p>
      <p class="muted small">Point the app at where your compressed clips live — it matches them to the names you gave, embeds metadata, and files them into your Projects tree.</p></li>`;
    $('finSummaryLine').textContent = 'Choose your Compressed folder to begin.'; $('finNext1Btn').disabled = true;
  }
}

async function finRunScan() {
  if (!finScan.dir) return;
  $('finScanState').classList.remove('hidden');
  $('finScanState').innerHTML = `<div class="scan-busy"><span class="illo scan-illo">${ILLO_SCAN}</span><p class="scan-busy-tx">Scanning your compressed clips…</p></div>`;
  $('finList').innerHTML = '';
  // A throw here used to leave the "Scanning your compressed clips…" spinner turning forever
  // with finNext1Btn never enabled — Organize step 1 was simply dead, and silent about it.
  let res = null;
  try {
    res = await window.api.finalizeScan(finScan.dir, { includePhotos: !!uiPrefs.finalizePhotos });
  } catch (e) {
    res = { ok: false, error: (e && e.message) || String(e) };
  } finally {
    $('finScanState').classList.add('hidden');
  }
  if (!res || !res.ok) {
    $('finSummaryLine').textContent = `Scan failed: ${res ? res.error : 'unknown error'}`;
    $('finNext1Btn').disabled = true;
    return;
  }
  finScan.files = res.files;
  finRenderList();
}

function finMatched() { return finScan.files.filter((f) => f.matched); }
function finSelected() { return finMatched().filter((f) => f.selected); }

let finQuery = '';
let finVisibleMatched = [];   // matched rows currently shown (after search + matched-only)

// A clip matches the search if the query appears in its filename or any of its
// metadata fields (subject / description / category / project).
function finMatchesQuery(f, q) {
  if (!q) return true;
  if (f.name.toLowerCase().includes(q)) return true;
  const m = f.meta || {};
  return [m.subject, m.description, m.category, m.project]
    .some((v) => String(v || '').toLowerCase().includes(q));
}

function finRenderList() {
  const listEl = $('finList');
  listEl.innerHTML = '';
  const files = finScan.files;
  const matched = finMatched();
  // Default every matched clip to selected (tick once, untick to narrow down).
  for (const f of matched) if (f.selected === undefined) f.selected = true;
  const nameN = matched.filter((f) => f.matchType === 'name').length;
  let summary = files.length
    ? `${files.length} clip${files.length !== 1 ? 's' : ''} found · ${matched.length} with metadata`
    : 'No video files in this folder.';
  if (nameN) summary += ` (${nameN} from filename)`;
  $('finSummaryLine').textContent = summary;

  const q = finQuery.trim().toLowerCase();
  const onlyMatched = !!uiPrefs.finMatchedOnly;
  let pool = files.filter((f) => finMatchesQuery(f, q));
  finVisibleMatched = pool.filter((f) => f.matched);
  const ordered = [...finVisibleMatched, ...(onlyMatched ? [] : pool.filter((f) => !f.matched))];

  if (!ordered.length) {
    const li = document.createElement('li');
    li.className = 'fin-empty-state';
    li.innerHTML = `<span class="illo">${ILLO_EMPTY}</span><p class="fin-empty-tx">${q ? `No clips match “${escapeHtml(finQuery.trim())}”` : 'No clips in this folder'}</p>${q ? '<p class="muted small">Try a different search, or clear the filter.</p>' : '<p class="muted small">This folder has no video files — choose another above.</p>'}`;
    listEl.appendChild(li);
  }
  for (const f of ordered) {
    const li = document.createElement('li');
    li.className = 'fin-item' + (f.matched ? '' : ' fin-unmatched');
    if (f.matched) {
      li.innerHTML = `<input type="checkbox" class="fin-check" ${f.selected ? 'checked' : ''} />
        <span class="fin-body">
          <span class="fin-head-row"><span class="file-name">${finHighlight(f.name, q)}</span>${finSrcBadge(f)}</span>
          ${finMetaChips(f.meta)}
        </span>
        <span class="file-size">${fmtBytes(f.size)}</span>`;
      const cb = li.querySelector('.fin-check');
      cb.addEventListener('change', () => { f.selected = cb.checked; finUpdateSelectionUI(); });
    } else {
      li.innerHTML = `<span class="fin-check-spacer" aria-hidden="true"></span>
        <span class="fin-body"><span class="fin-head-row"><span class="file-name">${finHighlight(f.name, q)}</span><span class="fin-src-badge skip">no metadata</span></span></span>
        <span class="file-size">${fmtBytes(f.size)}</span>`;
    }
    listEl.appendChild(li);
  }
  finUpdateSelectionUI();
}

// Where a clip's metadata came from — saved (rich, embedded earlier) vs parsed back
// out of the filename. Saved is the strong match; filename is the fallback.
function finSrcBadge(f) {
  return f.matchType === 'name'
    ? '<span class="fin-src-badge name" title="Read from the filename — no saved tags found">from filename</span>'
    : '<span class="fin-src-badge saved" title="Rich metadata you saved earlier (people, description, route)">saved tags</span>';
}
// Surface the actual metadata that will be embedded into the file at Finalize, so
// this screen shows the same rich AI/face data as the Rename screen — one app, not
// a plain file list. Chips: subject · description · shot type · people · category›project.
function finMetaChips(meta) {
  const m = meta || {};
  const deh = (s) => String(s || '').replace(/[-_]+/g, ' ').trim();
  const chips = [];
  if (m.subject) chips.push(`<span class="fin-chip subj">${escapeHtml(deh(m.subject))}</span>`);
  if (m.description) chips.push(`<span class="fin-chip desc">${escapeHtml(deh(m.description))}</span>`);
  if (m.shotType) chips.push(`<span class="fin-chip shot">${escapeHtml(deh(m.shotType))}</span>`);
  const ppl = (Array.isArray(m.people) ? m.people : []).filter(Boolean);
  if (ppl.length) chips.push(`<span class="fin-chip people"><span class="fin-chip-ic">👤</span>${escapeHtml(ppl.join(', '))}</span>`);
  const tg = (Array.isArray(m.tags) ? m.tags : []).filter(Boolean);
  tg.slice(0, 5).forEach((t) => chips.push(`<span class="fin-chip tag"><span class="fin-chip-ic">🏷</span>${escapeHtml(t)}</span>`));
  if (tg.length > 5) chips.push(`<span class="fin-chip tag more">+${tg.length - 5}</span>`);
  const route = [m.category, m.project].filter(Boolean).map(deh).join(' › ');
  if (route) chips.push(`<span class="fin-chip route">${escapeHtml(route)}</span>`);
  else chips.push('<span class="fin-chip route empty">unfiled</span>');
  if (m.location) chips.push(`<span class="fin-chip loc"><span class="fin-chip-ic">📍</span>${escapeHtml(deh(m.location))}</span>`);
  return chips.length ? `<span class="fin-meta-row">${chips.join('')}</span>` : '';
}

// ANALYZE FROM FINALIZE: enrich the ticked compressed clips in place — face
// recognition (auto-tag people we've trained) + AI naming (subject/description/shot/
// tags) — and write it straight into their saved metadata. This is what lets clips
// that arrived "from filename" (never went through the Rename screen) get the full
// people + rich-tag treatment right here. Reuses the same local IPCs; fully offline.
async function finAnalyzeSelected() {
  if (!requireAi()) return;
  const sel = finSelected();
  if (!sel.length) { showToast('Tick some clips first — Analyze enriches the ticked ones'); return; }
  aiAborted = false;
  const facesReady = (await ensureFaceModels()).ok;   // face rec is best-effort
  // RESUME: a clip is "done" once AI has analyzed it (flag persisted in finalMeta), so
  // re-running picks up where it left off instead of starting over. If everything's
  // already done, offer a full re-analyze.
  const isAnalyzed = (f) => !!(f._aiAnalyzed || (f.meta && f.meta.aiAnalyzed));
  let pending = sel.filter((f) => !isAnalyzed(f));
  const already = sel.length - pending.length;
  if (!pending.length) {
    const redo = await confirmDialog('All selected clips are already analyzed', `Re-analyze all ${sel.length} from scratch?`, 'Re-analyze all', 'Cancel');
    if (!redo) { showToast('Nothing to resume — all done ✓'); return; }
    pending = sel; sel.forEach((f) => { f._aiAnalyzed = false; if (f.meta) f.meta.aiAnalyzed = false; });
  } else if (already) {
    showToast(`Resuming — skipping ${already} already analyzed, ${pending.length} to go`, 4000);
  }
  // Surface each clip in the live real-thumbnail conveyor (caption from its meta).
  pending.forEach((f) => { f.subject = (f.meta && f.meta.subject) || f.subject || ''; f.description = (f.meta && f.meta.description) || f.description || ''; });
  setAiRunClips(pending);
  const quick = !!(document.getElementById('finQuick') && document.getElementById('finQuick').checked);
  const autoTagFaces = !!(document.getElementById('finAuto') && document.getElementById('finAuto').checked);
  const subjKeyOf = (f) => slug((f.meta && f.meta.subject) || f.subject || f.name.replace(/\.[^.]+$/, '')) || 'x';
  const groups = {};             // subjKey -> [clips], so a quick face scan can tag the whole group
  pending.forEach((f) => { const k = subjKeyOf(f); (groups[k] = groups[k] || []).push(f); });
  const byKey = {}; for (const f of pending) byKey[f.key || f.sourcePath] = f;
    // SEEDED, and this matters: an un-seeded array here was silent data loss. When the review grid
    // renders it calls schedulePendingSave(clusters) -> faces:savePending, which REPLACES the whole
    // pending store. So starting from [] meant an Analyze run quietly deleted every unconfirmed face
    // from an earlier scan. scanFacesForClips has always seeded this way ("a scan merges, never
    // replaces"); these callers just never got the same treatment.
  const faceClusters = await loadPendingFaces();
  await ensureFaceScenes();
  const faceAutoByName = new Map();
  let ok = 0; let lastErr = '';

  // ===== PHASE 1 — FACES: scan everyone first, then either VERIFY with you, or (with
  // the toggle on) auto-tag the suggested names so naming can use them without you
  // stopping. Either way the faces still sit UNCONFIRMED in the Faces panel for review. =====
  if (facesReady) {
    const facesDoneSubj = new Set(); let fdone = 0;
    for (const f of pending) {
      if (aiAborted) break;
      f.meta = f.meta || {};
      const fk = subjKeyOf(f);
      if (!quick || !facesDoneSubj.has(fk)) {
        setTask('faces', 'Face scan', fdone + 1, quick ? Object.keys(groups).length : pending.length, 'scanning', f.name);
        aiStageAdvance(f, 'scanning faces');
        try {
          const keys = quick ? (groups[fk] || [f]).map((c) => c.key || c.sourcePath) : undefined;
          await aiCallGuard(collectClipFaces(f, faceClusters, keys), 200000);
        } catch { /* best-effort */ }
        facesDoneSubj.add(fk); fdone += 1;
      }
    }
    clearTask('faces');
    if (faceClusters.length && !aiAborted) {
      if (autoTagFaces) {
        // No-intervention mode: apply each face's best-guess name straight onto its clips
        // (still UNCONFIRMED on the person — you confirm later in the Faces panel).
        let tagged = 0;
        for (const c of faceClusters) { const nm = c.suggest && c.suggest.name; if (!nm) continue; for (const k of c.clipKeys) { const f = byKey[k]; if (f) { f.meta = f.meta || {}; f.meta.people = [...new Set([...(f.meta.people || []), nm])]; tagged += 1; } } }
        if (tagged) pushActivity(`Auto-tagged ${faceClusters.filter((c) => c.suggest).length} recognized face${faceClusters.filter((c) => c.suggest).length !== 1 ? 's' : ''} — confirm later in the Faces panel`, 'match');
      } else {
        // Verify with you BEFORE naming, so the names can include who's actually in each clip.
        await showFaceReviewGrid(faceClusters, pending, 0);
      }
      // Persist either way — the auto-tag branch above never opened a grid, so nothing else would
      // have written these clusters to disk.
      try { savePendingNow(faceClusters); saveFaceScenesNow(); } catch { /* best-effort */ }
    }
  }

  // ===== PHASE 2 — NAME: now that people are known, describe + name every clip, and
  // IMPROVE an existing name/description instead of starting from scratch. =====
  setAiRunClips(pending);
  const repResult = new Map();
  let done = already;
  for (const f of pending) {
    if (aiAborted) break;
    f.meta = f.meta || {};
    // People from phase 1 (the grid sets clip.people; auto-tag sets meta.people) → naming.
    const ppl = [...new Set([...((f.meta.people) || []), ...((f.people) || [])])].filter(Boolean);
    if (ppl.length) f.meta.people = ppl;
    const applyNaming = (r, reused) => {
      if (r.subject) f.meta.subject = r.subject;
      if (r.description) f.meta.description = r.description;
      if (r.shotType) f.meta.shotType = r.shotType;
      if (r.category && aiCfg.suggestCategory && !f.meta.category) f.meta.category = r.category;
      if (Array.isArray(r.tags) && r.tags.length) f.meta.tags = [...new Set([...(f.meta.tags || []), ...r.tags.filter(Boolean)])];
      if (r.observation) { f.meta.observation = r.observation; noteClipObs(f, r.observation); }
      f.matched = true; f.matchType = 'saved';
      f._aiAnalyzed = true; f.meta.aiAnalyzed = true;
      try { window.api.saveFinalMeta({ [f.name]: { ...f.meta } }); } catch { /* non-fatal */ }
      pushActivity(reused ? `Reused "${r.subject || ''}" from a matching clip` : `Wrote: ${[r.subject, r.description].filter(Boolean).join(' — ')}`, 'write');
      ok += 1;
    };
    const sk = subjKeyOf(f);
    if (quick && repResult.has(sk)) {
      setTask('ai', aiModelLabel(), done + 1, sel.length, 'same subject', f.name);
      aiStageAdvance(f, 'reused');
      applyNaming(repResult.get(sk), true);
    } else {
      setTask('ai', aiModelLabel(), done + 1, sel.length, 'analyzing', f.name);
      aiStageAdvance(f, 'analyzing');
      pushActivity(`Asking ${aiModelLabel()} to describe ${f.name}…`, 'describe');
      const res = await aiCallGuard(window.api.aiSuggest({
        sourcePath: f.sourcePath, model: aiCfg.model, quick,
        subjects: subjectsCache,
        categories: (aiCfg.suggestCategory && fieldHistoryCache.category) ? fieldHistoryCache.category : [],
        context: '', people: (f.meta.people) || [],
        // Feed any existing name so the AI IMPROVES it (and weaves in tags) rather than
        // ignoring it — also makes re-analyze tighten a name instead of replacing it.
        draft: { subject: f.meta.subject || '', description: f.meta.description || '', location: f.meta.location || '' }
      }), 200000);
      if (res && res.ok) {
        const r = { subject: res.subject, description: res.description, shotType: res.shotType, category: res.category, tags: res.tags, observation: res.observation };
        if (quick) repResult.set(sk, r);
        applyNaming(r, false);
      } else if (res && res.error) { lastErr = res.error; logIssue('AI analyze', `${f.name}: ${res.error}`); }
    }
    done += 1;
    finRenderList();
  }
  clearTask('ai');
  aiStageClose();
  const photoN = pending.filter((f) => f.isPhoto).length;
  showToast(ok ? `Analyzed ${ok} item${ok !== 1 ? 's' : ''}${photoN ? ` (incl. ${photoN} photo${photoN !== 1 ? 's' : ''})` : ''} ✓` : `Analyze failed${lastErr ? `: ${lastErr}` : ''}`, 5000);
}

// Set each ticked clip's date back to its ORIGINAL recorded date (ffprobe
// creation_time embedded in the file), overriding whatever the filename implied.
async function finResetDates() {
  const sel = finSelected();
  if (!sel.length) { showToast('Tick some clips first'); return; }
  let changed = 0; let none = 0;
  setTask('ai', 'Dates', 1, 1, 'reading original dates');
  for (const f of sel) {
    let meta = null;
    try { meta = await window.api.getMeta(f.sourcePath); } catch { /* ignore */ }
    const iso = meta && meta.dateISO ? String(meta.dateISO) : '';
    const d = iso.match(/^(\d{4}-\d{2}-\d{2})/);
    if (d) { f.meta = f.meta || {}; if (f.meta.date !== d[1]) { f.meta.date = d[1]; changed += 1; try { window.api.saveFinalMeta({ [f.name]: { ...f.meta } }); } catch { /* non-fatal */ } } }
    else none += 1;
  }
  clearTask('ai');
  finRenderList();
  showToast(changed ? `Reset ${changed} date${changed !== 1 ? 's' : ''} to the original recording date ✓${none ? ` · ${none} had none embedded` : ''}` : 'No original dates were embedded in these files', 5000);
}

// Highlight the matched substring of the filename (escaped).
function finHighlight(name, q) {
  if (!q) return escapeHtml(name);
  const i = name.toLowerCase().indexOf(q);
  if (i === -1) return escapeHtml(name);
  return escapeHtml(name.slice(0, i)) + `<mark>${escapeHtml(name.slice(i, i + q.length))}</mark>` + escapeHtml(name.slice(i + q.length));
}

// Continue button counts the global selection; Select-all reflects/acts on the
// currently-visible (searched) matched rows so "search → select all" works.
function finUpdateSelectionUI() {
  const sel = finSelected();
  $('finNext1Btn').disabled = sel.length === 0;
  $('finNext1Btn').textContent = sel.length ? `Continue · ${sel.length} clip${sel.length !== 1 ? 's' : ''}` : 'Continue';
  const vis = finVisibleMatched;
  $('finSelectAll').checked = vis.length > 0 && vis.every((f) => f.selected);
  $('finSelectAll').disabled = vis.length === 0;
}

$('finSelectAll').addEventListener('change', (e) => {
  const on = e.target.checked;
  finVisibleMatched.forEach((f) => { f.selected = on; });   // act on what's visible
  finRenderList();
});

$('finSearch').addEventListener('input', (e) => {
  finQuery = e.target.value;
  $('finSearchClear').classList.toggle('hidden', !finQuery);
  finRenderList();
});
$('finSearchClear').addEventListener('click', () => {
  finQuery = '';
  $('finSearch').value = '';
  $('finSearchClear').classList.add('hidden');
  finRenderList();
  $('finSearch').focus();
});

$('finMatchedOnly').addEventListener('change', (e) => {
  uiPrefs.finMatchedOnly = e.target.checked;
  window.api.setUiPref('finMatchedOnly', e.target.checked);
  finRenderList();
});
{ const fq = $('finQuick'); if (fq) fq.addEventListener('change', (e) => { uiPrefs.quickAnalyze = e.target.checked; window.api.setUiPref('quickAnalyze', e.target.checked); }); }
{ const fp = $('finPhotos'); if (fp) fp.addEventListener('change', (e) => { uiPrefs.finalizePhotos = e.target.checked; window.api.setUiPref('finalizePhotos', e.target.checked); finRunScan(); }); }
{ const fa = $('finAuto'); if (fa) fa.addEventListener('change', (e) => { uiPrefs.autoTagFaces = e.target.checked; window.api.setUiPref('autoTagFaces', e.target.checked); }); }
// "Later I go to the output folder and get AI to work out which project each video belongs in —
// this part I know sucks."
//
// It sucked because it was a single giant prompt over every clip at once, it had no idea what
// projects actually existed, and whatever you told it evaporated the moment the window closed.
//
// Now: group the clips → check what you already decided (no model call at all if we know) → ask the
// model, which must SEARCH the real Projects tree before it may place or invent anything → show one
// card per group, exactly like the faces popup → your answer is remembered forever.
// `<project>/<YYYY-MM-DD>` — a folder per shoot inside the project.
//
// A client (Gourgess Lawns) runs all year; a shoot is a single day. 68 lawn-mowing clips loose in one
// folder is not organized, it is a pile with a name.
//
// The exception, and he already has several of these: a project folder that IS a shoot —
// `2026-05-30_vlog_water-park_v1`. Nesting `2026-05-30/` inside that would be a date folder inside a
// folder already named after the date. If the project already carries the day, leave it alone.
function shootFolderFor(projectPath, day) {
  const p = String(projectPath || '').replace(/[\\/]+$/, '');
  if (!p) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return p;      // no usable date — file into the project itself
  const leaf = p.split(/[\\/]/).pop() || '';
  if (leaf.includes(day)) return p;                     // the project IS this shoot
  return `${p}/${day}`;
}

async function finPlaceIntoProjects() {
  const sel = (finSelected().length ? finSelected() : finMatched());
  if (!sel.length) { showToast('Nothing ticked to file'); return; }
  if (!aiCfg.enabled) { showToast('Turn AI on in Settings first'); return; }

  const clips = sel.map((f) => ({
    name: f.name,
    sourcePath: f.sourcePath,
    subject: (f.meta && f.meta.subject) || '',
    description: (f.meta && f.meta.description) || '',
    location: (f.meta && f.meta.location) || '',
    date: (f.meta && f.meta.date) || '',
    people: (f.meta && f.meta.people) || [],
    tags: (f.meta && f.meta.tags) || [],
    observation: (f.meta && f.meta.observation) || '',
    _ref: f,
  }));

  // Placement runs entirely on the REASONING model — no vision at all. So evict whatever the last
  // analyze run left resident before we start, or the reasoning model loads on top of a vision model
  // that nothing is using and OOMs on a smaller card.
  try { await window.api.aiUseOnly(aiToolModelReady ? aiToolModelName : (aiCfg.textModel || aiCfg.model)); }
  catch { /* non-fatal — worst case Ollama sorts it out or we fall back */ }

  let placed = null;
  try {
    placed = await withBusyBtn($('finPlaceBtn'), 'Sorting…', () => showPlacementReview(clips));
  } finally {
    await releaseGpu();   // hand the card back whether they filed everything or closed the grid
  }
  if (!placed || !placed.length) return;

  // Write the decision back onto the clips as ledgerRel — which is what the destination map reads to
  // decide where a clip goes. Without this the popup would ask, the user would answer, and the map
  // would still file everything into _Unsorted.
  const patch = {};
  let n = 0;
  for (const { clips: gClips, path } of placed) {
    // A SUBFOLDER PER SHOOT. His call: `Gourgess Lawns/2026-06-01/…`, not 68 lawn-mowing clips loose
    // in one client folder. A client runs all year; a shoot is a day.
    const day = String((gClips[0] && gClips[0].date) || '').slice(0, 10);
    const rel = shootFolderFor(path, day);
    for (const c of gClips) {
      const f = c._ref;
      if (!f) continue;
      f.meta = f.meta || {};
      f.meta.ledgerRel = rel;
      patch[f.name] = { ...f.meta };
      n += 1;
    }
  }
  try { await window.api.saveFinalMeta(patch); } catch { /* the map still shows it; it just won't survive a restart */ }

  renderFinMap();   // redraw the folder map with the destinations the user just confirmed
  showToast(`${n} clip${n !== 1 ? 's' : ''} filed into ${placed.length} project${placed.length !== 1 ? 's' : ''} ✓ — it'll remember next time`, 5000);
}

$('finPlaceBtn').addEventListener('click', finPlaceIntoProjects);
$('finAnalyzeBtn').addEventListener('click', finAnalyzeSelected);
$('finDatesBtn').addEventListener('click', finResetDates);

// --- Step 2: folder-structure editor (checkbox + reorder + live preview) ---
function finRenderLevels() {
  const listEl = $('finLevels');
  const prevEl = $('finPreview');
  const ordered = [...finLevels, ...finAllLevels().map((a) => a.id).filter((id) => !finLevels.includes(id))];
  listEl.innerHTML = '';
  ordered.forEach((id) => {
    const inLevels = finLevels.includes(id);
    const idx = finLevels.indexOf(id);
    const row = document.createElement('div'); row.className = 'org-row';
    row.innerHTML = `
      <input type="checkbox" class="org-chk" ${inLevels ? 'checked' : ''} />
      <span class="org-name">${escapeHtml(finLevelLabel(id))}</span>
      <button type="button" class="org-up" ${inLevels && idx > 0 ? '' : 'disabled'} title="Move up">▲</button>
      <button type="button" class="org-down" ${inLevels && idx >= 0 && idx < finLevels.length - 1 ? '' : 'disabled'} title="Move down">▼</button>`;
    row.querySelector('.org-chk').addEventListener('change', (e) => {
      if (e.target.checked) { if (!finLevels.includes(id)) finLevels.push(id); }
      else finLevels = finLevels.filter((x) => x !== id);
      finRenderLevels();
    });
    row.querySelector('.org-up').addEventListener('click', () => {
      const i = finLevels.indexOf(id); if (i > 0) { [finLevels[i - 1], finLevels[i]] = [finLevels[i], finLevels[i - 1]]; finRenderLevels(); }
    });
    row.querySelector('.org-down').addEventListener('click', () => {
      const i = finLevels.indexOf(id); if (i >= 0 && i < finLevels.length - 1) { [finLevels[i + 1], finLevels[i]] = [finLevels[i], finLevels[i + 1]]; finRenderLevels(); }
    });
    listEl.appendChild(row);
  });
  const destName = finEffectiveDest() || '(choose a folder)';
  const parts = finLevels.length ? finLevels.map((id) => finLevelLabel(id).toLowerCase()).join('\\') + '\\' : '';
  prevEl.textContent = `${destName}\\${parts}clip.mp4`;
  finRenderExample('finExample2');
}

function finRenderRunSummary() {
  const matched = finSelected();
  const acts = [];
  if ($('finEmbed').checked) acts.push('embed metadata into each file');
  if ($('finCsv').checked) acts.push('write a Resolve CSV');
  if ($('finOrganize').checked) acts.push(`file them into ${finDestMode === 'custom' ? 'the chosen folder' : 'subfolders in the Compressed folder'}`);
  if ($('finNas').checked) acts.push('back up a copy to the NAS');
  $('finRunSummary').textContent =
    `Ready to ${acts.join(', ').replace(/, ([^,]*)$/, ', and $1') || 'do nothing — pick an action on the previous step'} for ${matched.length} clip${matched.length !== 1 ? 's' : ''}.`;
  finRenderExample('finExample3');
}

// Resolve a clip's stored metadata into the concrete values that will be written
// (Title / Description / Keywords) and the folder path it'll land in.
function finExampleData() {
  const clip = finSelected()[0] || finMatched()[0];
  if (!clip) return null;
  const m = clip.meta || {};
  const seen = new Set(); const keywords = [];
  for (const v of [m.subject, m.category, m.project, ...(m.keywords || [])]) {
    const s = String(v || '').trim();
    if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); keywords.push(s); }
  }
  const title = [m.subject, m.description].filter(Boolean).join(' ').trim() || clip.name.replace(/\.[^.]+$/, '');
  // Skip empty levels (mirrors main's subdirParts) — no "unsorted" folders.
  const valForLevel = (l) => (l === 'subject' ? m.subject : l === 'date' ? m.date : m[l]) || '';
  const sub = finLevels.map((l) => slug(valForLevel(l))).filter(Boolean);
  return { name: clip.name, title, description: m.description || '', keywords, sub, dest: finEffectiveDest(), derived: clip.matchType === 'name' };
}

// Render the "this is what will happen to one of your clips" preview card.
function finRenderExample(containerId) {
  const el = $(containerId);
  if (!el) return;
  const ex = finExampleData();
  if (!ex) { el.innerHTML = '<span class="muted small">No clip selected.</span>'; return; }
  const embedOn = $('finEmbed').checked, csvOn = $('finCsv').checked, orgOn = $('finOrganize').checked, nasOn = $('finNas').checked;
  const dash = '<span class="muted">—</span>';
  const row = (k, v) => `<div class="fin-ex-row"><span class="fin-ex-k">${k}</span><span class="fin-ex-v">${v}</span></div>`;
  let html = `<div class="fin-ex-head"><span class="fin-ex-file">${escapeHtml(ex.name)}</span>${ex.derived ? '<span class="fin-ex-badge">from filename</span>' : '<span class="fin-ex-badge saved">saved tags</span>'}</div>`;
  if (embedOn) {
    html += row('Title', escapeHtml(ex.title) || dash);
    html += row('Description', escapeHtml(ex.description) || dash);
    html += row('Keywords', ex.keywords.length ? ex.keywords.map((k) => `<span class="fin-ex-tag">${escapeHtml(k)}</span>`).join('') : dash);
  }
  if (orgOn) html += row('Folder', `<span class="fin-ex-path">${escapeHtml([ex.dest, ...ex.sub, ex.name].join('\\'))}</span>`);
  if (csvOn) html += row('CSV', 'a row in <code>resolve-metadata.csv</code>');
  if (nasOn) html += row('NAS', 'a backup copy at the same folder path');
  if (!embedOn && !csvOn && !orgOn && !nasOn) html += '<span class="muted small">Pick at least one action above.</span>';
  el.innerHTML = html;
}

// Show/hide the dependent rows (custom-destination path, NAS path, the whole
// organize-options block when "Move into folders" is off).
function syncFinOptionRows() {
  $('finOrganizeOpts').classList.toggle('hidden', !$('finOrganize').checked);
  document.querySelector('.fin-dest-row').classList.toggle('hidden', finDestMode !== 'custom');
  $('finDestPath').value = finCustomDest || '';
  document.querySelector('.fin-nas-row').classList.toggle('hidden', !$('finNas').checked);
  $('finNasPath').value = finNasPathVal || '';
  finRenderExample('finExample2');
}

// ---------------------------------------------------------------------------
// COMPRESS FOOTAGE — a real in-app ffmpeg transcode of the Uncompressed intake
// clips into the Compressed folder. Live per-file progress, presets, skip-existing,
// cancel, and a hand-off to Organize. This is the app actually delivering "Compress".
