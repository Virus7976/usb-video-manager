// ---------------------------------------------------------------------------
// Preview: every clip shows a static poster frame (an image — no video decode).
// Only ONE clip plays at a time in a real <video>; playing another (or this
// one's poster being restored) tears the previous one down. This keeps us to a
// single GPU HEVC decode session, which is all the hardware reliably allows.
// ---------------------------------------------------------------------------
let activeVideoIndex = null;
let activeMode = null;        // 'hover' | 'edit' | 'audio'
let hoverTimer = null;

// Render a photo clip's preview — the image itself (full quality), or a friendly
// fallback if the format can't render in Chromium (e.g. HEIC/DNG).
async function showClipPhoto(i) {
  const clip = state.scannedFiles[i];
  const wrap = document.querySelector(`[data-preview="${i}"] .frame-wrap`);
  if (!clip || !wrap) return;
  const url = await window.api.getPoster(clip.sourcePath);
  clip.posterUrl = url;
  wrap.innerHTML = '';
  if (url) {
    const img = document.createElement('img');
    img.src = url; img.loading = 'lazy'; img.className = 'clip-photo';
    img.onerror = () => { wrap.innerHTML = `<span class="placeholder keep-emoji photo-ph">🖼️<span class="photo-ph-tx">${escapeHtml((clip.ext || '').replace('.', '').toUpperCase() || 'Photo')}</span></span>`; };
    wrap.appendChild(img);
  } else {
    wrap.innerHTML = '<span class="placeholder keep-emoji photo-ph">🖼️<span class="photo-ph-tx">Photo</span></span>';
  }
}

async function initPreview(i) {
  const clip = state.scannedFiles[i];
  const wrap = document.querySelector(`[data-preview="${i}"] .frame-wrap`);
  if (!clip || !wrap) return;
  wrap.innerHTML = '<span class="placeholder">Loading…</span>';

  // A video still on the phone (real MTP, not yet copied) has no local file to read —
  // show a clear "on phone" placeholder; it gets pulled at the copy step.
  if (clip.kind === 'video' && !clip.sourcePath) {
    wrap.innerHTML = '<span class="placeholder ph-onphone keep-emoji">📱<span class="ph-onphone-tx">On phone</span></span>';
    return;
  }

  // Photos: just show the image, full quality — no hover-video / play overlay.
  if (isPhotoClip(clip)) { await showClipPhoto(i); return; }

  // Hover → muted looping preview (auto-plays as you move over a clip). These
  // listeners live on the persistent wrap element, not its (re-rendered) content.
  wrap.addEventListener('mouseenter', () => {
    if (activeMode === 'audio') return;   // don’t interrupt an explicit audio play
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => playClip(i, 'hover'), 130);
  });
  wrap.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    if (activeVideoIndex === i && activeMode === 'hover') teardownVideo(i);
  });

  const posterUrl = await window.api.getPoster(clip.sourcePath);
  clip.posterUrl = posterUrl;
  if (activeVideoIndex !== i) showPoster(i, posterUrl);

  // Refine the date from the clip's recording metadata (ffprobe creation_time),
  // but never overwrite a date the user explicitly set or restored from a draft.
  const meta = await window.api.getMeta(clip.sourcePath);
  if (meta && meta.dateISO && !clip.dateLocked) {
    const ds = isoToDateStr(meta.dateISO);
    if (ds && ds !== clip.date) { clip.date = ds; refreshNames(); }
  }
}

function showPoster(i, posterUrl) {
  const wrap = document.querySelector(`[data-preview="${i}"] .frame-wrap`);
  if (!wrap) return;
  wrap.innerHTML = '';
  if (posterUrl) {
    const img = document.createElement('img');
    img.src = posterUrl;
    wrap.appendChild(img);
  } else {
    const ph = document.createElement('span');
    ph.className = 'placeholder';
    ph.textContent = 'No preview (the file is fine — it’ll still copy)';
    wrap.appendChild(ph);
  }
  const play = document.createElement('button');
  play.className = 'play-overlay';
  play.title = 'Play with audio';
  play.addEventListener('click', (e) => { e.stopPropagation(); playClip(i, 'audio'); });
  wrap.appendChild(play);
  // Clicking the preview (poster or a muted hover-preview) plays it with audio.
  wrap.onclick = () => playClip(i, 'audio');
}

// mode: 'hover'/'edit' → muted, looping, no controls (clean preview).
//       'audio'        → with sound, looping, minimal controls + a stop button.
// Minimal corner chip marking a clip's media type (image glyph vs play glyph) — same
// visual language on the rename card and the phone picker so they read consistently.
function mediaKindChip(kind) {
  const svg = kind === 'video'
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.87l11-6.5a1 1 0 0 0 0-1.74l-11-6.5A1 1 0 0 0 8 5.5z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15l-5-5L5 21"/></svg>';
  return `<span class="clip-kind-badge mk-${kind}" title="${kind === 'video' ? 'Video' : 'Photo — original quality'}">${svg}</span>`;
}

// A clip is a photo if flagged OR its extension is an image type — robust against a
// missing `isPhoto`/`kind` flag (e.g. older drafts), so we never try to <video> a JPG.
function isPhotoClip(clip) {
  if (!clip) return false;
  if (clip.isPhoto || clip.kind === 'photo') return true;
  return /\.(jpe?g|png|heic|heif|dng|gif|webp|bmp|tiff?)$/i.test(clip.name || clip.sourcePath || '');
}

