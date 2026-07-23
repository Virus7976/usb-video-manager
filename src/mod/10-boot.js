// ---------------------------------------------------------------------------
const COMPRESS_PRESET_INFO = {
  balanced: { label: 'Balanced', sub: '1080p · H.264 · great for editing & sharing' },
  smaller:  { label: 'Smallest', sub: '1080p · H.265 (HEVC) · smallest files' },
  hq:       { label: 'High quality', sub: 'Keep resolution · H.264 · archive-grade' },
};
let cmpState = { src: '', out: '', files: [], preset: 'balanced', running: false };
let cmpOff = null;
async function openCompress() {
  const d = await window.api.compressDefaults();
  cmpState = { src: d.intake || '', out: d.outDir || '', files: [], preset: cmpState.preset || 'balanced', mode: d.mode || 'external', running: false };
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card cmp-card">
    <div class="ai-hd"><span class="ai-hd-icon">${typeof ILLO_COMPRESS !== 'undefined' ? ILLO_COMPRESS : (typeof ILLO_MERGE !== 'undefined' ? ILLO_MERGE : '')}</span>
      <div class="ai-hd-text"><h3>Compress footage</h3><p class="muted small">Choose how your footage gets compressed before it's organized.</p></div></div>
    <div class="cmp-modes" id="cmpModes">
      <button type="button" class="cmp-mode" data-mode="external"><span class="cmp-mode-name">External tool (Tdarr / watch folder)</span><span class="cmp-mode-sub muted small">Your tool watches the folders and compresses on its OWN resources. The app won't touch this PC's CPU.</span></button>
      <button type="button" class="cmp-mode" data-mode="app"><span class="cmp-mode-name">This app (local ffmpeg)</span><span class="cmp-mode-sub muted small">The app compresses here, on this machine. Uses this PC's CPU while it runs.</span></button>
    </div>
    <div class="cmp-folders">
      <div class="cmp-folder"><span class="cmp-folder-lbl muted small">Uncompressed</span><span class="cmp-folder-path" id="cmpSrcPath"></span><button type="button" class="btn subtle cmp-pick" data-pick="src">Change…</button></div>
      <div class="cmp-folder"><span class="cmp-folder-lbl muted small">Compressed</span><span class="cmp-folder-path" id="cmpOutPath"></span><button type="button" class="btn subtle cmp-pick" data-pick="out">Change…</button></div>
    </div>
    <div id="cmpExternal" class="cmp-external hidden">
      <p class="cmp-ext-note">Your external compressor (e.g. <b>Tdarr</b>) watches the <b>Uncompressed</b> folder and writes finished clips into the <b>Compressed</b> folder — all on its own resources, so this app never uses this machine for encoding. Drop renamed clips into Uncompressed; when they appear in Compressed, organize them.</p>
      <div class="cmp-ext-actions">
        <button type="button" class="btn subtle" data-open="src">Open Uncompressed folder</button>
        <button type="button" class="btn subtle" data-open="out">Open Compressed folder</button>
      </div>
    </div>
    <div id="cmpAppBody" class="hidden">
      <div class="cmp-presets" id="cmpPresets">${Object.entries(COMPRESS_PRESET_INFO).map(([k, v]) => `<button type="button" class="cmp-preset${k === cmpState.preset ? ' on' : ''}" data-preset="${k}"><span class="cmp-preset-name">${v.label}</span><span class="cmp-preset-sub muted small">${v.sub}</span></button>`).join('')}</div>
      <label class="del-check cmp-skip"><input type="checkbox" id="cmpSkip" checked /><span class="del-box"></span><span>Skip clips already in the Compressed folder</span></label>
      <div class="cmp-listhd"><label class="cmp-selall"><input type="checkbox" id="cmpSelAll" checked /> <span id="cmpSelCount">Select all</span></label><span class="cmp-listmeta muted small" id="cmpListMeta"></span></div>
      <ul class="cmp-list" id="cmpList"><li class="muted small">Scanning…</li></ul>
    </div>
    <div class="modal-actions cmp-actions">
      <button type="button" class="btn primary cmp-run hidden" id="cmpRun" disabled>Compress</button>
      <button type="button" class="btn cmp-cancel hidden" id="cmpCancel">Cancel</button>
      <button type="button" class="btn ghost cmp-close" id="cmpClose">Close</button>
      <button type="button" class="btn primary cmp-organize hidden" id="cmpOrganize">Organize these →</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  function applyMode() {
    const ext = cmpState.mode !== 'app';
    ov.querySelectorAll('.cmp-mode').forEach((b) => b.classList.toggle('on', b.dataset.mode === cmpState.mode));
    ov.querySelector('#cmpExternal').classList.toggle('hidden', !ext);
    ov.querySelector('#cmpAppBody').classList.toggle('hidden', ext);
    const run = ov.querySelector('#cmpRun'); const org = ov.querySelector('#cmpOrganize');
    run.classList.toggle('hidden', ext);
    // In external mode there's nothing to run locally — Organize is the next step.
    if (ext) org.classList.remove('hidden'); else org.classList.add('hidden');
    if (!ext && !cmpState.files.length) rescan();
    if (!ext) updateRunBtn();
  }
  const close = () => { if (cmpState.running) { showToast('Compression is still running — cancel it first.'); return; } if (cmpOff) { cmpOff(); cmpOff = null; } ov.remove(); };
  const $$ = (id) => ov.querySelector(id);
  function paintFolders() { $$('#cmpSrcPath').textContent = cmpState.src || '— choose a folder —'; $$('#cmpOutPath').textContent = cmpState.out || '— choose a folder —'; }
  function renderList() {
    const ul = $$('#cmpList');
    if (!cmpState.files.length) { ul.innerHTML = '<li class="muted small">No video files found in this folder.</li>'; }
    else {
      ul.innerHTML = cmpState.files.map((f, i) => `<li class="cmp-row" data-i="${i}">
        <label class="cmp-rowsel"><input type="checkbox" class="cmp-cb" data-i="${i}" ${f._sel !== false ? 'checked' : ''} /></label>
        <span class="cmp-rowname" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
        <span class="cmp-rowsize muted small">${fmtBytes(f.size || 0)}</span>
        <span class="cmp-rowstat" data-stat="${i}"></span>
        <span class="cmp-rowbar"><span class="cmp-rowfill" data-fill="${i}"></span></span>
      </li>`).join('');
    }
    updateRunBtn();
  }
  function selected() { return cmpState.files.filter((f) => f._sel !== false); }
  function updateRunBtn() {
    const n = selected().length;
    const totalBytes = selected().reduce((s, f) => s + (f.size || 0), 0);
    $$('#cmpListMeta').textContent = cmpState.files.length ? `${cmpState.files.length} clip${cmpState.files.length !== 1 ? 's' : ''} · ${fmtBytes(totalBytes)} selected` : '';
    $$('#cmpRun').disabled = !n || !cmpState.out || cmpState.running;
    $$('#cmpRun').textContent = n ? `Compress ${n} clip${n !== 1 ? 's' : ''}` : 'Compress';
    const sa = $$('#cmpSelAll'); if (sa) sa.checked = n === cmpState.files.length && n > 0;
  }
  async function rescan() {
    $$('#cmpList').innerHTML = '<li class="muted small">Scanning…</li>';
    const r = await window.api.compressList(cmpState.src);
    cmpState.files = (r && r.ok ? r.files : []).map((f) => ({ ...f, _sel: true }));
    if (r && r.dir) cmpState.src = r.dir;
    paintFolders(); renderList();
  }
  paintFolders(); applyMode();

  ov.addEventListener('click', async (e) => {
    const mode = e.target.closest('[data-mode]');
    if (mode) { cmpState.mode = mode.dataset.mode; window.api.setPrefs({ compressMode: cmpState.mode }); applyMode(); return; }
    const openBtn = e.target.closest('[data-open]');
    if (openBtn) { const dir = openBtn.dataset.open === 'src' ? cmpState.src : cmpState.out; if (dir) window.api.openFolder(dir); return; }
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const which = pick.dataset.pick;
      const p = await window.api.pickFolder({ title: which === 'src' ? 'Choose the folder with clips to compress' : 'Choose where compressed clips go', defaultPath: which === 'src' ? cmpState.src : cmpState.out });
      if (p) { cmpState[which] = p; if (which === 'out') { window.api.setPrefs({ finalizeSource: p }); } paintFolders(); if (which === 'src' && cmpState.mode === 'app') rescan(); else updateRunBtn(); }
      return;
    }
    const pre = e.target.closest('[data-preset]');
    if (pre) { cmpState.preset = pre.dataset.preset; ov.querySelectorAll('.cmp-preset').forEach((b) => b.classList.toggle('on', b === pre)); return; }
    const cb = e.target.closest('.cmp-cb');
    if (cb) { cmpState.files[Number(cb.dataset.i)]._sel = cb.checked; updateRunBtn(); return; }
    if (e.target.closest('#cmpSelAll')) { const on = $$('#cmpSelAll').checked; cmpState.files.forEach((f) => { f._sel = on; }); renderList(); return; }
    if (e.target.closest('#cmpClose')) { close(); return; }
    if (e.target.closest('#cmpOrganize')) { close(); openFinalize(); return; }
    if (e.target.closest('#cmpCancel')) { window.api.compressCancel(); $$('#cmpCancel').textContent = 'Cancelling…'; return; }
    if (e.target.closest('#cmpRun')) { runCompress(); return; }
  });
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });

  async function runCompress() {
    const files = selected();
    if (!files.length || !cmpState.out) return;
    cmpState.running = true;
    $$('#cmpRun').classList.add('hidden'); $$('#cmpClose').classList.add('hidden'); $$('#cmpOrganize').classList.add('hidden');
    $$('#cmpCancel').classList.remove('hidden'); $$('#cmpCancel').textContent = 'Cancel';
    ov.querySelectorAll('.cmp-pick, .cmp-preset, #cmpSkip, #cmpSelAll, .cmp-cb').forEach((el) => { el.disabled = true; });
    // indices of selected files in the master list (so progress events map to rows)
    const idxMap = files.map((f) => cmpState.files.indexOf(f));
    setTask('compress', 'Compressing', 0, files.length, 'starting', '');
    if (cmpOff) cmpOff();
    // #88: a 50-clip 4K job showed per-file % but no batch ETA — no sense of how long the whole run
    // will take. Time the completed files and extrapolate a rough "~Nm left" from the average.
    const cmpStart = performance.now();
    let cmpDoneN = 0;
    const etaLabel = () => {
      if (!cmpDoneN || cmpDoneN >= files.length) return '';
      const perFile = (performance.now() - cmpStart) / 1000 / cmpDoneN;
      const left = Math.round(perFile * (files.length - cmpDoneN));
      return left > 0 ? ` · ~${left >= 60 ? `${Math.round(left / 60)}m` : `${left}s`} left` : '';
    };
    cmpOff = window.api.onCompressProgress((p) => {
      if (p.phase === 'done' || p.phase === 'skipped' || p.phase === 'error') cmpDoneN += 1;
      const masterI = idxMap[p.index];
      const stat = ov.querySelector(`[data-stat="${masterI}"]`); const fill = ov.querySelector(`[data-fill="${masterI}"]`);
      if (fill && typeof p.pct === 'number') fill.style.width = `${p.pct}%`;   // don't reset to 0 on indeterminate ticks
      if (stat) {
        if (p.phase === 'done') stat.innerHTML = `<span class="cmp-ok">✓ ${p.inBytes && p.outBytes ? `−${Math.max(0, Math.round((1 - p.outBytes / p.inBytes) * 100))}%` : 'done'}</span>`;
        else if (p.phase === 'skipped') stat.innerHTML = '<span class="muted small">already done</span>';
        else if (p.phase === 'error') stat.innerHTML = `<span class="cmp-err" title="${escapeHtml(p.error || '')}">failed</span>`;
        else if (p.indeterminate) stat.textContent = 'Compressing…';   // no duration → no %, show activity
        else stat.textContent = `${p.pct || 0}%`;
      }
      setTask('compress', 'Compressing', (p.index || 0) + 1, files.length, `${p.phase || 'compressing'}${etaLabel()}`, p.name || '');
    });
    // compress:run can REJECT (ffmpeg missing, EPERM on the out dir) — not just resolve
    // {ok:false}. The cleanup below therefore has to live in a `finally`: without it one
    // failed run wedged the dialog forever (Run+Close hidden, inputs disabled, task chip
    // stuck) AND orphaned the progress listener, which then double-wrote the rows on the
    // next run. Never `await` an IPC call between a subscribe and its unsubscribe without one.
    let res = null; let err = null;
    try {
      res = await window.api.compressRun({ files, outDir: cmpState.out, settings: { preset: cmpState.preset, skipExisting: $$('#cmpSkip').checked } });
    } catch (e) {
      err = (e && e.message) || String(e);
    } finally {
      if (cmpOff) { cmpOff(); cmpOff = null; }
      clearTask('compress');
      cmpState.running = false;
      $$('#cmpCancel').classList.add('hidden'); $$('#cmpClose').classList.remove('hidden');
      // Re-enable the inputs on EVERY exit path, not just the throw. This used to live only in the
      // `if (err)` branch, so a run that RESOLVED left them dead — and "resolved" covers a CANCELLED
      // run and a run with per-file failures, which are exactly the cases where you want to retry
      // the remainder. Cancel a 50-clip run at clip 3 and the checkboxes, preset picker, output
      // picker and Compress button were all disabled, so the only way to continue was to close and
      // reopen the dialog, losing the selection and preset. A dialog left disabled after the run has
      // ENDED is never right, whichever way it ended.
      ov.querySelectorAll('.cmp-pick, .cmp-preset, #cmpSkip, #cmpSelAll, .cmp-cb').forEach((el) => { el.disabled = false; });
    }
    if (err) {
      // Unhiding Run stays here and below: it is about whether there is WORK LEFT, not about whether
      // the controls should respond.
      $$('#cmpRun').classList.remove('hidden');
      showToast(`Compress failed — ${err}`, 6000);
      logIssue('Compress', err);
      return;
    }
    const ok = (res && res.results || []).filter((r) => r.ok && !r.skipped);
    const failed = (res && res.results || []).filter((r) => !r.ok);
    const saved = ok.reduce((s, r) => s + Math.max(0, (r.inBytes || 0) - (r.outBytes || 0)), 0);
    if (ok.length) $$('#cmpOrganize').classList.remove('hidden');
    // Offer Run again when there is still something to compress — a cancelled run left clips
    // untouched, and a failed one left clips that may succeed on a retry. After a clean sweep it
    // stays hidden, so the natural next step is Organize rather than a pointless re-run.
    if ((res && res.cancelled) || failed.length) $$('#cmpRun').classList.remove('hidden');
    // The ✓ used to be unconditional on the non-cancelled branch, so a run in which every clip
    // failed read "Compressed 0 clips · 12 failed ✓". Third instance of that pattern in this app
    // (after "AI auto-enhance complete ✓" and "Filed N …✓") — the per-file errors already reach
    // logIssue below, so only the headline was lying.
    const cmpMsg = (res && res.cancelled)
      ? `Stopped — ${ok.length} compressed`
      : (ok.length
        ? `Compressed ${ok.length} clip${ok.length !== 1 ? 's' : ''}${saved ? ` · saved ${fmtBytes(saved)}` : ''}${failed.length ? ` · ${failed.length} failed` : ''} ✓`
        : `Nothing was compressed${failed.length ? ` — ${failed.length} failed` : ''}`);
    showToast(cmpMsg, 6000);
    if (failed.length) failed.forEach((r) => logIssue('Compress', `${r.name}: ${r.error || 'failed'}`));
  }
}

