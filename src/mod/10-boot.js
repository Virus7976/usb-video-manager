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
    cmpOff = window.api.onCompressProgress((p) => {
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
      setTask('compress', 'Compressing', (p.index || 0) + 1, files.length, p.phase || 'compressing', p.name || '');
    });
    const res = await window.api.compressRun({ files, outDir: cmpState.out, settings: { preset: cmpState.preset, skipExisting: $$('#cmpSkip').checked } });
    if (cmpOff) { cmpOff(); cmpOff = null; }
    clearTask('compress');
    cmpState.running = false;
    const ok = (res && res.results || []).filter((r) => r.ok && !r.skipped);
    const failed = (res && res.results || []).filter((r) => !r.ok);
    const saved = ok.reduce((s, r) => s + Math.max(0, (r.inBytes || 0) - (r.outBytes || 0)), 0);
    $$('#cmpCancel').classList.add('hidden'); $$('#cmpClose').classList.remove('hidden');
    if (ok.length) $$('#cmpOrganize').classList.remove('hidden');
    showToast(res && res.cancelled ? `Stopped — ${ok.length} compressed` : `Compressed ${ok.length} clip${ok.length !== 1 ? 's' : ''}${saved ? ` · saved ${fmtBytes(saved)}` : ''}${failed.length ? ` · ${failed.length} failed` : ''} ✓`, 6000);
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
  if ($('finOrganize').checked && finDestMode === 'custom' && !finCustomDest) {
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
$('finOrganize').addEventListener('change', () => { syncFinOptionRows(); });
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
$('finMap2Btn').addEventListener('click', showDestinationMapAuto);

// Step 3 — run
$('finRunBtn').addEventListener('click', async () => {
  const matched = finSelected();
  if (!matched.length) { showToast('Tick at least one clip to run on'); return; }
  const options = { embed: $('finEmbed').checked, csv: $('finCsv').checked, organize: $('finOrganize').checked, nas: $('finNas').checked };
  if (!options.embed && !options.csv && !options.organize && !options.nas) { showToast('Pick at least one action on the Organize step'); return; }
  const dest = finEffectiveDest();
  if (options.organize && !dest) { showToast('Pick a destination folder first'); return; }
  if (options.nas && !finNasPathVal) { showToast('Pick a NAS folder, or untick the NAS backup'); return; }

  if (options.organize) {
    const ok = await confirmDialog(
      `Organize ${matched.length} clip${matched.length !== 1 ? 's' : ''}?`,
      `Files move into ${dest}\\${finLevels.map(finLevelLabel).map((s) => s.toLowerCase()).join('\\')}\\… Re-running is safe — existing folders are reused and duplicates are skipped.`,
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
    const pct = p.total ? Math.min(100, (p.index / p.total) * 100) : 0;
    $('finBar').style.width = `${pct}%`;
    $('finPct').textContent = `${pct.toFixed(0)}%`;
    const phase = { embedding: 'Embedding', moving: 'Filing', backup: 'Backing up' }[p.phase] || 'Working';
    $('finLabel').textContent = `${phase} ${p.index + 1}/${p.total}: ${p.name}`;
  });

  const summary = await window.api.finalizeRun({
    dir: finScan.dir, items: matched, options,
    organizeDest: dest, folderLevels: finLevels, nasPath: finNasPathVal
  });
  if (finUnsub) { finUnsub(); finUnsub = null; }

  if (!summary || !summary.ok) {
    $('finLabel').textContent = `Failed: ${summary ? summary.error : 'unknown error'}`;
    $('finRunBtn').disabled = false;
    return;
  }
  $('finBar').style.width = '100%';
  $('finPct').textContent = '100%';
  $('finLabel').textContent = 'Done';
  $('finLabel').classList.add('done');
  // Result stat chips.
  const stats = [];
  if (options.embed) stats.push(['embedded', summary.embedded, '']);
  if (options.organize) stats.push(['moved', summary.moved, '']);
  if (options.nas) stats.push(['backed up', summary.backedUp, '']);
  if (summary.skipped) stats.push(['skipped', summary.skipped, '']);
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
  }
  finRan = true;
  $('finRunBtn').classList.add('hidden');
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