async function playClip(i, mode) {
  const clip = state.scannedFiles[i];
  const wrap = document.querySelector(`[data-preview="${i}"] .frame-wrap`);
  if (!clip || !wrap) return;
  if (isPhotoClip(clip)) { showClipPhoto(i); return; }   // photos never play as video

  // Already playing this clip in the same (or higher) mode? leave it.
  if (activeVideoIndex === i && (activeMode === mode || activeMode === 'audio')) return;

  // Only one HEVC decode session at a time.
  if (activeVideoIndex !== null && activeVideoIndex !== i) teardownVideo(activeVideoIndex);
  activeVideoIndex = i;
  activeMode = mode;

  // Audio plays when explicitly requested, or always-on via the setting.
  const audio = mode === 'audio' || (uiPrefs.autoplayAudio && mode !== 'audio');
  const url = await window.api.mediaUrl(clip.sourcePath);
  if (activeVideoIndex !== i) return; // changed while awaiting
  // Fully unload any existing <video> in this wrap (e.g. upgrading hover→audio)
  // so we never hold two HEVC decoders at once.
  const existing = wrap.querySelector('video');
  if (existing) { try { existing.pause(); existing.removeAttribute('src'); existing.load(); } catch { /* ignore */ } }
  wrap.innerHTML = '';

  const video = document.createElement('video');
  video.className = 'clip-video';
  video.controls = audio;
  video.muted = !audio;
  video.loop = true;                 // infinite loop
  video.autoplay = true;
  video.setAttribute('controlsList', 'nofullscreen nodownload noremoteplayback noplaybackrate');
  video.src = url;
  video.playbackRate = currentSpeed;
  video.addEventListener('loadedmetadata', () => { video.playbackRate = currentSpeed; });
  video.addEventListener('play', () => { video.playbackRate = currentSpeed; });
  video.addEventListener('error', () => {
    wrap.innerHTML = '<span class="placeholder">Can’t preview this format — the file is fine and will still copy</span>';
  });
  wrap.appendChild(video);
  video.play().catch(() => { /* autoplay race */ });

  if (mode === 'audio') {
    const close = document.createElement('button');
    close.className = 'video-close';
    close.innerHTML = '✕';
    close.title = 'Stop';
    close.addEventListener('click', (e) => { e.stopPropagation(); teardownVideo(i); });
    wrap.appendChild(close);
  } else if (!audio) {
    // Muted auto-preview: a centred unmute button to switch on sound.
    const unmute = document.createElement('button');
    unmute.className = 'unmute-overlay';
    unmute.title = 'Unmute (play with audio)';
    unmute.addEventListener('click', (e) => { e.stopPropagation(); playClip(i, 'audio'); });
    wrap.appendChild(unmute);
  }
}

function teardownVideo(i) {
  const wrap = document.querySelector(`[data-preview="${i}"] .frame-wrap`);
  if (activeVideoIndex === i) { activeVideoIndex = null; activeMode = null; }
  if (!wrap) return;
  const v = wrap.querySelector('video');
  if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* ignore */ } }
  showPoster(i, state.scannedFiles[i] && state.scannedFiles[i].posterUrl);
}

// Editing a clip's name plays it (muted, looping) so you can see what you're
// naming; it stops once you leave the row (unless you're hovering it).
function wireEditPlay(inp, i) {
  inp.addEventListener('focus', () => { if (activeMode !== 'audio') playClip(i, 'edit'); maybePreview(i); });
  inp.addEventListener('blur', () => {
    setTimeout(() => {
      const card = inp.closest('.rename-card');
      const wrap = card && card.querySelector('.frame-wrap');
      const stillInRow = document.activeElement && document.activeElement.closest
        && document.activeElement.closest('.rename-card') === card;
      const hovering = wrap && wrap.matches(':hover');
      if (activeMode === 'edit' && activeVideoIndex === i && !stillInRow && !hovering) teardownVideo(i);
    }, 160);
  });
}

// ---------------------------------------------------------------------------
// Batch bar — set one name, apply to all ticked clips (versions auto-number).
// ---------------------------------------------------------------------------
function selectedClips() {
  return state.scannedFiles.filter((c) => c.selected);
}

function updateBatchBar() {
  const sel = selectedClips();
  const count = sel.length;
  $('applyBatch').disabled = count === 0;
  $('applyBatch').textContent = `Apply to ${count}`;
  $('selectAllClips').checked = count > 0 && count === state.scannedFiles.length;

  // Default the batch date so a same-day batch shares one identical name (versions then
  // differentiate) — but ONLY when every selected clip already has that same date.
  //
  // This used to auto-fill from the FIRST selected clip, and applyBatch applies whatever is in the
  // field (copyDateMode defaults to 'always', so it doesn't even ask). So the ordinary flow —
  // Select all → type a subject → "Apply to N" — silently overwrote EVERY clip's real capture date
  // with the first clip's, and set dateLocked, which permanently blocks ffprobe from correcting it
  // afterwards. On a card holding two shoots, the older day's clips were stamped with the newer
  // day's date and the day dividers collapsed into one. The date was the only field applied without
  // the user ever typing it.
  //
  // `_auto` marks a value WE filled in. A date the user picked is never touched.
  const dateEl = $('batchDate');
  if (dateEl.dataset.auto === '1' || !dateEl.dataset.value) {
    const dates = new Set(sel.map((c) => c.date).filter(Boolean));
    if (count > 0 && dates.size === 1) {
      setDateField(dateEl, [...dates][0]);
      dateEl.dataset.auto = '1';
    } else {
      // A mixed-date selection (or none) gets NO shared date — each clip keeps its own. This also
      // clears a stale auto-date left over from a previous selection, which used to survive an
      // untick-everything and then be stamped onto a completely different day's clips.
      setDateField(dateEl, '');
      delete dateEl.dataset.auto;
    }
  }
  renderCheckedStrip();
  refreshPreviewGrid();   // keep the pop-out grid wall in sync with the selection
}

async function applyBatch() {
  const sel = selectedClips();
  if (sel.length === 0) return;
  const date = $('batchDate').dataset.value;
  const subject = $('batchSubject').value.trim();
  const description = $('batchDesc').value.trim();
  const location = ($('batchLocation') ? $('batchLocation').value : '').trim();
  const fieldVals = {};
  for (const fld of organizeFields) {
    const inp = document.querySelector(`#batchMetaFields [data-field="${fld.id}"]`);
    fieldVals[fld.id] = inp ? inp.value.trim() : '';
  }
  // Honor the copy-date setting (only matters if a batch date was actually set).
  let useDate = !!date;
  if (date) {
    const d = await decideCopyDate();
    if (d === null) return;          // cancelled
    useDate = d;
  }
  // Only apply fields you actually filled — so you can batch-tag one field
  // without wiping each clip's name (and vice versa).
  const indices = [];
  state.scannedFiles.forEach((clip, i) => {
    if (!clip.selected) return;
    if (useDate) { clip.date = date; clip.dateLocked = true; }
    if (subject) clip.subject = subject;
    if (description) clip.description = description;
    if (location) clip.location = location;
    for (const fld of organizeFields) if (fieldVals[fld.id]) clip[fld.id] = fieldVals[fld.id];
    indices.push(i);
  });
  syncRowInputs(indices);
  if (subject) rememberSubject(subject);
  if (description) rememberDescription(description);
  if (location) rememberLocation(location);
  for (const fld of organizeFields) if (fieldVals[fld.id]) rememberField(fld.id, fieldVals[fld.id]);
  clearSelection();                 // applied → untick so you can move on
  refreshNames();
  flushDraftSave();                 // persist this batch immediately — survives a crash
  scheduleReflectFromNaming(indices); // learn from the ones the AI has already seen
}