// --- wiring ---
$('compressBtn').addEventListener('click', openCompress);
$('organizeBtn').addEventListener('click', openFinalize);
document.querySelectorAll('.fin-home').forEach((b) => b.addEventListener('click', goHome));

// --- Phone backup wiring (reached from the rename flow when a phone is the source) ---
document.querySelectorAll('.ph-home').forEach((b) => b.addEventListener('click', goHome));
$('phRescan').addEventListener('click', () => phoneDetect());
$('phCopyBtn').addEventListener('click', phoneCopy);
{ const c = $('phCopyCancel'); if (c) c.addEventListener('click', async () => {
  c.disabled = true; c.textContent = 'Cancelling…';
  $('phCopyLabel').textContent = 'Cancelling — finishing the current file…';
  try { await window.api.cancelCopy(); } catch { /* ignore */ }
}); }
// Smart chooser actions
$('phBackupNew').addEventListener('click', () => {
  phoneState.media.forEach((m) => { m.selected = !!m._act; });   // back up what's new or unfinished
  phoneCopy();
});
$('phReview').addEventListener('click', phoneEnterReview);
$('phSelectAll').addEventListener('change', (e) => {
  // Toggle only the currently-visible (filtered) media, not hidden items.
  const vis = phoneVisibleMedia();
  vis.forEach((m) => { m.selected = e.target.checked; });
  phoneRenderGrid(); phoneUpdateBar();
});
document.querySelectorAll('.ph-f').forEach((b) => b.addEventListener('click', () => {
  phoneState.filter = b.dataset.phf;
  document.querySelectorAll('.ph-f').forEach((x) => x.classList.toggle('on', x === b));
  phoneRenderGrid();
}));
$('finRescanBtn').addEventListener('click', finRunScan);
$('finPickBtn').addEventListener('click', async () => {
  const p = await window.api.pickFinalizeSource();
  if (!p) return;
  finScan.dir = p;
  $('finSourceLine').textContent = p;
  if (finDestMode === 'inplace') finRenderLevels();
  finRunScan();
});

// Step navigation
$('finNext1Btn').addEventListener('click', () => { if (finSelected().length) setFinStep(2); });
$('finBack2Btn').addEventListener('click', () => setFinStep(1));
$('finNext2Btn').addEventListener('click', () => {
  // When the map has a plan, IT decides the destination — the legacy finDestMode radios are in
  // the hidden #finLegacyOrg block and the user cannot even see them, so gating Continue on them
  // would block the step for a reason nobody could act on.
  const plan = currentDestPlan();
  if (!(plan && plan.root) && $('finOrganize').checked && finDestMode === 'custom' && !finCustomDest) {
    showToast('Pick a destination folder, or switch to “organize in place”'); return;
  }
  setFinStep(3);
});
$('finBack3Btn').addEventListener('click', () => setFinStep(2));
document.querySelectorAll('.fin-step').forEach((pill) => {
  pill.addEventListener('click', () => {
    const n = Number(pill.dataset.finstep);
    if (n === 1) return setFinStep(1);
    if (!finSelected().length) { showToast('Tick at least one clip on the Match step'); return; }
    if (n === 2) return setFinStep(2);
    if (n === 3) {
      if ($('finOrganize').checked && finDestMode === 'custom' && !finCustomDest) { showToast('Pick a destination folder first'); return; }
      setFinStep(3);
    }
  });
});