// When some of the selected clips disagree on a field, ask which value to carry
// into the batch (or leave it blank to keep each clip's own). Calls back with the
// resolved prefill once the user continues.
function resolveBatchConflicts(conflicts, prefillBase, cb) {
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card ai-memedit" style="width:min(500px,92vw)">
    <div class="illo mob-illo">${ILLO_MERGE}</div>
    <div class="ai-hd" style="margin-top:2px"><div class="ai-hd-text"><h3>These clips were named differently</h3><p class="muted small">Some selected clips already have different values. Pick what to carry into the batch — or leave a field blank to keep each clip’s own.</p></div></div>
    <div class="bcf-rows"></div>
    <div class="modal-actions"><button type="button" class="btn primary bcf-ok">Continue</button><button type="button" class="btn bcf-cancel">Cancel</button></div>
  </div>`;
  document.body.appendChild(ov);
  const rows = ov.querySelector('.bcf-rows');
  const selectors = {};
  for (const cf of conflicts) {
    const distinct = [...cf.counts.entries()].sort((a, b) => b[1] - a[1]);   // most common first
    const row = document.createElement('div'); row.className = 'bcf-row';
    const lab = document.createElement('label'); lab.className = 'pref-label'; lab.textContent = cf.label;
    const sel = createSelect({ className: 'bcf-select', value: distinct[0][0], style: 'width:100%' });
    sel.setOptions([
      ...distinct.map(([v, cnt]) => ({ value: v, label: `${v.length > 52 ? v.slice(0, 52) + '…' : v}  ·  ${cnt}×` })),
      { value: '', label: 'Leave blank — keep each clip’s own' }
    ]);
    selectors[cf.key] = sel;
    row.appendChild(lab); row.appendChild(sel.el); rows.appendChild(row);
  }
  const close = () => ov.remove();
  const cont = () => { const out = { ...prefillBase }; for (const cf of conflicts) out[cf.key] = selectors[cf.key].value; close(); cb(out); };
  ov.querySelector('.bcf-cancel').addEventListener('click', close);
  ov.querySelector('.bcf-ok').addEventListener('click', cont);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && !openPopover) { e.preventDefault(); cont(); }
  });
}

// Batch naming dialog (hotkey: Name selected as a batch). Names the ticked clips
// at once AND captures a free-text "what are you doing" CONTEXT that's fed to the
// AI when it analyses them — so it knows e.g. "calisthenics" before guessing.
// Re-opening with the same clips PREFILLS their shared values; differing values
// are resolved first via resolveBatchConflicts.
function showBatchDialog() {
  const sel = selectedClips();
  if (!sel.length) { showToast('Tick the clips for this batch first'); return; }
  const FIELDS = [['subject', 'Subject'], ['description', 'Description'], ['location', 'Location'], ['context', 'Context']];
  const prefill = {}; const conflicts = [];
  for (const [key, label] of FIELDS) {
    const counts = new Map();
    for (const c of sel) { const v = (c[key] || '').trim(); if (v) counts.set(v, (counts.get(v) || 0) + 1); }
    const distinct = [...counts.keys()];
    if (distinct.length === 1) prefill[key] = distinct[0];   // one shared value → prefill it
    else { prefill[key] = ''; if (distinct.length >= 2) conflicts.push({ key, label, counts }); }
  }
  if (conflicts.length) { resolveBatchConflicts(conflicts, prefill, (resolved) => buildBatchDialog(sel, resolved)); return; }
  buildBatchDialog(sel, prefill);
}
function buildBatchDialog(sel, prefill = {}) {
  const n = sel.length;
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card ai-memedit">
    <div class="ai-hd"><span class="ai-hd-icon">✨</span><div class="ai-hd-text"><h3>Name batch · ${n} clip${n !== 1 ? 's' : ''}</h3><p class="muted small">Set a shared name and tell the AI what this footage is. Empty fields are left untouched.</p></div></div>
    <div class="bd-grid">
      <label class="pref-label">Subject</label><input type="text" class="ai-input bd-subject" placeholder="e.g. calisthenics" autocomplete="off" />
      <label class="pref-label">Description</label><input type="text" class="ai-input bd-desc" placeholder="e.g. park-workout" autocomplete="off" />
      <label class="pref-label">Location <span class="muted small">(optional)</span></label><input type="text" class="ai-input bd-location" placeholder="e.g. dusty" autocomplete="off" />
    </div>
    <label class="pref-label" style="margin-top:12px">What are you doing? <span class="muted small">(context for the AI — not part of the name)</span></label>
    <textarea class="ai-textarea bd-context" rows="3" placeholder="e.g. Filming Liam's calisthenics session at the park — pull-ups, muscle-ups, some pieces to camera."></textarea>
    <div class="modal-actions">
      <button type="button" class="btn primary bd-apply">Apply to ${n}</button>
      <button type="button" class="btn bd-cancel">Cancel</button>
    </div></div>`;
  document.body.appendChild(ov);
  const q = (s) => ov.querySelector(s);
  const close = () => ov.remove();
  attachCombo(q('.bd-subject'), subjectSuggestions, () => q('.bd-desc'));
  attachCombo(q('.bd-desc'), descriptionSuggestions, () => q('.bd-location'));
  attachCombo(q('.bd-location'), locationSuggestions, () => q('.bd-context'));
  // Prefill the clips' existing shared values (so re-opening shows what's there).
  q('.bd-subject').value = prefill.subject || '';
  q('.bd-desc').value = prefill.description || '';
  q('.bd-location').value = prefill.location || '';
  q('.bd-context').value = prefill.context || '';
  q('.bd-cancel').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  setTimeout(() => { const s = q('.bd-subject'); s.focus(); s.select(); }, 30);
  // Enter applies; Shift+Enter inserts a newline (so the context note can be
  // multi-line). Esc cancels from anywhere in the dialog.
  ov.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Enter' || e.shiftKey) return;
    // Don't steal Enter from an autocomplete the user is ARROW-navigating — let it
    // accept the highlighted suggestion. Otherwise Enter applies the batch.
    if (openPopover && openPopover._comboInput && openPopover._navigated) return;
    e.preventDefault();
    doApply();
  });
  const doApply = () => {
    const subject = slug(q('.bd-subject').value);
    const description = slug(q('.bd-desc').value);
    const location = slug(q('.bd-location').value);
    const context = q('.bd-context').value.trim();
    const indices = [];
    state.scannedFiles.forEach((clip, i) => {
      if (!clip.selected) return;
      if (subject) clip.subject = subject;
      if (description) clip.description = description;
      if (location) clip.location = location;
      if (context) clip.context = context;   // fed to the AI, persisted, not in the filename
      indices.push(i);
    });
    syncRowInputs(indices);
    if (subject) rememberSubject(subject);
    if (description) rememberDescription(description);
    if (location) rememberLocation(location);
    refreshNames();
    flushDraftSave();   // save the batch + AI context note right away
    scheduleReflectFromNaming(indices); // grow memory from clips the AI has seen + your context
    close();
    showToast(`Batch applied to ${indices.length}${context ? ' · context saved for AI' : ''}`);
  };
  q('.bd-apply').addEventListener('click', doApply);
}