// Step 2 controls
$('finOrganize').addEventListener('change', () => { syncFinOptionRows(); renderFinMap(); });
// A move consumes no space on the destination, so the "won't fit" warning must recompute when he
// switches — otherwise it warns about a problem he has just solved.
$('finKeepSource').addEventListener('change', () => { renderFinMap(); });
$('finNas').addEventListener('change', () => { syncFinOptionRows(); });
document.querySelectorAll('input[name="finDestMode"]').forEach((r) => {
  r.addEventListener('change', () => { finDestMode = document.querySelector('input[name="finDestMode"]:checked').value; syncFinOptionRows(); finRenderLevels(); });
});
$('finDestBrowse').addEventListener('click', async () => {
  const p = await window.api.pickFolder({ title: 'Choose where to move organized footage', defaultPath: finCustomDest || finScan.dir });
  if (p) { finCustomDest = p; $('finDestPath').value = p; finRenderLevels(); }
});
$('finNasBrowse').addEventListener('click', async () => {
  const p = await window.api.pickFolder({ title: 'Choose the NAS / backup folder', defaultPath: finNasPathVal });
  if (p) { finNasPathVal = p; $('finNasPath').value = p; }
});

$('finOpenDestBtn').addEventListener('click', () => window.api.openFolder(finEffectiveDest() || finScan.dir));
$('finMapBtn').addEventListener('click', showDestinationMapAuto);

// Step 3 — run
$('finRunBtn').addEventListener('click', async () => {
  const matched = finSelected();
  if (!matched.length) { showToast('Tick at least one clip to run on'); return; }
  // `copy` mirrors "Keep the originals": ticked = copy into the project, leave the archive alone.
  const options = {
    embed: $('finEmbed').checked, csv: $('finCsv').checked,
    organize: $('finOrganize').checked, nas: $('finNas').checked,
    copy: $('finKeepSource').checked,
  };
  if (!options.embed && !options.csv && !options.organize && !options.nas) { showToast('Pick at least one action on the Organize step'); return; }

  // THE PLAN the user made on the destination map (Organize step 2) is what Run executes. Run
  // used to ignore it entirely and file by [category, project] into the Compressed folder — and
  // those fields are normally empty, so it moved nothing and cheerfully reported "0 moved".
  const plan = currentDestPlan();
  const planned = (c) => (plan && plan.byPath[c.sourcePath]) || '';
  const usePlan = !!(plan && plan.root && matched.some(planned));

  const dest = usePlan ? plan.root : finEffectiveDest();
  if (options.organize && !dest) { showToast('Pick a destination folder first'); return; }
  if (options.nas && !finNasPathVal) { showToast('Pick a NAS folder, or untick the NAS backup'); return; }

  // #43: a folder map EXISTS but NONE of the ticked clips are on it (the user re-selected a
  // different set after mapping). usePlan is false, so filing would fall through to the finLevels
  // path — normally empty — and flat-dump every clip into the ROOT of the destination, beside the
  // real project folders. That's the "planned a tree, Run dumped to root" failure. Stop and send
  // them back to the map rather than silently misfiling their footage.
  const planExists = !!(plan && plan.root && plan.byPath && Object.keys(plan.byPath).length);
  if (options.organize && planExists && !usePlan) {
    await confirmDialog(
      'These clips aren’t on your Organize map',
      'You mapped folders on the Organize step, but none of the ticked clips are placed there. Running now would file them into the ROOT of the destination instead of your project folders — so this run is stopped. Go back to Organize and place these clips (or tick the ones you already mapped), then Run again.',
      'OK', 'Cancel'
    );
    return;
  }

  if (options.organize) {
    const unplanned = usePlan ? matched.filter((c) => !planned(c)).length : 0;
    const where = usePlan
      ? `Files move into your Projects tree at ${dest}, exactly where the map on the Organize step shows them.${unplanned ? ` ${unplanned} clip${unplanned !== 1 ? 's have' : ' has'} no place on the map yet and will be skipped — go back and file ${unplanned !== 1 ? 'them' : 'it'} first.` : ''}`
      : `Files move into ${dest}\\${finLevels.map(finLevelLabel).map((s) => s.toLowerCase()).join('\\')}\\…`;
    // SAY WHERE THE UNNAMED ONES GO. A clip the AI never described files to `<date>/_unsorted` rather
    // than the category/project path above (2026-07-19bj), so a mixed selection has TWO destinations
    // and this sentence described one. Since unnamed clips became fileable AND selectable in the same
    // session, this confirmation is the only place the app can tell him before he finds out by
    // looking at his Projects tree afterwards — which is the "I have to re-check its work" failure
    // this whole effort exists to remove. Counted from the SELECTION, so it describes the run he is
    // actually about to make.
    const plainN = matched.filter((c) => !c.matched).length;
    const plainNote = plainN
      ? ` ${plainN} clip${plainN !== 1 ? 's have' : ' has'} no name yet and will file by date into a “_unsorted” folder you can sort later.`
      : '';
    const ok = await confirmDialog(
      `Organize ${matched.length} clip${matched.length !== 1 ? 's' : ''}?`,
      `${where}${plainNote} Re-running is safe — existing folders are reused and duplicates are skipped.`,
      'Run', 'Cancel'
    );
    if (!ok) return;
  }

  // Persist the per-run choices as the new defaults.
  folderLevels = finLevels.slice();
  organizeDest = options.organize && finDestMode === 'custom' ? finCustomDest : organizeDest;
  nasBackup = { enabled: options.nas, path: finNasPathVal };
  window.api.setPrefs({ folderLevels, organizeDest, nasBackup });

  $('finRunBtn').disabled = true;
  $('finProgressWrap').classList.remove('hidden');
  $('finResultList').classList.add('hidden');
  $('finBar').style.width = '0%';
  $('finPct').textContent = '0%';
  $('finLabel').textContent = 'Starting…';
  $('finSub').textContent = '';

  if (finUnsub) finUnsub();
  finUnsub = window.api.onFinalizeProgress((p) => {
    const pct = pctOf(p.index, p.total);
    $('finBar').style.width = `${pct}%`;
    $('finPct').textContent = `${pct.toFixed(0)}%`;
    const phase = { embedding: 'Embedding', moving: 'Filing', backup: 'Backing up' }[p.phase] || 'Working';
    $('finLabel').textContent = `${phase} ${p.index + 1}/${p.total}: ${p.name}`;
  });

  // finalize:run does exiftool spawns and cross-device moves, so it can REJECT outright
  // (a locked file on Windows throws EBUSY) rather than resolve {ok:false}. A throw used to
  // skip the unsubscribe AND leave finRunBtn disabled — the Finalize screen was dead until
  // the app restarted. Unsubscribe in a `finally`, and treat a throw exactly like {ok:false}.
  let summary = null; let err = null;
  try {
    summary = await window.api.finalizeRun({
      // Each item carries the folder the map put it in. A clip with no place on the map sends no
      // `rel`, so finalize:run leaves it where it is rather than inventing a destination for it.
      dir: finScan.dir,
      items: usePlan ? matched.map((c) => ({ ...c, rel: planned(c) })) : matched,
      options,
      organizeDest: dest, folderLevels: finLevels, nasPath: finNasPathVal
    });
  } catch (e) {
    err = (e && e.message) || String(e);
  } finally {
    if (finUnsub) { finUnsub(); finUnsub = null; }
  }

  if (err || !summary || !summary.ok) {
    $('finLabel').textContent = `Failed: ${err || (summary ? summary.error : 'unknown error')}`;
    $('finRunBtn').disabled = false;
    return;
  }
  $('finBar').style.width = '100%';
  $('finPct').textContent = '100%';
  // "DONE" OVER A RUN THAT FILED NOTHING IS THE DEAD-END.
  //
  // Filing is the point of this screen — his project ledger read 0 for months. A run with Organize
  // unticked embeds metadata and reports a green "Done" with no `moved` chip at all, so nothing on
  // screen mentions filing and the natural reading is "finished". Same for a run that was organizing
  // but moved 0. He walks away believing the job is complete, and the pile has not moved.
  //
  // Say it plainly, and leave the Run button available so the fix is one click rather than a hunt.
  const filedNothing = !summary.moved;
  $('finLabel').textContent = filedNothing ? 'Nothing was filed' : 'Done';
  $('finLabel').classList.toggle('done', !filedNothing);
  // Result stat chips.
  const stats = [];
  if (options.embed) stats.push(['embedded', summary.embedded, '']);
  if (options.organize) stats.push(['moved', summary.moved, '']);
  if (options.nas) stats.push(['backed up', summary.backedUp, '']);
  if (summary.skipped) stats.push(['skipped', summary.skipped, '']);
  // Clips with no place on the map were deliberately left alone. Say so — a silently-omitted
  // clip is exactly how "Run did nothing and didn't tell me" happens.
  if (summary.unplanned) stats.push([`not filed (no place on the map)`, summary.unplanned, 'warn']);
  if (summary.errors && summary.errors.length) stats.push(['issue' + (summary.errors.length !== 1 ? 's' : ''), summary.errors.length, 'warn']);
  const statsEl = $('finStats');
  statsEl.innerHTML = stats.map(([label, n, cls]) => `<span class="fin-stat ${cls}"><b>${n}</b> ${label}</span>`).join('');
  statsEl.classList.remove('hidden');
  $('finSub').textContent = summary.csvPath ? `Resolve CSV: ${summary.csvPath}` : '';
  if (summary.errors && summary.errors.length) {
    const rl = $('finResultList'); rl.innerHTML = '';
    for (const e of summary.errors.slice(0, 30)) { const li = document.createElement('li'); li.textContent = e; rl.appendChild(li); }
    rl.classList.remove('hidden');
    console.warn('Finalize issues:', summary.errors);
    // ⚠⚠ AND WRITE THEM SOMEWHERE THAT OUTLIVES THIS SCREEN.
    //
    // The list above is real and readable — but it disappears the moment he navigates away, and a
    // `console.warn` is not somewhere he will ever look. These are the messages that say a second
    // copy did not happen: with the NAS unreachable, a run reports `moved: 4, backedUp: 0` plus one
    // error per clip. He needs to be able to find that tomorrow, not only in the seconds after the
    // run. The issue log is the one place in this app that answers "what did it actually do".
    //
    // Capped at 30 to match the list: an error per clip on a 310-clip run would otherwise bury every
    // other entry in the log.
    for (const e of summary.errors.slice(0, 30)) {
      try { logIssue('Organize', String(e)); } catch { /* the on-screen list already has it */ }
    }
    if (summary.errors.length > 30) {
      try { logIssue('Organize', `…and ${summary.errors.length - 30} more issues in this run`); } catch { /* ignore */ }
    }
  }
  finRan = true;
  // The one-click fix: if nothing was filed, tick Organize and keep Run on screen so the next click
  // actually files. Hiding Run here is what turned "nothing happened" into a dead end.
  if (filedNothing) {
    const org = $('finOrganize');
    const wasOff = org && !org.checked;
    if (org) org.checked = true;
    // Keep the CSV path if one was written — this line runs after the csvPath assignment above, so a
    // bare overwrite would discard a real output the run produced.
    const why = wasOff
      ? 'Organize was unticked, so nothing moved into your Projects tree. It is ticked now — press Run to file them.'
      : 'Nothing moved into your Projects tree. Check the destination folder above, then press Run again.';
    $('finSub').textContent = summary.csvPath ? `${why}  ·  Resolve CSV: ${summary.csvPath}` : why;
    $('finRunBtn').disabled = false;
    $('finRunBtn').classList.remove('hidden');
  } else {
    $('finRunBtn').classList.add('hidden');
  }
  $('finOpenDestBtn').classList.remove('hidden');
  $('finDoneHome').classList.remove('hidden');
  // Refresh the underlying scan so a re-entry to step 1 reflects the moved files.
  finRunScan();
});

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function escapeAttr(s) { return escapeHtml(s); }