// Quick "tag location on selected" popup (hotkey) — works even when the Location
// field is hidden in the grid.
function showLocationTagPopup() {
  const sel = selectedClips();
  if (!sel.length) { showToast('Tick the clips to tag first'); return; }
  const n = sel.length;
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card ai-memedit" style="width:min(420px,92vw)">
    <div class="ai-hd"><span class="ai-hd-icon">📍</span><div class="ai-hd-text"><h3>Tag location · ${n} clip${n !== 1 ? 's' : ''}</h3><p class="muted small">A remembered name (lawn/client) written to the clip metadata.</p></div></div>
    <input type="text" class="ai-input lt-location" placeholder="e.g. dusty" autocomplete="off" style="width:100%;box-sizing:border-box" />
    <div class="modal-actions">
      <button type="button" class="btn primary lt-apply">Apply to ${n}</button>
      <button type="button" class="btn lt-cancel">Cancel</button>
    </div></div>`;
  document.body.appendChild(ov);
  const q = (s) => ov.querySelector(s);
  const close = () => ov.remove();
  const inp = q('.lt-location');
  attachCombo(inp, () => locationsCache, () => { apply(); return null; });
  q('.lt-cancel').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  setTimeout(() => inp.focus(), 30);
  function apply() {
    const location = slug(inp.value);
    if (!location) { close(); return; }
    const indices = [];
    state.scannedFiles.forEach((clip, i) => { if (clip.selected) { clip.location = location; indices.push(i); } });
    syncRowInputs(indices);
    rememberLocation(location);
    scheduleDraftSave();
    refreshNames();
    close();
    showToast(`Tagged ${indices.length} with “${location}”`);
  }
  q('.lt-apply').addEventListener('click', apply);
}

// Clear all selection (state + checkboxes + row highlight + batch fields).
function clearSelection() {
  state.scannedFiles.forEach((c) => { c.selected = false; });
  document.querySelectorAll('[data-check]').forEach((cb) => { cb.checked = false; });
  document.querySelectorAll('.rename-card.selected').forEach((card) => card.classList.remove('selected'));
  $('batchSubject').value = '';
  $('batchDesc').value = '';
  if ($('batchLocation')) $('batchLocation').value = '';
  document.querySelectorAll('#batchMetaFields [data-field]').forEach((inp) => { inp.value = ''; });
  setDateField($('batchDate'), '');
  updateBatchBar();
}

// Build the command-bar organizing-field inputs (dynamic — mirrors the per-clip
// meta row). Called on init and whenever the field set changes.
function buildCommandBarFields() {
  const wrap = $('batchMetaFields');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const fld of organizeFields) {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'f-meta';
    inp.dataset.field = fld.id;
    inp.placeholder = fld.label.toLowerCase();
    inp.autocomplete = 'off';
    inp.addEventListener('change', () => rememberField(fld.id, inp.value));
    wrap.appendChild(inp);
    attachFieldCombo(inp, fld.id);
  }
}

// Mirror of rememberSubject: persist the description AND refresh the in-session
// suggestion cache so it autocompletes on the very next clip (the missing cache
// refresh here is why a description typed once never suggested itself again).
async function rememberDescription(value) {
  const v = (value || '').trim();
  if (!v) return;
  if (!descriptionsCache.includes(v)) descriptionsCache = [v, ...descriptionsCache]; // instant
  await window.api.addDescription(v);
  await refreshDescriptionOptions();
}

$('applyBatch').addEventListener('click', applyBatch);
$('batchSubject').addEventListener('input', updateBatchBar);
$('batchDesc').addEventListener('input', updateBatchBar);
$('batchSubject').addEventListener('change', () => rememberSubject($('batchSubject').value));
$('batchDesc').addEventListener('change', () => rememberDescription($('batchDesc').value));
attachSubjectCombo($('batchSubject'));
attachDescriptionCombo($('batchDesc'));
if ($('batchLocation')) {
  $('batchLocation').addEventListener('change', () => rememberLocation($('batchLocation').value));
  attachCombo($('batchLocation'), () => locationsCache, () => $('applyBatch'));
}
// The command-bar organizing-field inputs are built dynamically (buildCommandBarFields).
$('selectAllClips').addEventListener('change', (e) => {
  const on = e.target.checked;
  // "Select all" means all the clips you can SEE. It used to tick every clip in state.scannedFiles
  // regardless of the active filter — so filtering to "Unnamed", hitting select-all and applying a
  // subject silently overwrote every NAMED clip too: the ones deliberately hidden, that were
  // already finished. A bulk edit must never reach a clip the user cannot see.
  const scoped = clipFilterActive();
  state.scannedFiles.forEach((c) => {
    if (scoped && !clipMatchesFilter(c)) return;   // hidden → untouched, ticked or not
    c.selected = on;
  });
  // Reflect it only on the rows that are actually on screen.
  document.querySelectorAll('.rename-card').forEach((card) => {
    const c = state.scannedFiles[Number(card.dataset.i)];
    if (scoped && !clipMatchesFilter(c)) return;
    card.classList.toggle('selected', on);
    const cb = card.querySelector('[data-check]');
    if (cb) cb.checked = on;
  });
  if (scoped && on) showToast(`Selected the ${state.scannedFiles.filter(clipMatchesFilter).length} clip(s) matching the current filter — the rest are untouched.`, 3500);
  updateBatchBar();
});

// Preview playback speed: applies live to every in-thumbnail <video>, persisted
// as the default. The control now lives in the View menu (opened as a flyout).
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];
let currentSpeed = 1;
function applySpeedToAllVideos() {
  document.querySelectorAll('.clip-video').forEach((v) => { v.playbackRate = currentSpeed; });
}
function setSpeed(s) {
  currentSpeed = Number(s) || 1;
  applySpeedToAllVideos();
  refreshPreview();
  window.api.setSpeed(currentSpeed);
}
function openSpeedFlyout(anchor) {
  const menu = document.createElement('div');
  menu.className = 'flyout dropdown-menu';
  for (const s of SPEED_OPTIONS) {
    const item = document.createElement('button');
    item.className = 'flyout-item' + (s === currentSpeed ? ' selected' : '');
    item.innerHTML = `<span>${s}×</span>`;
    item.addEventListener('click', () => { setSpeed(s); closePopover(); });
    menu.appendChild(item);
  }
  showPopover(anchor, menu);
}

// Reusable Fluent dropdown that replaces native <select> (whose OS popup renders
// white on Windows and ignores the dark theme). Returns a small controller with
// .el (the button), .setOptions([{value,label}]), .value get/set, .onChange(cb).
function createSelect(opts = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `ai-dropdown ${opts.className || ''}`.trim();
  if (opts.style) btn.setAttribute('style', opts.style);
  btn.innerHTML = '<span class="ai-dropdown-text"></span><span class="ai-dropdown-caret"></span>';
  const textEl = btn.querySelector('.ai-dropdown-text');
  let options = [];
  let value = opts.value || '';
  let onChange = null;
  const render = () => { const o = options.find((x) => x.value === value); textEl.textContent = o ? o.label : (value || (opts.placeholder || '—')); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openPopover) { closePopover(); return; }
    const menu = document.createElement('div');
    menu.className = 'flyout dropdown-menu';
    if (!options.length) {
      const d = document.createElement('div'); d.className = 'flyout-item disabled'; d.textContent = opts.empty || '(none)'; menu.appendChild(d);
    }
    for (const o of options) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'flyout-item' + (o.value === value ? ' selected' : '');
      item.innerHTML = `<span class="flyout-label">${escapeHtml(o.label)}</span>`;
      item.addEventListener('click', () => { value = o.value; render(); closePopover(); if (onChange) onChange(value); });
      menu.appendChild(item);
    }
    showPopover(btn, menu, { matchWidth: true });
  });
  render();
  return {
    el: btn,
    setOptions(list) { options = list || []; render(); },
    get value() { return value; },
    set value(v) { value = v; render(); },
    onChange(cb) { onChange = cb; }
  };
}

// ---------------------------------------------------------------------------
// Ctrl + wheel → zoom the preview thumbnails on the rename screen (live, saved)
// ---------------------------------------------------------------------------
let previewWidth = 248;
const PREVIEW_MIN = 32;            // can shrink down to a thin line + tiny thumbnail
const PREVIEW_MAX = 460;
function applyPreviewWidth(px) {
  previewWidth = Math.max(PREVIEW_MIN, Math.min(PREVIEW_MAX, Math.round(px)));
  const root = document.documentElement;
  root.style.setProperty('--preview-w', `${previewWidth}px`);
  // Graduated density: below these widths the cards collapse toward a single
  // thin row (hide the result pill, then the source filename, etc.).
  root.classList.toggle('ui-zoom-compact', previewWidth <= 180);
  root.classList.toggle('ui-zoom-tiny', previewWidth <= 96);
}
let zoomPersistTimer = null;
function persistZoom() {
  clearTimeout(zoomPersistTimer);
  zoomPersistTimer = setTimeout(() => window.api.setPrefs({ previewWidth }), 400);
}
let zoomToastEl = null;
let zoomToastTimer = null;
function showZoomToast() {
  if (!zoomToastEl) {
    zoomToastEl = document.createElement('div');
    zoomToastEl.className = 'zoom-toast';
    document.body.appendChild(zoomToastEl);
  }
  const pct = Math.round(((previewWidth - PREVIEW_MIN) / (PREVIEW_MAX - PREVIEW_MIN)) * 100);
  zoomToastEl.textContent = `Thumbnail size · ${pct}%`;
  zoomToastEl.classList.add('show');
  clearTimeout(zoomToastTimer);
  zoomToastTimer = setTimeout(() => zoomToastEl.classList.remove('show'), 900);
}
// Ctrl + wheel → zoom the PHONE backup grid's thumbnails (mirrors the rename grid).
let phThumb = 150;
const PH_THUMB_MIN = 96;
const PH_THUMB_MAX = 340;
function applyPhThumb(px) {
  phThumb = Math.max(PH_THUMB_MIN, Math.min(PH_THUMB_MAX, Math.round(px)));
  document.documentElement.style.setProperty('--ph-thumb', `${phThumb}px`);
}
let phZoomPersist = null;
function persistPhZoom() { clearTimeout(phZoomPersist); phZoomPersist = setTimeout(() => window.api.setPrefs({ phoneThumb: phThumb }), 400); }
function showPhZoomToast() {
  if (!zoomToastEl) { zoomToastEl = document.createElement('div'); zoomToastEl.className = 'zoom-toast'; document.body.appendChild(zoomToastEl); }
  const pct = Math.round(((phThumb - PH_THUMB_MIN) / (PH_THUMB_MAX - PH_THUMB_MIN)) * 100);
  zoomToastEl.textContent = `Thumbnail size · ${pct}%`;
  zoomToastEl.classList.add('show');
  clearTimeout(zoomToastTimer); zoomToastTimer = setTimeout(() => zoomToastEl.classList.remove('show'), 900);
}
// Only zoom while the rename step (or phone backup grid) is showing; also blocks the
// browser's own Ctrl+wheel page zoom there.
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  if (!$('step1').classList.contains('hidden')) {
    e.preventDefault();
    applyPreviewWidth(previewWidth + (e.deltaY < 0 ? 26 : -26));
    showZoomToast();
    persistZoom();
  } else if (!$('phone').classList.contains('hidden')) {
    e.preventDefault();
    applyPhThumb(phThumb + (e.deltaY < 0 ? 18 : -18));
    showPhZoomToast();
    persistPhZoom();
  }
}, { passive: false });

// ---------------------------------------------------------------------------
// Rename progress + "jump to next unnamed"
// ---------------------------------------------------------------------------
function updateProgress() {
  const total = state.scannedFiles.length;
  const wrap = $('renameProgress');
  if (!wrap) return;
  if (!total) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  const named = state.scannedFiles.filter(isRenamed).length;
  const left = total - named;
  const status = $('rpStatus');
  status.textContent = left === 0 ? `All ${total} named ✓` : `${named} of ${total} named · ${left} left`;
  status.classList.toggle('done', left === 0);
  $('rpFill').style.width = `${(named / total) * 100}%`;
  $('rpJumpBtn').disabled = left === 0;
}

function focusClip(i) {
  // Windowed grid: the target may not be rendered yet — build chunks up to it first.
  try { if (typeof renameEnsureRendered === 'function') renameEnsureRendered(i); } catch { /* ignore */ }
  const card = document.querySelector(`.rename-card[data-i="${i}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const subj = card.querySelector('.f-subject');
  if (subj) setTimeout(() => subj.focus(), 160);
}

// Jump to the next clip with no name, starting after the focused one (wraps).
function jumpNextUnnamed() {
  const total = state.scannedFiles.length;
  if (!total) return;
  let start = 0;
  const card = document.activeElement && document.activeElement.closest && document.activeElement.closest('.rename-card');
  if (card) start = Number(card.dataset.i) + 1;
  for (let off = 0; off < total; off += 1) {
    const i = (start + off) % total;
    if (!isRenamed(state.scannedFiles[i])) { focusClip(i); return; }
  }
}

// ---------------------------------------------------------------------------
// Checked-clips thumbnail strip (under the command bar)
// ---------------------------------------------------------------------------
function setClipSelected(i, on) {
  state.scannedFiles[i].selected = on;
  const cb = document.querySelector(`[data-check="${i}"]`);
  if (cb) cb.checked = on;
  const card = cb && cb.closest('.rename-card');
  if (card) card.classList.toggle('selected', on);
  updateBatchBar();
}

function renderCheckedStrip() {
  const wrap = $('checkedStrip');
  const row = $('checkedStripRow');
  if (!wrap || !row) return;
  const sel = [];
  state.scannedFiles.forEach((c, i) => { if (c.selected) sel.push(i); });
  if (!sel.length) { wrap.classList.add('hidden'); row.innerHTML = ''; row._stripKey = ''; return; }
  // Only rebuild when the SELECTION changed — this runs on every keystroke (via
  // updateBatchBar→refreshNames); rebuilding 60+ thumbnails per key was the lag.
  const key = sel.join(',');
  if (row._stripKey === key) { wrap.classList.remove('hidden'); return; }
  row._stripKey = key;
  wrap.classList.remove('hidden');
  row.innerHTML = '';
  const STRIP_CAP = 60;   // never render thousands of thumbs (that froze the app)
  const shown = sel.slice(0, STRIP_CAP);
  for (const i of shown) {
    const clip = state.scannedFiles[i];
    const t = document.createElement('button');
    t.className = 'cs-thumb';
    t.title = clip.name;
    t.innerHTML = (clip.posterUrl
      ? `<img src="${escapeAttr(clip.posterUrl)}" alt="" />`
      : `<span class="cs-ph">${escapeHtml(String(i + 1))}</span>`)
      + '<span class="cs-x" title="Unselect">✕</span>';
    t.addEventListener('click', (e) => {
      if (e.target.classList.contains('cs-x')) { setClipSelected(i, false); return; }
      focusClip(i);
    });
    row.appendChild(t);
    if (!clip.posterUrl) {
      window.api.getPoster(clip.sourcePath).then((url) => {
        if (!url) return;
        clip.posterUrl = url;
        const ph = t.querySelector('.cs-ph');
        if (ph) { const im = document.createElement('img'); im.src = url; ph.replaceWith(im); }
      });
    }
  }
  if (sel.length > STRIP_CAP) {
    const more = document.createElement('span');
    more.className = 'cs-more muted small';
    more.textContent = `+${sel.length - STRIP_CAP} more selected · use “Clear” to unselect all`;
    row.appendChild(more);
  }
}

$('rpJumpBtn').addEventListener('click', jumpNextUnnamed);
$('checkedClearBtn').addEventListener('click', clearSelection);

// ---------------------------------------------------------------------------
// Pop-out preview window — two modes:
//   • mirror: shows the single clip you're working on (video or photo)
//   • grid:   a wall of every clip in scope (selected / all / unnamed) — handy on
//             a second monitor while you rename on the main one; click a tile to jump.
// The window owns its own toolbar; main persists the view config and hands it back
// here (previewGridState) so we know which clips to push for the grid.
// ---------------------------------------------------------------------------
let previewOpen = false;
let lastPreviewIndex = null;
let previewGridState = { mode: 'mirror', source: 'selected', tile: 200, playVideos: false, muted: true };
function isClipNamed(c) { return !!(c && (c.subject || c.description)); }
function maybePreview(i) {
  lastPreviewIndex = i;
  if (!previewOpen || previewGridState.mode === 'grid') return;
  const clip = state.scannedFiles[i];
  // Mirror the in-card preview: muted unless "Play audio on hover" is on, same speed.
  if (clip) {
    window.api.previewSet(clip.sourcePath, clip.name, {
      kind: isPhotoClip(clip) ? 'photo' : 'video',
      muted: !uiPrefs.autoplayAudio,
      speed: currentSpeed
    });
  }
}
// Re-push the current clip when the mute/speed settings change.
function refreshPreview() { if (previewOpen && lastPreviewIndex != null) maybePreview(lastPreviewIndex); }
// Build + send the clip list for the grid wall (debounced — selection/naming can
// change in bursts). Only clips with a local file are shown.
let pushGridTimer = null;
function pushPreviewGrid() {
  if (!previewOpen || previewGridState.mode !== 'grid') return;
  clearTimeout(pushGridTimer);
  pushGridTimer = setTimeout(() => {
    const src = previewGridState.source;
    const clips = [];
    (state.scannedFiles || []).forEach((c, i) => {
      if (!c || !c.sourcePath) return;
      if (src === 'selected' && !c.selected) return;
      if (src === 'unnamed' && isClipNamed(c)) return;
      clips.push({ i, path: c.sourcePath, name: c.name || '', kind: isPhotoClip(c) ? 'photo' : 'video', named: isClipNamed(c) });
    });
    window.api.previewList(clips);
  }, 80);
}
// Something in the clip list changed (selection ticked, a name applied, a rescan) —
// keep the grid wall in sync if it's showing.
function refreshPreviewGrid() { pushPreviewGrid(); }
async function togglePreviewWindow() {
  const r = await window.api.togglePreview();
  previewOpen = !!(r && r.open);
  if (r && r.config) previewGridState = { ...previewGridState, ...r.config };
  if (previewOpen) {
    if (previewGridState.mode === 'grid') { pushPreviewGrid(); return; }
    const card = document.activeElement && document.activeElement.closest
      && document.activeElement.closest('.rename-card');
    if (card) maybePreview(Number(card.dataset.i));
    else if (state.scannedFiles.length) maybePreview(0);
  }
}
// Focus + scroll to a clip when its grid tile is clicked in the preview window.
function focusClipFromPreview(i) {
  // The pop-out grid wall pushes EVERY in-scope clip, but the rename list only renders 100 cards at
  // a time. Clicking a tile for clip #250 on the second monitor therefore found no card and silently
  // gave up — no jump, no feedback, nothing. focusClip() has always called this for exactly this
  // reason; this path just never did.
  try { if (typeof renameEnsureRendered === 'function') renameEnsureRendered(i); } catch { /* ignore */ }
  const card = document.querySelector(`.rename-card[data-i="${i}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const subj = card.querySelector('.f-subject');
  if (subj) { try { subj.focus(); } catch { /* ignore */ } }
  card.classList.add('analyzing');
  setTimeout(() => card.classList.remove('analyzing'), 1200);
}
window.api.onPreviewClosed(() => { previewOpen = false; });
window.api.onPreviewJump((i) => focusClipFromPreview(Number(i)));
// Main re-broadcasts the view config whenever it changes (mode toggle, tile size,
// source dropdown). React: repaint the grid if we just entered/updated grid mode.
window.api.onPreviewConfig((c) => {
  if (!c) return;
  const wasGrid = previewGridState.mode === 'grid';
  previewGridState = { ...previewGridState, ...c };
  if (previewGridState.mode === 'grid') pushPreviewGrid();
  else if (wasGrid && lastPreviewIndex != null) maybePreview(lastPreviewIndex);
});
window.api.previewState().then((s) => {
  previewOpen = !!(s && s.open);
  if (s && s.config) previewGridState = { ...previewGridState, ...s.config };
});

// ---------------------------------------------------------------------------
// Configurable in-app hotkeys (rename screen)
// ---------------------------------------------------------------------------
const HOTKEY_ACTIONS = [
  { id: 'jumpUnnamed', label: 'Jump to next unnamed clip', desc: 'Scrolls to the next clip with no name and focuses its subject', run: jumpNextUnnamed },
  { id: 'batchName', label: 'Name selected as a batch', desc: 'Opens a dialog to name the ticked clips at once and tell the AI what they are', run: () => showBatchDialog() },
  { id: 'tagLocation', label: 'Tag location on selected', desc: 'Sets a remembered location (e.g. a lawn/client) on the ticked clips', run: () => showLocationTagPopup() },
  { id: 'selectBetween', label: 'Select all clips in between', desc: 'Selects every clip between the first and last ticked one (or just Shift-click a clip)', run: selectBetweenSelected },
  { id: 'captureMacro', label: 'Capture quick text shortcut', desc: 'Grabs the current field text, then press a trigger key to bind it for this session', run: captureQuickMacro }
];
const DEFAULT_HOTKEYS = { jumpUnnamed: 'F2', batchName: 'Ctrl+B', tagLocation: 'Ctrl+L', selectBetween: 'Ctrl+Shift+A', captureMacro: 'Ctrl+Shift+S' };
let hotkeys = { ...DEFAULT_HOTKEYS };
// User-defined text shortcuts: [{ key: 'Ctrl+1', text: 'josiah' }, …]
let textMacros = [];
// Session-only text shortcuts: { 'Ctrl+1': 'josiah-cleanroom', … } — not saved.
const tempMacros = {};

// Lightweight transient toast (bottom-center).
// Fire a native PC notification (honors the user's toggle in main). Use for things
// that finish in the background so you get pulled back even from another window.
function pcNotify(title, body) { try { window.api.notify({ title, body }); } catch { /* ignore */ } }
let appToastEl = null;
let appToastTimer = null;
function showToast(msg, ms = 1800) {
  if (!appToastEl) {
    appToastEl = document.createElement('div');
    appToastEl.className = 'zoom-toast app-toast';
    document.body.appendChild(appToastEl);
  }
  appToastEl.textContent = msg;
  appToastEl.classList.add('show');
  clearTimeout(appToastTimer);
  appToastTimer = setTimeout(() => appToastEl.classList.remove('show'), ms);
}

// A toast that can be ACTED on. An "undo" the user has to go hunting for in a menu is not an
// offer — it has to be here, at the moment they'd want it, on the thing that just happened.
function showToastAction(msg, actionLabel, onAction, ms = 8000) {
  if (!appToastEl) {
    appToastEl = document.createElement('div');
    appToastEl.className = 'zoom-toast app-toast';
    document.body.appendChild(appToastEl);
  }
  appToastEl.textContent = '';
  const tx = document.createElement('span');
  tx.textContent = msg;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'toast-action';
  btn.textContent = actionLabel;
  btn.addEventListener('click', () => {
    clearTimeout(appToastTimer);
    appToastEl.classList.remove('show');
    try { onAction(); } catch { /* the action owns its own errors */ }
  });
  appToastEl.append(tx, btn);
  appToastEl.classList.add('show');
  clearTimeout(appToastTimer);
  appToastTimer = setTimeout(() => { appToastEl.classList.remove('show'); appToastEl.textContent = ''; }, ms);
}

// What (if anything) already uses this key — for rejecting clashing bindings.
// (A previous SESSION shortcut may be overwritten, so it's not counted here.)
function shortcutTakenBy(key) {
  const act = HOTKEY_ACTIONS.find((a) => hotkeys[a.id] === key);
  if (act) return `the “${act.label}” shortcut`;
  if (textMacros.some((m) => m.key === key)) return 'a saved text shortcut';
  return null;
}

// Capture hotkey action: open a dialog pre-filled with the current field's text,
// where you can edit the text + pick the key before the session shortcut is set.
function captureQuickMacro() {
  const el = document.activeElement;
  const initial = (isTypingTarget(el) && el.value) ? el.value : '';
  showTempShortcutDialog(initial);
}

// Review/edit popup for a session-only text shortcut.
function showTempShortcutDialog(initialText) {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card modal-form">
    <h3>New session shortcut</h3>
    <p class="muted small">Temporary — cleared when the app closes.</p>
    <label class="pref-label">Shortcut key</label>
    <div class="ts-keyrow">
      <button type="button" class="hk-key ts-key"><span class="kc-empty">Click, then press keys</span></button>
      <span class="ts-err small"></span>
    </div>
    <label class="pref-label" style="margin-top:12px">Text to insert</label>
    <input type="text" class="tm-text ts-text" placeholder="text to insert" />
    <div class="modal-actions">
      <button type="button" class="btn primary ts-save" disabled>Set shortcut</button>
      <button type="button" class="btn ts-cancel">Cancel</button>
    </div></div>`;
  document.body.appendChild(ov);
  const keyBtn = ov.querySelector('.ts-key');
  const textInput = ov.querySelector('.ts-text');
  const errEl = ov.querySelector('.ts-err');
  const saveBtn = ov.querySelector('.ts-save');
  textInput.value = initialText || '';

  let chosenKey = '';
  let listening = false;

  const validate = () => {
    if (!chosenKey) return '';
    if (!(/Ctrl|Alt|^F\d/.test(chosenKey) || chosenKey.includes('+'))) return 'Use a Ctrl/Alt combo or a function key — not a single key';
    const taken = shortcutTakenBy(chosenKey);
    if (taken) return `Already used by ${taken}`;
    return '';
  };
  const refresh = () => {
    keyBtn.innerHTML = listening
      ? '<span class="kc-listening">Press keys…</span>'
      : (chosenKey ? keycapsHtml(chosenKey) : '<span class="kc-empty">Click, then press keys</span>');
    keyBtn.classList.toggle('listening', listening);
    const err = validate();
    errEl.textContent = err;
    saveBtn.disabled = !(chosenKey && !err && textInput.value.trim());
  };

  keyBtn.addEventListener('click', () => { listening = true; refresh(); });
  textInput.addEventListener('input', refresh);

  function onKeydown(e) {
    if (!listening) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { listening = false; refresh(); return; }
    const key = eventToHotkey(e);
    if (!key) return;
    chosenKey = key; listening = false; refresh();
  }
  document.addEventListener('keydown', onKeydown, true);

  const close = () => { document.removeEventListener('keydown', onKeydown, true); ov.remove(); };
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('.ts-cancel').addEventListener('click', close);
  saveBtn.addEventListener('click', () => {
    if (validate() || !chosenKey || !textInput.value.trim()) return;
    tempMacros[chosenKey] = textInput.value;
    showToast(`${chosenKey.replace(/\+/g, ' + ')}  →  “${textInput.value}”  ·  this session`);
    close();
  });

  refresh();
  textInput.focus(); textInput.select();
}

// Insert text at the cursor of a focused text input (replacing any selection),
// preserving native undo + firing 'input' so the clip's state updates.
function insertTextAtCursor(el, text) {
  if (!el || !text) return;
  el.focus();
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch { /* fall through */ }
  if (!ok) {
    const start = el.selectionStart != null ? el.selectionStart : el.value.length;
    const end = el.selectionEnd != null ? el.selectionEnd : el.value.length;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    const pos = start + text.length;
    try { el.setSelectionRange(pos, pos); } catch { /* ignore */ }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// Render a binding string ("Ctrl+0") as DaVinci-style keycap chips.
function keycapsHtml(binding) {
  if (!binding) return '<span class="kc-empty">Click to set</span>';
  return binding.split('+')
    .map((k) => `<kbd class="kc">${escapeHtml(k)}</kbd>`)
    .join('<span class="kc-sep">+</span>');
}

// Normalise a keydown into a binding string like "Ctrl+Shift+J" or "F2".
function eventToHotkey(e) {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join('+');
}
function isTypingTarget(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}
document.addEventListener('keydown', (e) => {
  if ($('step1').classList.contains('hidden')) return;
  const key = eventToHotkey(e);
  if (!key) return;
  const safeWhileTyping = /Ctrl|Alt|^F\d/.test(key) || key.includes('+');

  // Text shortcuts (session temp first, then saved): insert text into the field.
  // Only modifier/function combos fire so a bare key never hijacks normal typing.
  if (isTypingTarget(e.target) && safeWhileTyping) {
    const saved = textMacros.find((m) => m.key === key && m.text);
    const text = tempMacros[key] || (saved ? saved.text : null);
    if (text) { e.preventDefault(); insertTextAtCursor(e.target, text); return; }
  }

  // Action hotkeys (e.g. jump to next unnamed, capture quick shortcut)
  const action = HOTKEY_ACTIONS.find((a) => hotkeys[a.id] && hotkeys[a.id] === key);
  if (!action) return;
  if (isTypingTarget(e.target) && !safeWhileTyping) return;
  e.preventDefault();
  action.run();
});

// ---------------------------------------------------------------------------
// Flyout / popover infrastructure (shared by menus, the dropdown, the calendar)
// ---------------------------------------------------------------------------
let openPopover = null;
function onPopoverDocDown(e) {
  // Clicks inside a body-level submenu count as "inside" the popover.
  if (e.target.closest && e.target.closest('.submenu')) return;
  if (openPopover && !openPopover.contains(e.target) &&
      (!openPopover._anchor || !openPopover._anchor.contains(e.target))) {
    closePopover();
  }
}
function onPopoverKey(e) { if (e.key === 'Escape') closePopover(); }
function closePopover() {
  if (!openPopover) return;
  openPopover.remove();
  openPopover = null;
  document.querySelectorAll('.submenu').forEach((s) => s.remove()); // body-level submenus
  document.querySelectorAll('.menu-trigger.active').forEach((t) => t.classList.remove('active'));
  document.removeEventListener('mousedown', onPopoverDocDown, true);
  document.removeEventListener('keydown', onPopoverKey, true);
}
function showPopover(anchor, el, opts = {}) {
  closePopover();
  el._anchor = anchor;
  el.style.position = 'fixed';
  el.style.visibility = 'hidden';
  document.body.appendChild(el);
  const a = anchor.getBoundingClientRect();
  if (opts.matchWidth) el.style.minWidth = `${a.width}px`;
  const r = el.getBoundingClientRect();
  let left = opts.alignRight ? a.right - r.width : a.left;
  let top = a.bottom + 4;
  if (top + r.height > window.innerHeight - 8) top = a.top - r.height - 4;
  left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));
  if (top < 8) top = 8;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.visibility = 'visible';
  openPopover = el;
  setTimeout(() => {
    document.addEventListener('mousedown', onPopoverDocDown, true);
    document.addEventListener('keydown', onPopoverKey, true);
  }, 0);
}