// ---------------------------------------------------------------------------
// White-outline emoji rendering. Every emoji glyph in the UI is swapped for the
// matching OpenMoji black/outline SVG (bundled in src/emoji, tinted white in CSS,
// gently animated). A MutationObserver re-runs on dynamically inserted DOM so all
// modals/toasts get the treatment too. Inputs/textareas/scripts are left untouched.
// OpenMoji — CC BY-SA 4.0 (see src/emoji/OPENMOJI-CREDITS.txt).
// ---------------------------------------------------------------------------
(() => {
  const CODES = ['2728', '26A0', '1F642', '1F5C2', '1F9E0', '1F4C5', '1F4C1', '2194', '1F4DD', '1F4E4', '1F4CD', '1F3AC', '1F4C2', '1FAE5', '1F517', '1F5C4'];
  const codeByChar = {};
  for (const c of CODES) codeByChar[String.fromCodePoint(parseInt(c, 16))] = c;
  const bases = Object.keys(codeByChar).map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const reSrc = `(${bases.join('|')})\\uFE0F?`;
  const oeTest = new RegExp(reSrc, 'u');     // non-global: safe for .test()
  const oeExec = new RegExp(reSrc, 'gu');    // global: for iterating matches
  const SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, IMG: 1, SVG: 1, CODE: 1 };
  function processText(tn) {
    const s = tn.nodeValue;
    if (!s || !oeTest.test(s)) return;
    // .keep-emoji marks spots that should stay NATIVE colourful emoji (e.g. the
    // file-explorer folder/clip icons) — don't swap those for white outlines.
    if (tn.parentElement && tn.parentElement.closest('.keep-emoji')) return;
    const frag = document.createDocumentFragment();
    let last = 0; let m; oeExec.lastIndex = 0;
    while ((m = oeExec.exec(s))) {
      if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
      const code = codeByChar[m[1]];
      const img = document.createElement('img');
      img.className = 'oe'; img.src = `emoji/${code}.svg`; img.alt = m[0]; img.draggable = false;
      frag.appendChild(img);
      last = m.index + m[0].length;
    }
    if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
    if (tn.parentNode) tn.parentNode.replaceChild(frag, tn);
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { processText(root); return; }
    if (root.nodeType !== 1) return;
    if (SKIP[root.tagName] || (root.classList && root.classList.contains('oe'))) return;
    if (root.closest && root.closest('.keep-emoji')) return;
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || SKIP[p.tagName] || p.closest('.keep-emoji')) return NodeFilter.FILTER_REJECT;
        return oeTest.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const nodes = []; let n; while ((n = tw.nextNode())) nodes.push(n);
    nodes.forEach(processText);
  }
  function start() {
    walk(document.body);
    const obs = new MutationObserver((muts) => {
      for (const mu of muts) {
        if (mu.type === 'characterData') processText(mu.target);
        else mu.addedNodes.forEach((nd) => walk(nd));
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

// ---------------------------------------------------------------------------
// Accessibility: every modal in this app is an ad-hoc `.modal-overlay` > `.modal-card`
// built inline at ~a dozen call sites — none carried dialog semantics, so screen
// readers announced them as anonymous groups and never trapped/announced them as
// dialogs. One observer stamps role="dialog"/aria-modal on any modal card as it
// mounts, covering every call site without touching each one.
// ---------------------------------------------------------------------------
(function modalDialogSemantics() {
  function stamp(card) {
    if (!card || card.getAttribute('role')) return;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    // Prefer an explicit heading as the accessible name; otherwise fall back to
    // the overlay's own aria-label if a call site set one.
    const h = card.querySelector('h1,h2,h3,.modal-title');
    if (h) {
      if (!h.id) h.id = `mdlttl-${Math.round(performance.now() * 1000) % 1e9}-${card.childElementCount}`;
      card.setAttribute('aria-labelledby', h.id);
    }
  }
  function scan(node) {
    if (node.nodeType !== 1) return;
    if (node.classList && node.classList.contains('modal-overlay')) {
      const card = node.querySelector('.modal-card');
      if (card) stamp(card);
    } else if (node.querySelector) {
      node.querySelectorAll('.modal-overlay > .modal-card').forEach(stamp);
    }
  }
  function begin() {
    document.querySelectorAll('.modal-overlay > .modal-card').forEach(stamp);
    new MutationObserver((muts) => {
      for (const mu of muts) mu.addedNodes.forEach(scan);
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', begin);
  else begin();
})();

// ---------------------------------------------------------------------------
// PERSISTENCE FAILURES — say them out loud.
//
// saveStore/saveConfig can refuse (the file failed to read this launch, so writing our empty
// in-memory default would destroy it) or throw (disk full, EPERM). Those were console-only while
// every handler above them kept returning ok:true, so the app went on accepting work it could not
// keep: an evening of naming faces and typing descriptions, each with a ✓, gone on restart. The
// condition reached crash.log, which is not somewhere anyone looks.
//
// Reported once per store by main, so this cannot become a toast storm. Asked for at startup too,
// because the failure can happen before this window exists.
// ---------------------------------------------------------------------------
(() => {
  const seen = new Set();
  const say = (info) => {
    if (!info || !info.key || seen.has(info.key)) return;
    seen.add(info.key);
    const what = info.key === 'config' ? 'Settings' : `Saved data (${info.key})`;
    const msg = `${what} can’t be saved — ${info.why}. Anything you change now will be lost when the app closes.`;
    try { showToast(msg, 15000); } catch { /* toast may not exist yet */ }
    try { logIssue('Storage', msg); } catch { /* ignore */ }
  };
  try { window.api.onStorePersistFailed(say); } catch { /* ignore */ }
  // A failure during boot happens before the listener above is attached.
  setTimeout(async () => {
    try { (await window.api.storePersistFailures() || []).forEach(say); } catch { /* ignore */ }
  }, 1500);
})();
