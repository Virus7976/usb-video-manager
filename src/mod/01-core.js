'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  drive: null,        // { mountpoint, description, ... }
  scannedFiles: [],   // [{ sourcePath, name, ext, size }]
  copied: [],         // [{ sourcePath, destPath, name, ext, size }]
  intakeFolder: null
};

const $ = (id) => document.getElementById(id);

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
}

// --- Shared primitives (single source of truth; used across modules) ---
// Append values to an array, de-duplicated, returning a NEW array. Replaces the
// `[...new Set([...(arr||[]), ...vals])]` idiom that was copy-pasted ~14 times.
function addUnique(arr, ...vals) { return [...new Set([...(Array.isArray(arr) ? arr : []), ...vals.flat()])]; }
// The system default Ollama endpoint — was hardcoded in ~5 renderer spots.
const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';
// Canonical "is this a video" regex (renderer copy of main's VIDEO_EXT_LIST — kept the
// same superset so both processes agree on .webm/.ts/.3gp/.mts etc.).
const VIDEO_RX = /\.(mp4|mov|m4v|avi|mkv|mts|m2ts|3gp|3g2|webm|ts)$/i;
// A person's avatar chip (thumb image or a neutral face glyph) — was inlined 6×.
function personThumbHTML(thumb) {
  return thumb ? `<img src="${escapeAttr(thumb)}"/>` : '<span class="face-ph-icon">🙂</span>';
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
// --- Windows 11 theme (system light/dark + accent) ------------------------
function hexToRgb(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
function rgbToHex(r, g, b) { const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'); return `#${c(r)}${c(g)}${c(b)}`; }
function lighten(hex, amt) { const [r, g, b] = hexToRgb(hex); return rgbToHex(r + (255 - r) * amt, g + (255 - g) * amt, b + (255 - b) * amt); }
function darken(hex, amt) { const [r, g, b] = hexToRgb(hex); return rgbToHex(r * (1 - amt), g * (1 - amt), b * (1 - amt)); }
function applyTheme(t) {
  if (!t) return;
  const root = document.documentElement;
  root.setAttribute('data-theme', t.dark ? 'dark' : 'light');
  const fallbackAccent = t.dark ? '#60cdff' : '#005fb8';
  let accent = (t.accent && /^#[0-9a-f]{6}$/i.test(t.accent)) ? t.accent : fallbackAccent;
  // If the system accent is nearly grey (low saturation), primary buttons become
  // indistinguishable from secondary ones — fall back to a legible blue so primary
  // actions actually pop, keeping the Fluent feel without the washed-out look.
  { const [ar, ag, ab] = hexToRgb(accent); const mx = Math.max(ar, ag, ab) / 255; const mn = Math.min(ar, ag, ab) / 255; const sat = mx === 0 ? 0 : (mx - mn) / mx; if (sat < 0.18) accent = fallbackAccent; }
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-text', t.dark ? lighten(accent, 0.45) : accent);
  root.style.setProperty('--accent-hover', t.dark ? lighten(accent, 0.12) : darken(accent, 0.08));
  root.style.setProperty('--accent-pressed', t.dark ? darken(accent, 0.1) : darken(accent, 0.18));
  // Readable text/glyph color on top of the accent fill (luminance-based).
  const [r, g, b] = hexToRgb(accent);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  root.style.setProperty('--accent-fg', lum > 0.6 ? '#1a1a1a' : '#ffffff');
}

// View options (persisted): density/visibility toggles applied as root classes.
const uiPrefs = { showHelp: false, compact: false, showResult: true, autoplayAudio: false, notifications: true, showCommandBar: true, showMetaRow: true, finMatchedOnly: false, cleanGrid: true, dayDividers: true, showLocation: false, autoVersionOnAi: true, autoRestore: true, autoAnalyzeAfterCopy: true, quickAnalyze: true, autoTagFaces: false, finalizePhotos: false, routesSeeded: false };
// Duplicate-import detection: keys (name+size) of source files imported before.
let importedSet = new Set();
function importKey(c) { return `${String((c && c.name) || '').toLowerCase()}__${(c && c.size) || 0}`; }
async function loadImportedSet() { try { const k = await window.api.importsGet(); importedSet = new Set(k || []); } catch { importedSet = new Set(); } }
// How the ⤓ "apply to selected" handles the date: 'always' | 'ask' | 'never'.
let copyDateMode = 'always';
function setCopyDateMode(m) { copyDateMode = m; window.api.setPrefs({ copyDateMode: m }); }
// What Enter on the description field does: 'columns' (jump to next clip — sweep
// subjects/descriptions, then categories/projects) or 'row' (continue into
// category → project on the same clip).
let enterFlow = 'columns';
function setEnterFlow(m) { enterFlow = m; window.api.setPrefs({ enterFlow: m }); }
// Which organizing fields become folder levels (ordered), e.g. Compressed/<category>/<project>/.
let folderLevels = ['category', 'project'];
let organizeDest = '';                              // where Finalize moves organized footage
let nasBackup = { enabled: false, path: '' };       // optional second copy during intake
// User-managed organizing fields (taxonomy) + their remembered value history.
let organizeFields = [{ id: 'category', label: 'Category' }, { id: 'project', label: 'Project' }];
let fieldHistoryCache = {};                          // { fieldId: [remembered values] }
// Local AI (Ollama) suggestions — off until configured.
let aiCfg = { enabled: false, endpoint: 'http://localhost:11434', model: '', textModel: '', suggestCategory: true, suggestTags: true, frames: 3, detectShot: true, updateSubject: false, shotTypes: [], askAfterRun: false, temperature: 0.2, prompt: '', multiPass: false, learnFromEdits: true, learnFromAnalysis: true, faceInterval: 2, faceMaxFrames: 24, memories: [] };
function postRunConfirmEnabled() { return !!aiCfg.askAfterRun; }
const AI_DEFAULT_GUIDANCE = "You are tagging one video clip for a videographer's archive. The image is a contact sheet of frames sampled across the clip in time order (left to right). Use them together to judge motion and the type of shot, then identify the main subject and what is happening.";
const DEFAULT_SHOT_TYPES = [
  { name: 'talking-head', desc: 'a person speaking to camera, fairly static framing' },
  { name: 'pov', desc: 'first-person point-of-view; camera moves with the wearer' },
  { name: 'vlog', desc: 'handheld self-recording, person plus their surroundings' },
  { name: 'interview', desc: 'one or more people being interviewed' },
  { name: 'b-roll', desc: 'supplementary footage, no main speaker' },
  { name: 'action', desc: 'fast movement or sport' },
  { name: 'wide-establishing', desc: 'a wide shot that sets the scene' },
  { name: 'timelapse', desc: 'sped-up footage over time' },
  { name: 'still', desc: 'a held photo or barely-moving frame' }
];
function aiReady() { return !!(aiCfg.enabled && aiCfg.model); }
// Gate AI actions with a CLEAR reason + a fix when not ready (off, or no model).
function requireAi() {
  if (!aiCfg.enabled) {
    const ov = document.createElement('div'); ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal-card modal-form" style="width:min(440px,92vw);text-align:center">
      <div class="illo">${ILLO_AI}</div>
      <h3>Let AI name your clips</h3>
      <p class="muted small" style="margin:2px auto 12px;max-width:360px">Turn it on and pick a local model in AI settings. It runs fully offline via Ollama — no cloud, no key.</p>
      <div class="modal-actions" style="justify-content:center"><button type="button" class="btn primary ra-go">Open AI settings</button><button type="button" class="btn ra-x">Close</button></div></div>`;
    document.body.appendChild(ov); const c = () => ov.remove();
    ov.querySelector('.ra-x').addEventListener('click', c); ov.addEventListener('mousedown', (e) => { if (e.target === ov) c(); });
    ov.querySelector('.ra-go').addEventListener('click', () => { c(); showAiSettings(); });
    return false;
  }
  if (!aiCfg.model) {
    const ov = document.createElement('div'); ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal-card modal-form" style="width:min(460px,92vw);text-align:center">
      <div class="illo">${ILLO_AI}</div>
      <h3>One quick download to start</h3>
      <p class="muted small" style="margin:2px auto 12px;max-width:380px">The AI needs a local <b>vision model</b> to look at your clips. Grab one (e.g. <b>qwen2.5vl</b> or <b>llava-llama3</b>) in the model store — it runs offline once downloaded.</p>
      <div class="modal-actions" style="justify-content:center"><button type="button" class="btn primary ra-store">Open model store</button><button type="button" class="btn ra-x">Close</button></div></div>`;
    document.body.appendChild(ov); const c = () => ov.remove();
    ov.querySelector('.ra-x').addEventListener('click', c); ov.addEventListener('mousedown', (e) => { if (e.target === ov) c(); });
    ov.querySelector('.ra-store').addEventListener('click', () => { c(); showModelStore({ onUseVision: (m) => { aiCfg.model = m; window.api.setPrefs({ ai: { ...aiCfg, model: m } }); } }); });
    return false;
  }
  return true;
}
function applyAiPref() { document.documentElement.classList.toggle('ui-ai-off', !aiReady()); }
function applyUiPrefs() {
  const root = document.documentElement;
  root.classList.toggle('ui-show-help', uiPrefs.showHelp);
  root.classList.toggle('ui-compact', uiPrefs.compact);
  root.classList.toggle('ui-hide-result', !uiPrefs.showResult);
  root.classList.toggle('ui-hide-commandbar', !uiPrefs.showCommandBar);
  root.classList.toggle('ui-hide-metarow', !uiPrefs.showMetaRow);
  // Clean grid = just Subject + Description (Category/Project hidden; AI handles
  // the filing). The taxonomy/organize system stays intact underneath.
  root.classList.toggle('ui-clean-grid', uiPrefs.cleanGrid !== false);
  root.classList.toggle('ui-show-location', !!uiPrefs.showLocation);
}

let cfg = null;
// --- Interaction breadcrumb log (fixing-stage): record every click + which screen it
// happened on, so a reported problem can be traced to exactly what was clicked/where it
// went. Written to interaction-log.jsonl in userData. ---
(function initInteractionLog() {
  const screenNow = () => {
    for (const id of ['taskTheater', 'phone', 'finalize', 'flow']) { const e = document.getElementById(id); if (e && !e.classList.contains('hidden')) return id; }
    return 'home';
  };
  const describe = (el) => {
    if (!el || el === document || !el.tagName) return '';
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 48);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${txt ? ` "${txt}"` : ''}`;
  };
  document.addEventListener('click', (e) => {
    const el = (e.target.closest && e.target.closest('button, a, .settings-card, .dl-card, [data-action], .ph-f, .step, .fin-step, input, label, .ph-album')) || e.target;
    try { window.api.logInteraction({ t: Date.now(), type: 'click', el: describe(el), screen: screenNow() }); } catch { /* ignore */ }
  }, true);
})();

(async function init() {
  applyTheme(await window.api.getTheme());
  window.api.onThemeChange(applyTheme);

  cfg = await window.api.getConfig();
  state.intakeFolder = cfg.intakeFolder;
  if (cfg.ui) Object.assign(uiPrefs, cfg.ui);
  applyUiPrefs();
  if (cfg.previewWidth) applyPreviewWidth(cfg.previewWidth);
  if (cfg.phoneThumb) applyPhThumb(cfg.phoneThumb);
  loadImportedSet();   // remember what's been imported before (duplicate detection)
  if (cfg.hotkeys) hotkeys = { ...hotkeys, ...cfg.hotkeys };
  if (Array.isArray(cfg.textMacros)) textMacros = cfg.textMacros;
  if (cfg.copyDateMode) copyDateMode = cfg.copyDateMode;
  if (cfg.enterFlow) enterFlow = cfg.enterFlow;
  if (Array.isArray(cfg.folderLevels)) folderLevels = cfg.folderLevels;
  if (Array.isArray(cfg.organizeFields) && cfg.organizeFields.length) organizeFields = cfg.organizeFields;
  if (typeof cfg.organizeDest === 'string') organizeDest = cfg.organizeDest;
  if (cfg.nasBackup) nasBackup = { enabled: !!cfg.nasBackup.enabled, path: cfg.nasBackup.path || '' };
  if (cfg.ai) aiCfg = {
    enabled: !!cfg.ai.enabled, endpoint: cfg.ai.endpoint || 'http://localhost:11434', model: cfg.ai.model || '', textModel: cfg.ai.textModel || '',
    suggestCategory: cfg.ai.suggestCategory !== false, suggestTags: cfg.ai.suggestTags !== false,
    frames: Number(cfg.ai.frames) || 3, detectShot: cfg.ai.detectShot !== false,
    updateSubject: !!cfg.ai.updateSubject, shotTypes: Array.isArray(cfg.ai.shotTypes) ? cfg.ai.shotTypes : [], askAfterRun: !!cfg.ai.askAfterRun,
    temperature: isFinite(Number(cfg.ai.temperature)) ? Number(cfg.ai.temperature) : 0.2, prompt: cfg.ai.prompt || '',
    multiPass: !!cfg.ai.multiPass, learnFromEdits: cfg.ai.learnFromEdits !== false,
    learnFromAnalysis: cfg.ai.learnFromAnalysis !== false,
    faceInterval: Math.max(1, Math.min(15, Number(cfg.ai.faceInterval) || 2)),
    faceMaxFrames: Math.max(4, Math.min(120, Number(cfg.ai.faceMaxFrames) || 24)),
    memories: Array.isArray(cfg.ai.memories) ? cfg.ai.memories : []
  };
  applyAiPref();
  try { appVersionStr = (await window.api.appVersion()) || ''; } catch { appVersionStr = ''; }
  try { versionsCache = (await window.api.getVersions()) || []; } catch { versionsCache = []; }
  try { routesCache = (await window.api.getRoutes()) || []; } catch { routesCache = []; }
  try { clipObsCache = (await window.api.getClipObs()) || {}; } catch { clipObsCache = {}; }
  // No filing rules are seeded — everyone builds their own (via "🎬 Sort with me" or
  // Filing rules…), so the app ships generic with zero personal projects baked in.
  if (!uiPrefs.routesSeeded) { uiPrefs.routesSeeded = true; window.api.setUiPref('routesSeeded', true); }
  const hz = $('aiHazard');
  if (hz) hz.addEventListener('click', toggleHazardPop);
  await refreshFields();
  buildCommandBarFields();
  $('intakePathLine').textContent = cfg.intakeFolder;

  if (!cfg.detectionEnabled) {
    $('statusLine').textContent = 'Drive enumeration unavailable — use “Choose drive…”.';
  } else if (cfg.autoPoll) {
    $('statusLine').textContent = 'Monitoring for USB / SD insertion…';
    document.querySelector('.brand-dot').classList.add('live');
  } else {
    $('statusLine').textContent = cfg.hotkey
      ? `Ready — press ${cfg.hotkey} (or the tray icon) after inserting a card.`
      : 'Ready — use “Choose drive…”.';
    document.querySelector('.brand-dot').classList.add('live');
  }

  // The home action list is always available — "Organize & back up" works on the
  // Compressed folder and needs no card inserted. The drive banner only appears
  // once a removable drive is detected/chosen.
  $('actionList').classList.remove('hidden'); $('driveList').classList.remove('hidden'); showHomeExtras();

  // A drive being detected refreshes the home Devices list (you pick from it) rather
  // than auto-jumping, so you always see every available drive.
  window.api.onDriveDetected(() => refreshDriveList());
  window.api.onDriveOptions((drives) => onDriveOptions(drives));
  refreshDriveList();   // populate the device list at startup
  renderPendingWork();  // "you've got footage to deal with" — surfaced on every launch
  const amChk = $('autoModeChk');
  if (amChk) {
    amChk.checked = !!uiPrefs.autoMode;
    const amBar = $('autoModeBar'); if (amBar) amBar.classList.toggle('am-on', amChk.checked);
    amChk.addEventListener('change', () => {
      uiPrefs.autoMode = amChk.checked;
      if (amBar) amBar.classList.toggle('am-on', amChk.checked);
      window.api.setUiPref('autoMode', amChk.checked);
      showToast(amChk.checked
        ? '⚡ Auto mode on — pick a device and it runs the whole backup itself (you only batch photos, nothing is ever deleted).'
        : 'Auto mode off — back up step by step.', 4000);
    });
  }
  const afChk = $('autoFaceChk');
  if (afChk) {
    afChk.checked = uiPrefs.autoFaceScan !== false;   // default on
    afChk.addEventListener('change', () => {
      uiPrefs.autoFaceScan = afChk.checked;
      window.api.setUiPref('autoFaceScan', afChk.checked);
      showToast(afChk.checked ? 'Auto face-tagging on (unconfirmed guesses).' : 'Auto face-tagging off.', 3000);
    });
  }

  // If a copy was already running (e.g. window was closed and reopened), resume
  // straight to its progress so you can see where it's at — and continue.
  const cs = await window.api.copyStatus();
  if (cs && cs.active) { updateCopyChip(cs); goToCopyProgress(cs); }
  maybeFirstRunSetup();   // first-ever launch → setup wizard, else the spotlight tour
})();

// All available removable drives, listed on the home screen so you can see & pick
// any of them (not just whatever auto-selected).
const DL_ICON_CARD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v4M11 4v4M15 4v4"/><path d="M3 13h18"/></svg>`;
const DL_ICON_USB = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="9" width="10" height="12" rx="2"/><path d="M9.5 9V4.5h5V9"/><path d="M12 13v4"/></svg>`;
const DL_ICON_PHONE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="3" width="10" height="18" rx="2"/><line x1="10.5" y1="18" x2="13.5" y2="18"/></svg>`;
let lastDriveList = [];
let lastPhoneList = [];
function renderDriveList(drives) { if (Array.isArray(drives)) lastDriveList = drives; renderDevices(); }
// Home Devices list — all removable drives AND any connected phone, pick any.
function renderDevices() {
  const host = $('driveList'); if (!host) return;
  const drives = lastDriveList || []; const phones = lastPhoneList || [];
  const pbSrc = (cfg && cfg.phoneBackupSource) || '';   // wireless NAS backup folder
  if (!drives.length && !phones.length && !pbSrc) {
    host.innerHTML = `<p class="section-label">Devices</p><div class="dl-empty"><span class="dl-empty-dot"></span><span class="muted small">No card or phone detected. Plug one in — it shows up here automatically — or use “Choose drive…” to pick a folder.</span>
      <button type="button" class="btn ghost" id="pbSetup" style="margin-top:8px">☁ Set up wireless phone backup</button></div>`;
    const su = host.querySelector('#pbSetup');
    if (su) su.addEventListener('click', pickPhoneBackupFolder);
    return;
  }
  const pbCard = pbSrc ? `<button type="button" class="settings-card action dl-card" data-kind="pbfolder">
      <span class="sc-icon accent">${DL_ICON_PHONE}</span>
      <span class="sc-text"><span class="sc-title">Phone backup folder</span><span class="sc-sub">${escapeHtml(pbSrc)} · wireless upload</span></span>
      <span class="sc-chevron">›</span>
    </button>` : '';
  const phoneCards = phones.map((p, i) => `<button type="button" class="settings-card action dl-card" data-kind="phone" data-i="${i}">
      <span class="sc-icon accent">${DL_ICON_PHONE}</span>
      <span class="sc-text"><span class="sc-title">${escapeHtml(p.name || 'Phone')}</span><span class="sc-sub">${p.sim ? 'Simulated phone · photos + videos' : 'Phone · photos + videos (MTP)'}</span></span>
      <span class="sc-chevron">›</span>
    </button>`).join('');
  const driveCards = drives.map((d, i) => {
    const sub = [d.mountpoint, d.isCard ? 'SD card' : (d.isUSB ? 'USB' : 'Removable'), d.fs || d.filesystem || '', d.size ? fmtBytes(d.size) : ''].filter(Boolean).join('  ·  ');
    const active = state.drive && state.drive.mountpoint === d.mountpoint;
    return `<button type="button" class="settings-card action dl-card${active ? ' dl-active' : ''}" data-kind="drive" data-i="${i}">
      <span class="sc-icon accent">${d.isCard ? DL_ICON_CARD : DL_ICON_USB}</span>
      <span class="sc-text"><span class="sc-title">${escapeHtml(d.description || d.mountpoint || 'Removable drive')}</span><span class="sc-sub">${escapeHtml(sub)}</span></span>
      <span class="sc-chevron">${active ? '✓ selected' : '›'}</span>
    </button>`;
  }).join('');
  host.innerHTML = `<p class="section-label">Devices · ${drives.length + phones.length + (pbSrc ? 1 : 0)}</p>${phoneCards}${pbCard}${driveCards}`;
  host.querySelectorAll('.dl-card').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.kind === 'phone') openPhone(phones[Number(b.dataset.i)]);
    else if (b.dataset.kind === 'pbfolder') onDrive({ mountpoint: pbSrc, description: 'Phone backup folder' });
    else onDrive(drives[Number(b.dataset.i)]);
  }));
}
// Auto mode: pick a device and the app runs the whole backup itself (scan → pull →
// copy → background-analyze), stopping only for photo batching. NEVER deletes anything.
function autoMode() { return !!uiPrefs.autoMode; }
// The home-only chrome (Auto-mode bar + "footage to deal with" banner) must follow the
// device/action lists — shown on home, hidden inside the flow/phone/finalize screens.
// Called wherever actionList/driveList toggle. Null-safe so order of init doesn't matter.
function hideHomeExtras() { ['pendingWork', 'autoModeBar'].forEach((id) => { const el = $(id); if (el) el.classList.add('hidden'); }); }
function showHomeExtras() {
  const amb = $('autoModeBar'); if (amb) amb.classList.remove('hidden');
  const pw = $('pendingWork'); if (pw) pw.classList.toggle('hidden', !pw.innerHTML.trim());   // only if it has content
}

// "You've got footage to deal with" — a home banner surfaced on launch/return so work
// waiting in the Uncompressed intake (to compress) or the Compressed folder (ready to
// organize) is never forgotten. Clicking jumps straight into Organize & back up, where
// the AI analysis it already did is remembered per clip (nothing re-analyzes).
async function renderPendingWork() {
  const host = $('pendingWork'); if (!host) return;
  let w = {}; try { w = await window.api.pendingWork(); } catch { w = {}; }
  const ready = (w && w.ready) || 0;
  const uncompressed = (w && w.uncompressed) || 0;
  if (!ready && !uncompressed) { host.classList.add('hidden'); host.innerHTML = ''; return; }
  const analyzed = (w && w.readyAnalyzed) || 0;
  const readyLine = ready ? `<b>${ready}</b> clip${ready !== 1 ? 's' : ''} ready to organize${analyzed ? ` · ${analyzed} already analyzed` : ''}` : '';
  let uncLine = '';
  if (uncompressed) {
    uncLine = ready
      ? `<b>${uncompressed}</b> still in Uncompressed`
      : `<b>${uncompressed}</b> in Uncompressed — compress ${uncompressed !== 1 ? 'them' : 'it'}, then organize`;
  }
  const sub = [readyLine, uncLine].filter(Boolean).join(' &nbsp;·&nbsp; ');
  const cta = ready ? `Organize ${ready} ›` : 'Open Organize ›';
  host.innerHTML = `<button type="button" class="pw-card" id="pwGo">
      <span class="pw-ic keep-emoji">🎬</span>
      <span class="pw-tx"><span class="pw-title">You've got footage to deal with</span><span class="pw-sub">${sub}</span></span>
      <span class="pw-cta">${cta}</span>
    </button>`;
  host.classList.remove('hidden');
  const go = host.querySelector('#pwGo');
  if (go) go.addEventListener('click', () => openFinalize());
}

// Wireless workflow: remember the NAS folder a phone app (QNAP QuMagie/Qfile) uploads
// the camera roll into, so it's a one-tap source under Devices — no phone tethering.
async function pickPhoneBackupFolder() {
  let r = {}; try { r = await window.api.pickPhoneBackupFolder(); } catch { r = {}; }
  if (r && r.ok && r.path) {
    cfg.phoneBackupSource = r.path;
    showToast('Phone backup folder set — it now shows under Devices. Point QuMagie/Qfile at it on your phone.', 6000);
    refreshDriveList();
  }
}
function refreshDriveList() {
  Promise.all([window.api.listRemovable().catch(() => []), window.api.listPhones().catch(() => [])])
    .then(([d, p]) => { lastDriveList = d || []; lastPhoneList = p || []; renderDevices(); });
}

// Hotkey may report 0 or several drives (e.g. a multi-slot reader = D: + E:).
function onDriveOptions(drives) {
  renderDriveList(drives || []);   // keep the home device list in sync with detection
  if (!drives || drives.length === 0) {
    $('driveBanner').classList.remove('hidden');
    $('actionList').classList.remove('hidden'); $('driveList').classList.remove('hidden'); showHomeExtras();   // keep Organize reachable with no card
    $('flow').classList.add('hidden');
    $('driveTitle').textContent = 'Insert a card or connect a phone';
    $('driveSub').textContent = 'Your SD card / GoPro or phone shows up here automatically — or use “Choose drive…” to pick a folder.';
    $('statusLine').textContent = 'Waiting for a device';
    return;
  }
  // One or more drives → show them ALL in the home Devices list (rendered above) and
  // let the user pick — no auto-jump, so you always see every available drive.
  $('flow').classList.add('hidden');
  $('driveBanner').classList.add('hidden');
  $('actionList').classList.remove('hidden'); $('driveList').classList.remove('hidden'); showHomeExtras();
  const oldPicker = document.getElementById('drivePicker'); if (oldPicker) oldPicker.classList.add('hidden');
  $('statusLine').textContent = `${drives.length} device${drives.length > 1 ? 's' : ''} ready`;
}

// Manual drive pick (fallback / testing).
$('manualPickBtn').addEventListener('click', async () => {
  const drive = await window.api.pickDrive();
  if (drive) onDrive(drive);
});

function onDrive(drive) {
  state.drive = drive;
  // If a copy is running, jump straight to its progress instead of the home view.
  window.api.copyStatus().then((cs) => { if (cs && cs.active) { updateCopyChip(cs); goToCopyProgress(cs); } });
  $('statusLine').textContent = 'Drive detected';
  $('driveTitle').textContent = drive.description || 'Removable drive';
  const bits = [];
  if (drive.mountpoint) bits.push(drive.mountpoint);
  if (drive.isCard) bits.push('SD card');
  else if (drive.isUSB) bits.push('USB');
  if (drive.size) bits.push(fmtBytes(drive.size));
  $('driveSub').textContent = bits.join(' · ') || '—';

  const picker = document.getElementById('drivePicker');
  if (picker) picker.classList.add('hidden');

  $('driveBanner').classList.remove('hidden');
  $('actionList').classList.remove('hidden'); $('driveList').classList.remove('hidden'); showHomeExtras();
  $('flow').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Step navigation helpers
// ---------------------------------------------------------------------------
function setStep(n) {
  ['1', '2', '3'].forEach((s) => {
    const el = document.querySelector(`.step[data-step="${s}"]`);
    el.classList.toggle('active', s === String(n));
    el.classList.toggle('complete', Number(s) < n);
  });
  $('step1').classList.toggle('hidden', n !== 1);
  $('step2').classList.toggle('hidden', n !== 2);
  $('step3').classList.toggle('hidden', n !== 3);
  $('stepDone').classList.add('hidden');
}

function showDone(summary) {
  ['1', '2', '3'].forEach((s) => {
    document.querySelector(`.step[data-step="${s}"]`).classList.add('complete');
  });
  ['step1', 'step2', 'step3'].forEach((id) => $(id).classList.add('hidden'));
  $('doneSummary').textContent = summary;
  $('stepDone').classList.remove('hidden');
  // Replay the celebratory illustration each time we land here.
  const illo = $('doneIllo');
  if (illo) { illo.classList.remove('animate'); void illo.offsetWidth; illo.classList.add('animate'); }
}

// ---------------------------------------------------------------------------
// Start flow → scan the card, then Step 1 (rename)
// ---------------------------------------------------------------------------
$('startFlowBtn').addEventListener('click', startFlow);

// Reusable line-art illustrations (theme-aware via CSS classes) for empty/guide states.
const ILLO_CONNECT = `<svg viewBox="0 0 178 104" fill="none" aria-hidden="true">
  <path class="il-st" d="M36 30h22l8 8v36a5 5 0 0 1-5 5H36a5 5 0 0 1-5-5V35a5 5 0 0 1 5-5z"/>
  <line class="il-st il-thin" x1="42" y1="38" x2="42" y2="46"/><line class="il-st il-thin" x1="48" y1="38" x2="48" y2="46"/><line class="il-st il-thin" x1="54" y1="38" x2="54" y2="46"/>
  <rect class="il-st" x="112" y="18" width="38" height="68" rx="7"/>
  <rect class="il-acc-fill" x="118" y="27" width="26" height="42" rx="2"/>
  <line class="il-st" x1="125" y1="78" x2="137" y2="78"/>
  <path class="il-acc" d="M76 54h28" stroke-dasharray="2 7"><animate attributeName="stroke-dashoffset" values="18;0" dur="0.9s" repeatCount="indefinite"/></path>
</svg>`;
const ILLO_EMPTY = `<svg viewBox="0 0 168 116" fill="none" aria-hidden="true">
  <path class="il-st" d="M30 50a6 6 0 0 1 6-6h22l8 9h44a6 6 0 0 1 6 6v38a6 6 0 0 1-6 6H36a6 6 0 0 1-6-6z"/>
  <line class="il-st il-thin" x1="52" y1="74" x2="84" y2="74"/>
  <g><animateTransform attributeName="transform" type="translate" values="0 0;-6 5;0 0" dur="2.8s" repeatCount="indefinite"/>
    <circle class="il-acc" cx="118" cy="40" r="15"/>
    <line class="il-acc" x1="129" y1="51" x2="140" y2="62"/>
  </g>
</svg>`;
// Animated scanning — a media card with an accent scan-line sweeping across it
// (SMIL animate is reliable in Chromium and needs no transform-box gymnastics).
const ILLO_SCAN = `<svg viewBox="0 0 132 96" fill="none" aria-hidden="true">
  <rect class="il-st" x="22" y="22" width="88" height="52" rx="6"/>
  <circle class="il-st il-thin" cx="40" cy="38" r="4.5"/>
  <path class="il-st il-thin" d="M22 64l20-18 13 10 11-9 22 19"/>
  <line class="scan-line" x1="24" x2="108" y1="48" y2="48">
    <animate attributeName="y1" values="27;69;27" dur="1.6s" repeatCount="indefinite"/>
    <animate attributeName="y2" values="27;69;27" dur="1.6s" repeatCount="indefinite"/>
  </line>
</svg>`;
// AI looking at footage — a media frame + a sparkle.
const ILLO_AI = `<svg viewBox="0 0 172 118" fill="none" aria-hidden="true">
  <rect class="il-st" x="40" y="42" width="76" height="50" rx="6"/>
  <circle class="il-st il-thin" cx="57" cy="58" r="5"/>
  <path class="il-st il-thin" d="M40 84l20-18 14 11 10-8 32 25"/>
  <path class="il-spark" d="M132 22c1.6 9.4 4.6 12.4 14 14-9.4 1.6-12.4 4.6-14 14-1.6-9.4-4.6-12.4-14-14 9.4-1.6 12.4-4.6 14-14z"><animate attributeName="opacity" values="0.45;1;0.45" dur="2.2s" repeatCount="indefinite"/></path>
  <path class="il-spark2" d="M40 20l1.7 5 5 1.7-5 1.7L40 35.4l-1.7-5-5-1.7 5-1.7z"><animate attributeName="opacity" values="1;0.35;1" dur="1.7s" repeatCount="indefinite"/></path>
</svg>`;
// A clock + restore arrow (for the version-history empty state).
const ILLO_HISTORY = `<svg viewBox="0 0 108 100" fill="none" aria-hidden="true">
  <circle class="il-st" cx="54" cy="54" r="27"/>
  <path class="il-acc" d="M54 38v17l12 7"><animateTransform attributeName="transform" type="rotate" from="0 54 54" to="360 54 54" dur="8s" repeatCount="indefinite"/></path>
  <path class="il-acc" d="M30 34a30 30 0 0 1 6-6"/>
  <path class="il-acc" d="M27 26l9-1 0 9"/>
</svg>`;
// A lightbulb + sparkle (for the AI-memories empty state).
const ILLO_MEMORY = `<svg viewBox="0 0 96 100" fill="none" aria-hidden="true">
  <circle class="il-acc-fill" cx="46" cy="41" r="16"><animate attributeName="opacity" values="0.12;0.5;0.12" dur="2.4s" repeatCount="indefinite"/><animate attributeName="r" values="13;17;13" dur="2.4s" repeatCount="indefinite"/></circle>
  <path class="il-st" d="M46 20a21 21 0 0 1 13 37c-3 2.5-4 5-4 8H37c0-3-1-5.5-4-8a21 21 0 0 1 13-37z"/>
  <line class="il-st il-thin" x1="38" y1="72" x2="54" y2="72"/>
  <line class="il-st il-thin" x1="41" y1="78" x2="51" y2="78"/>
  <path class="il-spark2" d="M74 26l1.5 4.5 4.5 1.5-4.5 1.5L74 38l-1.5-4.5-4.5-1.5 4.5-1.5z"><animate attributeName="opacity" values="0.3;1;0.3" dur="1.8s" repeatCount="indefinite"/></path>
</svg>`;
// A face inside detection brackets (faces / face-scan tour step).
const ILLO_FACES = `<svg viewBox="0 0 112 100" fill="none" aria-hidden="true">
  <path class="il-acc" d="M26 32v-10h10M86 32v-10h-10M26 68v10h10M86 68v10h-10"><animate attributeName="opacity" values="0.5;1;0.5" dur="1.8s" repeatCount="indefinite"/></path>
  <circle class="il-st" cx="56" cy="50" r="22"/>
  <circle cx="49" cy="46" r="2.4" fill="var(--text-3)"/>
  <circle cx="63" cy="46" r="2.4" fill="var(--text-3)"/>
  <path class="il-st il-thin" d="M49 58q7 6 14 0"/>
  <line class="scan-line" x1="34" x2="78" y1="50" y2="50"><animate attributeName="y1" values="30;72;30" dur="2.2s" repeatCount="indefinite"/><animate attributeName="y2" values="30;72;30" dur="2.2s" repeatCount="indefinite"/></line>
</svg>`;
// A model chip with a download arrow (download-a-model tour step).
const ILLO_DOWNLOAD = `<svg viewBox="0 0 104 100" fill="none" aria-hidden="true">
  <rect class="il-st" x="32" y="18" width="40" height="40" rx="6"/>
  <circle class="il-st il-thin" cx="52" cy="38" r="7"/>
  <path class="il-st il-thin" d="M32 28h-7M79 28h-7M32 38h-7M79 38h-7M32 48h-7M79 48h-7"/>
  <path class="il-acc" d="M52 64v20m-10-10 10 10 10-10"><animateTransform attributeName="transform" type="translate" values="0 -3;0 4;0 -3" dur="1.4s" repeatCount="indefinite"/></path>
</svg>`;
// Footage filing into a folder (for the Organize / choose-folder state).
const ILLO_FILES = `<svg viewBox="0 0 176 122" fill="none" aria-hidden="true">
  <rect class="il-st il-thin" x="98" y="20" width="34" height="26" rx="3"/>
  <g><animateTransform attributeName="transform" type="translate" values="0 -4;0 8;0 -4" dur="2.1s" repeatCount="indefinite"/>
    <rect class="il-acc-fill" x="60" y="16" width="34" height="26" rx="3"/>
    <rect class="il-acc" x="60" y="16" width="34" height="26" rx="3"/>
    <path class="il-acc" d="M77 50v10m-5-5 5 5 5-5"/>
  </g>
  <path class="il-st" d="M30 66a6 6 0 0 1 6-6h24l8 9h48a6 6 0 0 1 6 6v30a6 6 0 0 1-6 6H36a6 6 0 0 1-6-6z"/>
</svg>`;
// A phone (for the phone-backup empty state).
const ILLO_PHONE = `<svg viewBox="0 0 150 124" fill="none" aria-hidden="true">
  <rect class="il-st" x="50" y="20" width="50" height="84" rx="9"/>
  <rect class="il-acc-fill" x="57" y="30" width="36" height="56" rx="3"/>
  <line class="il-st" x1="66" y1="95" x2="84" y2="95"/>
  <path class="il-acc" d="M75 6v9m-5-4 5-5 5 5"><animateTransform attributeName="transform" type="translate" values="0 4;0 -3;0 4" dur="1.4s" repeatCount="indefinite"/></path>
  <path class="il-spark2" d="M118 40l1.5 4.5 4.5 1.5-4.5 1.5L118 52l-1.5-4.5-4.5-1.5 4.5-1.5z"><animate attributeName="opacity" values="0.3;1;0.3" dur="1.7s" repeatCount="indefinite"/></path>
</svg>`;
// Compact per-device illustrations for the source picker — animated SD card
// (shimmering contacts) and USB stick (data pulse).
const ILLO_CARD = `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
  <path class="il-st" d="M22 14h13l9 9v24a3 3 0 0 1-3 3H22a3 3 0 0 1-3-3V17a3 3 0 0 1 3-3z"/>
  <line class="il-acc" x1="26" y1="20" x2="26" y2="27"><animate attributeName="opacity" values="0.25;1;0.25" dur="1.2s" repeatCount="indefinite"/></line>
  <line class="il-acc" x1="31" y1="20" x2="31" y2="27"><animate attributeName="opacity" values="0.25;1;0.25" dur="1.2s" begin="0.2s" repeatCount="indefinite"/></line>
  <line class="il-acc" x1="36" y1="20" x2="36" y2="27"><animate attributeName="opacity" values="0.25;1;0.25" dur="1.2s" begin="0.4s" repeatCount="indefinite"/></line>
  <line class="il-st il-thin" x1="26" y1="40" x2="40" y2="40"/>
</svg>`;
const ILLO_USB = `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
  <rect class="il-st" x="23" y="20" width="18" height="28" rx="3"/>
  <path class="il-st" d="M28 20v-6h8v6"/>
  <line class="il-st il-thin" x1="27" y1="44" x2="37" y2="44"/>
  <circle class="il-acc-fill" cx="32" cy="33" r="4"><animate attributeName="opacity" values="0.3;1;0.3" dur="1.4s" repeatCount="indefinite"/><animate attributeName="r" values="3;5;3" dur="1.4s" repeatCount="indefinite"/></circle>
</svg>`;
// ANIMATED — a project archive whose index is being scanned: a folder of entry
// rows with an accent highlight stepping down through them (the "indexing" feel).
const ILLO_PROJECTS = `<svg viewBox="0 0 140 100" fill="none" aria-hidden="true">
  <path class="il-st" d="M24 34a6 6 0 0 1 6-6h22l7 8h42a6 6 0 0 1 6 6v38a6 6 0 0 1-6 6H30a6 6 0 0 1-6-6z"/>
  <rect class="il-acc-fill" x="36" y="47" width="68" height="9" rx="2">
    <animate attributeName="y" values="47;58;69;47" dur="2.6s" repeatCount="indefinite"/>
    <animate attributeName="width" values="68;60;66;68" dur="2.6s" repeatCount="indefinite"/>
  </rect>
  <line class="il-st il-thin" x1="40" y1="51" x2="98" y2="51"/>
  <line class="il-st il-thin" x1="40" y1="62" x2="90" y2="62"/>
  <line class="il-st il-thin" x1="40" y1="73" x2="96" y2="73"/>
  <path class="il-spark2" d="M112 24l1.6 4.8 4.8 1.6-4.8 1.6L112 38l-1.6-4.8-4.8-1.6 4.8-1.6z"/>
</svg>`;
// ANIMATED — two clips linked into a project folder by a flowing dashed line + a
// pulsing dot at the folder (same-shoot: "these belong to that project").
const ILLO_LINK = `<svg viewBox="0 0 158 100" fill="none" aria-hidden="true">
  <rect class="il-st" x="20" y="28" width="36" height="24" rx="3"/>
  <rect class="il-st" x="20" y="50" width="36" height="24" rx="3"/>
  <path class="il-st il-thin" d="M20 70l9-8 6 5 5-4 16 12"/>
  <path class="il-st" d="M100 36a5 5 0 0 1 5-5h14l5 6h14a5 5 0 0 1 5 5v26a5 5 0 0 1-5 5h-33a5 5 0 0 1-5-5z"/>
  <path class="il-acc" d="M58 52h40" stroke-dasharray="2 6">
    <animate attributeName="stroke-dashoffset" values="16;0" dur="0.9s" repeatCount="indefinite"/>
  </path>
  <circle class="il-acc-fill" cx="98" cy="52" r="3.5">
    <animate attributeName="r" values="2.6;4.6;2.6" dur="1.3s" repeatCount="indefinite"/>
  </circle>
  <path class="il-spark2" d="M132 18l1.5 4.5 4.5 1.5-4.5 1.5L132 30l-1.5-4.5-4.5-1.5 4.5-1.5z"/>
</svg>`;
// ANIMATED — two differing name tags merging into one (batch-conflict resolver):
// dots travel down the converging arms to the merged tag.
const ILLO_MERGE = `<svg viewBox="0 0 150 96" fill="none" aria-hidden="true">
  <rect class="il-st" x="18" y="24" width="42" height="16" rx="4"/>
  <rect class="il-st" x="18" y="56" width="42" height="16" rx="4"/>
  <path class="il-acc" d="M60 32h18q10 0 10 10v2M60 64h18q10 0 10-10v-2"/>
  <path class="il-acc" d="M88 48h18"/>
  <rect class="il-acc-fill" x="106" y="40" width="26" height="16" rx="4"/>
  <circle class="il-acc-fill" cx="60" cy="32" r="3">
    <animate attributeName="cx" values="60;88;106" dur="1.5s" repeatCount="indefinite"/>
    <animate attributeName="cy" values="32;48;48" dur="1.5s" repeatCount="indefinite"/>
    <animate attributeName="opacity" values="1;1;0" dur="1.5s" repeatCount="indefinite"/>
  </circle>
  <circle class="il-acc-fill" cx="60" cy="64" r="3">
    <animate attributeName="cx" values="60;88;106" dur="1.5s" begin="0.4s" repeatCount="indefinite"/>
    <animate attributeName="cy" values="64;48;48" dur="1.5s" begin="0.4s" repeatCount="indefinite"/>
    <animate attributeName="opacity" values="1;1;0" dur="1.5s" begin="0.4s" repeatCount="indefinite"/>
  </circle>
</svg>`;
// ANIMATED — a hanging tag that gently swings + a twinkling sparkle (tags dialog).
const ILLO_TAGS = `<svg viewBox="0 0 124 96" fill="none" aria-hidden="true">
  <g><animateTransform attributeName="transform" type="rotate" values="-6 40 44;4 40 44;-6 40 44" dur="2.8s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.2 1;0.4 0 0.2 1" keyTimes="0;0.5;1"/>
    <path class="il-acc-fill" d="M40 26h38a6 6 0 0 1 6 6v18a6 6 0 0 1-6 6H40L24 44z"/>
    <path class="il-acc" d="M40 26h38a6 6 0 0 1 6 6v18a6 6 0 0 1-6 6H40L24 44z"/>
    <circle class="il-st" cx="40" cy="44" r="4.5"/>
    <line class="il-st il-thin" x1="56" y1="44" x2="74" y2="44"/>
  </g>
  <path class="il-spark2" d="M100 24l1.6 4.8 4.8 1.6-4.8 1.6L100 38l-1.6-4.8-4.8-1.6 4.8-1.6z"><animate attributeName="opacity" values="0.3;1;0.3" dur="1.8s" repeatCount="indefinite"/></path>
</svg>`;
// ANIMATED — two people (front in accent), with a check badge that draws itself in
// (a recognized person). For the face-setup + add-person dialogs.
const ILLO_PEOPLE = `<svg viewBox="0 0 132 96" fill="none" aria-hidden="true">
  <circle class="il-st" cx="46" cy="40" r="13"/>
  <path class="il-st" d="M28 74c0-12 8-19 18-19s18 7 18 19"/>
  <circle class="il-acc" cx="82" cy="44" r="15"/>
  <path class="il-acc" d="M60 84c0-14 10-23 22-23s22 9 22 23"/>
  <circle class="il-acc-fill" cx="104" cy="30" r="10"/>
  <path class="il-acc" d="M99 30l4 4 7-7" stroke-dasharray="16"><animate attributeName="stroke-dashoffset" values="16;16;0;0;16" keyTimes="0;0.2;0.5;0.85;1" dur="2.8s" repeatCount="indefinite"/></path>
</svg>`;
// ANIMATED — a large media card pulsing smaller into a compact one (compression),
// with the arrow flowing toward the compressed result. For the Finalize stage.
const ILLO_COMPRESS = `<svg viewBox="0 0 140 96" fill="none" aria-hidden="true">
  <rect class="il-st" x="20" y="24" width="48" height="48" rx="5">
    <animate attributeName="width" values="48;38;48" dur="2.2s" repeatCount="indefinite"/>
    <animate attributeName="height" values="48;38;48" dur="2.2s" repeatCount="indefinite"/>
    <animate attributeName="x" values="20;25;20" dur="2.2s" repeatCount="indefinite"/>
    <animate attributeName="y" values="24;29;24" dur="2.2s" repeatCount="indefinite"/>
  </rect>
  <path class="il-acc" d="M78 48h14m-5-5 5 5-5 5"><animateTransform attributeName="transform" type="translate" values="-3 0;3 0;-3 0" dur="1.3s" repeatCount="indefinite"/></path>
  <rect class="il-acc-fill" x="104" y="36" width="24" height="24" rx="4"/>
  <rect class="il-acc" x="104" y="36" width="24" height="24" rx="4"/>
</svg>`;
// ANIMATED — an AI "thinking" core: a breathing accent ring with three sequenced
// dots + twinkling sparkles. For the destination-map planning/grouping states.
const ILLO_THINKING = `<svg viewBox="0 0 120 96" fill="none" aria-hidden="true">
  <circle class="il-acc-fill" cx="60" cy="48" r="17"><animate attributeName="r" values="14;18;14" dur="2.2s" repeatCount="indefinite"/></circle>
  <circle class="il-acc" cx="60" cy="48" r="17"/>
  <circle cx="51" cy="48" r="2.8" fill="var(--accent)"><animate attributeName="opacity" values="0.2;1;0.2" dur="1.2s" repeatCount="indefinite"/></circle>
  <circle cx="60" cy="48" r="2.8" fill="var(--accent)"><animate attributeName="opacity" values="0.2;1;0.2" dur="1.2s" begin="0.2s" repeatCount="indefinite"/></circle>
  <circle cx="69" cy="48" r="2.8" fill="var(--accent)"><animate attributeName="opacity" values="0.2;1;0.2" dur="1.2s" begin="0.4s" repeatCount="indefinite"/></circle>
  <path class="il-spark2" d="M96 20l1.5 4.5 4.5 1.5-4.5 1.5L96 33l-1.5-4.5-4.5-1.5 4.5-1.5z"><animate attributeName="opacity" values="0.2;1;0.2" dur="1.7s" repeatCount="indefinite"/></path>
  <path class="il-spark2" d="M22 60l1.2 3.6 3.6 1.2-3.6 1.2L22 70l-1.2-3.6-3.6-1.2 3.6-1.2z"><animate attributeName="opacity" values="1;0.2;1" dur="2.1s" repeatCount="indefinite"/></path>
</svg>`;
// ANIMATED — a document whose lines are scanned by an accent highlight (pulling out
// rules) + a twinkling sparkle. For the Import notes / SOP dialog.
const ILLO_DOC = `<svg viewBox="0 0 116 104" fill="none" aria-hidden="true">
  <path class="il-st" d="M34 18h34l16 16v44a6 6 0 0 1-6 6H34a6 6 0 0 1-6-6V24a6 6 0 0 1 6-6z"/>
  <path class="il-st il-thin" d="M68 18v16h16"/>
  <rect class="il-acc-fill" x="38" y="46" width="40" height="8" rx="2"><animate attributeName="y" values="46;58;70;46" dur="2.6s" repeatCount="indefinite"/><animate attributeName="width" values="40;32;38;40" dur="2.6s" repeatCount="indefinite"/></rect>
  <line class="il-st il-thin" x1="40" y1="50" x2="74" y2="50"/>
  <line class="il-st il-thin" x1="40" y1="62" x2="70" y2="62"/>
  <line class="il-st il-thin" x1="40" y1="74" x2="72" y2="74"/>
  <path class="il-spark2" d="M96 26l1.5 4.5 4.5 1.5-4.5 1.5L96 39l-1.5-4.5-4.5-1.5 4.5-1.5z"><animate attributeName="opacity" values="0.3;1;0.3" dur="1.7s" repeatCount="indefinite"/></path>
</svg>`;
// ANIMATED — a speech bubble with three sequenced dots (the AI forming a question)
// that gently bobs, plus a sparkle. For the "Review AI questions" dialog.
const ILLO_ASK = `<svg viewBox="0 0 120 96" fill="none" aria-hidden="true">
  <g><animateTransform attributeName="transform" type="translate" values="0 -2;0 3;0 -2" dur="2.4s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.2 1;0.4 0 0.2 1" keyTimes="0;0.5;1"/>
    <path class="il-acc" d="M30 28h52a8 8 0 0 1 8 8v22a8 8 0 0 1-8 8H54l-13 12v-12h-11a8 8 0 0 1-8-8V36a8 8 0 0 1 8-8z"/>
    <circle cx="46" cy="47" r="3" fill="var(--accent)"><animate attributeName="opacity" values="0.25;1;0.25" dur="1.2s" repeatCount="indefinite"/></circle>
    <circle cx="58" cy="47" r="3" fill="var(--accent)"><animate attributeName="opacity" values="0.25;1;0.25" dur="1.2s" begin="0.2s" repeatCount="indefinite"/></circle>
    <circle cx="70" cy="47" r="3" fill="var(--accent)"><animate attributeName="opacity" values="0.25;1;0.25" dur="1.2s" begin="0.4s" repeatCount="indefinite"/></circle>
  </g>
  <path class="il-spark2" d="M98 20l1.5 4.5 4.5 1.5-4.5 1.5L98 33l-1.5-4.5-4.5-1.5 4.5-1.5z"><animate attributeName="opacity" values="0.3;1;0.3" dur="1.7s" repeatCount="indefinite"/></path>
</svg>`;

// Nothing plugged in → a friendly, premium "here's what to do" instead of a bare
// OS folder picker. Returns 'folder' (user wants to choose a folder) or null.
function noSourceDialog() {
  return new Promise((resolve) => {
    const ov = document.createElement('div'); ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal-card modal-form" style="width:min(460px,92vw);text-align:center">
      <div class="illo">${ILLO_CONNECT}</div>
      <h3>Plug in a card or phone to begin</h3>
      <p class="muted small" style="margin:2px auto 12px;max-width:380px">Insert your <b>SD card / GoPro</b> or connect your <b>phone</b> (choose “File transfer” on it) — it appears here automatically. Already have footage on disk? Point the app at a folder instead.</p>
      <div class="ns-tips">
        <div class="ns-tip"><span class="keep-emoji">💾</span> SD card / GoPro — insert it, then this updates on its own</div>
        <div class="ns-tip"><span class="keep-emoji">📱</span> Phone — connect via USB, tap “Allow / File transfer”</div>
      </div>
      <div class="modal-actions" style="justify-content:center"><button type="button" class="btn primary ns-folder">Choose a folder…</button><button type="button" class="btn ns-cancel">Close</button></div>
    </div>`;
    document.body.appendChild(ov);
    const close = (v) => { ov.remove(); resolve(v); };
    ov.querySelector('.ns-folder').addEventListener('click', () => close('folder'));
    ov.querySelector('.ns-cancel').addEventListener('click', () => close(null));
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(null); });
  });
}

// When both a phone and a card are connected, ask which to work with.
function chooseSource(drives, phones) {
  return new Promise((resolve) => {
    const ov = document.createElement('div'); ov.className = 'modal-overlay';
    const driveBtns = (drives || []).map((d, i) => {
      const sub = [d.mountpoint, d.isCard ? 'SD card' : (d.isUSB ? 'USB drive' : 'Removable'), d.size ? fmtBytes(d.size) : ''].filter(Boolean).join('  ·  ');
      return `<button type="button" class="src-card" data-kind="drive" data-i="${i}"><span class="src-illo">${d.isCard ? ILLO_CARD : ILLO_USB}</span><span class="src-meta"><span class="src-title">${escapeHtml(d.description || d.mountpoint || 'Removable drive')}</span><span class="src-sub muted small">${escapeHtml(sub)}</span></span><span class="src-chev">›</span></button>`;
    }).join('');
    const phoneBtn = `<button type="button" class="src-card" data-kind="phone"><span class="src-illo">${ILLO_PHONE}</span><span class="src-meta"><span class="src-title">${escapeHtml(phones[0].name)}</span><span class="src-sub muted small">${phones[0].sim ? 'Simulated phone · photos + videos' : 'Phone · photos + videos'}</span></span><span class="src-chev">›</span></button>`;
    ov.innerHTML = `<div class="modal-card modal-form" style="width:min(480px,93vw);text-align:left">
      <div class="illo mob-illo">${ILLO_CONNECT}</div>
      <div class="ai-hd" style="margin-top:2px"><div class="ai-hd-text"><h3>What do you want to back up?</h3><p class="muted small">A phone and a drive are both connected — pick a source.</p></div></div>
      <div class="src-list">${phoneBtn}${driveBtns}</div>
      <div class="modal-actions"><button type="button" class="btn ghost src-cancel">Cancel</button></div>
    </div>`;
    document.body.appendChild(ov);
    const close = (v) => { ov.remove(); resolve(v); };
    ov.querySelectorAll('.src-card').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.kind === 'phone') close('phone');
      else close(drives[Number(b.dataset.i)]);
    }));
    ov.querySelector('.src-cancel').addEventListener('click', () => close(null));
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(null); });
  });
}

async function startFlow() {
  // A phone (real or simulated) is a valid SOURCE here — detect it in the background
  // so entering the rename flow with a phone plugged in just works.
  let phones = [];
  try { phones = await window.api.listPhones(); } catch { phones = []; }
  if (!state.drive) {
    const drives = await window.api.listRemovable();
    // No card but a phone is connected → go straight into the phone source.
    if ((!drives || !drives.length) && phones.length) { openPhone(); return; }
    // Both a phone and card(s) present → let the user pick the source.
    if (phones.length && drives && drives.length) {
      const pick = await chooseSource(drives, phones);
      if (pick === null) return;
      if (pick === 'phone') { openPhone(); return; }
      onDrive(pick);
    } else if (drives && drives.length === 1) onDrive(drives[0]);
    else if (!drives || !drives.length) {
      // Nothing plugged in — explain before popping a bare folder dialog (a new user
      // shouldn't wonder "why is it asking me to pick a folder?").
      const choice = await noSourceDialog();
      if (choice !== 'folder') return;
      const picked = await window.api.pickDrive();
      if (picked) onDrive(picked); else return;
    } else { const picked = await window.api.pickDrive(); if (picked) onDrive(picked); else return; }
  }
  $('finalize').classList.add('hidden');
  $('actionList').classList.add('hidden'); $('driveList').classList.add('hidden'); hideHomeExtras();
  $('driveBanner').classList.remove('hidden');
  $('flow').classList.remove('hidden');

  await refreshSubjectOptions();
  await refreshDescriptionOptions();
  await refreshLocationOptions();
  await refreshFields();
  buildCommandBarFields();

  // A copy is already running → jump straight to its progress.
  const cs = await window.api.copyStatus();
  if (cs && cs.active) { goToCopyProgress(cs); return; }

  // Keep existing rename work when re-entering the same card (don't re-scan,
  // so navigating away and back never loses what you've typed).
  if (state.scannedFiles.length && state.scannedDrive === state.drive.mountpoint) {
    setStep(1);
    buildRenameStep();
    return;
  }

  setStep(1);
  state.scannedFiles = [];
  state.copied = [];
  $('renameList').innerHTML = '';
  $('fileList').innerHTML = '';
  $('copyProgressWrap').classList.add('hidden');
  $('copyBar').style.width = '0%';
  $('renameDoneBtn').disabled = true;
  $('scanState').innerHTML = `<div class="scan-busy"><span class="illo scan-illo">${ILLO_SCAN}</span><p class="scan-busy-tx">Scanning the card for photos &amp; video…</p></div>`;
  $('scanState').classList.remove('hidden');

  const res = await window.api.scanVideos(state.drive.mountpoint);
  if (!res.ok) {
    $('scanState').textContent = `Scan failed: ${res.error}`;
    return;
  }
  // Seed each clip with the structured-naming fields. Date defaults to the file's
  // modified time (instant); refined from video metadata when its preview loads.
  state.scannedDrive = state.drive.mountpoint;
  state.scannedFiles = res.files.map((f) => {
    const clip = {
      ...f,
      origBase: f.name.slice(0, f.name.length - f.ext.length),
      // Prefer the capture date encoded in the filename (cameras name files this way)
      // over the file's mtime, which is unreliable on cards (copies/reformats reset it).
      // The per-clip preview can still refine this from ffprobe creation_time.
      date: phoneDateOf(f.name) || toDateStr(f.mtimeMs),
      subject: '',
      description: '',
      version: 1,
      selected: false,
      isPhoto: f.kind === 'photo',
      _imported: importedSet.has(importKey(f))   // seen in a previous import?
    };
    for (const fld of organizeFields) clip[fld.id] = '';
    return clip;
  });

  if (state.scannedFiles.length === 0) {
    // Don't dead-end — explain and offer a way forward.
    $('scanState').innerHTML = `<div class="scan-empty"><span class="illo scan-empty-illo">${ILLO_EMPTY}</span>
      <p class="scan-empty-tx">No photos or videos found on this drive.</p>
      <p class="muted small">It may be a different card, or the footage is in a subfolder this scan skipped.</p>
      <span class="scan-empty-actions"><button type="button" class="btn primary scan-pick">Choose another folder…</button><button type="button" class="btn scan-home">Back to home</button></span></div>`;
    $('scanState').classList.remove('hidden');
    const se = $('scanState');
    se.querySelector('.scan-pick').addEventListener('click', () => $('manualPickBtn').click());
    se.querySelector('.scan-home').addEventListener('click', goHome);
    return;
  }

  $('scanState').classList.add('hidden');

  // If you'd already named some of these clips in a previous run, ask whether to
  // restore that work before building the list (so restored values render in).
  const hadPrior = await maybeRestoreDrafts();
  // ALWAYS restore recognized people + the "faces scanned" flag (facts about the
  // footage, not naming you might want to discard) — so it remembers run-to-run and
  // never re-prompts to scan faces you already scanned.
  await applyPeopleFromDrafts();

  buildRenameStep();
  if (resumeJumpPending) { resumeJumpPending = false; setTimeout(() => jumpNextUnnamed(), 80); }
  if (!hadPrior) maybeOfferBatchStart();   // only offer "fresh batch" when there's no prior work
}
// Restore ONLY people + facesScanned from saved drafts, regardless of whether the
// user restored the naming draft. Keeps face tagging persistent across runs.
async function applyPeopleFromDrafts() {
  let drafts = {};
  try { drafts = await window.api.getDrafts(); } catch { return; }
  if (!drafts) return;
  for (const clip of state.scannedFiles) {
    const d = drafts[clipKey(clip)];
    if (!d) continue;
    if (Array.isArray(d.people) && d.people.length) clip.people = addUnique(clip.people, d.people);
    if (Array.isArray(d.peopleAuto) && d.peopleAuto.length) clip.peopleAuto = addUnique(clip.peopleAuto, d.peopleAuto);
    if (Array.isArray(d.tags) && d.tags.length) clip.tags = addUnique(clip.tags, d.tags);
    if (d.facesScanned) clip._facesScanned = true;
  }
}
// Fresh card with nothing named yet → offer to kick off the batch-naming workflow.
let batchStartOffered = false;
function maybeOfferBatchStart() {
  if (batchStartOffered) return;
  const clips = state.scannedFiles || [];
  if (clips.length < 3) return;
  if (clips.some((c) => (c.subject || '').trim())) return;   // already started naming
  batchStartOffered = true;
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card modal-form" style="width:min(460px,92vw);text-align:center">
    <div class="illo mob-illo">${ILLO_SCAN}</div>
    <h3>New footage — name it as a batch?</h3>
    <p class="muted small" style="margin:2px auto 12px;max-width:380px">${clips.length} fresh clips. Tip: tick the ones from the same shoot, give them one subject + a quick "what you're doing" note, and let the AI fill the rest.</p>
    <div class="modal-actions" style="justify-content:center"><button type="button" class="btn primary mob-batch">Start batch naming</button><button type="button" class="btn mob-tour">Show me how</button><button type="button" class="btn mob-skip">I'll do it myself</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('.mob-skip').addEventListener('click', close);
  ov.querySelector('.mob-batch').addEventListener('click', () => { close(); selectAllClips(true); showBatchDialog(); });
  ov.querySelector('.mob-tour').addEventListener('click', () => { close(); showWorkflowGuide(); });
}

$('cancelFlowBtn').addEventListener('click', () => {
  $('flow').classList.add('hidden');
  $('actionList').classList.remove('hidden'); $('driveList').classList.remove('hidden'); showHomeExtras();
});

// ---------------------------------------------------------------------------
// Structured naming:  yyyy-mm-dd_subject_description_v#
// ---------------------------------------------------------------------------
function slug(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // any run of non-alphanumerics → single hyphen
    .replace(/^-+|-+$/g, '');      // trim leading/trailing hyphens
}

function toDateStr(ms) {
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function isoToDateStr(iso) {
  let s = String(iso || '').trim();
  if (!s) return '';
  // QuickTime/ExifTool colon dates ("2024:12:04 05:00:00") → ISO-ish so Date parses.
  s = s.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
  // A naive datetime (no Z / no offset) is the CAPTURE-LOCAL time — parse it as local
  // (a bare space-separated string Chromium already treats as local). Strings WITH a
  // 'Z'/offset (e.g. ffprobe UTC creation_time) convert to the user's local date.
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : toDateStr(d.getTime());
}

// The name without version/extension, e.g. "2026-06-13_vlog_morning-hike".
function composeBase(clip) {
  const parts = [];
  if (clip.date) parts.push(clip.date);
  const subj = slug(clip.subject);
  const desc = slug(clip.description);
  if (subj) parts.push(subj);
  if (desc) parts.push(desc);
  // Never lose the clip's identity if nothing was typed yet.
  if (!subj && !desc) parts.push(slug(clip.origBase));
  return parts.join('_');
}
function finalStem(clip) { return `${composeBase(clip)}_v${clip.version}`; }
function finalName(clip) { return `${finalStem(clip)}${clip.ext}`; }

// Version = position among clips that share an identical base, in list order.
// Always present (the user chose "always _v#").
function recomputeVersions() {
  const counts = new Map();
  for (const clip of state.scannedFiles) {
    const base = composeBase(clip);
    const n = (counts.get(base) || 0) + 1;
    counts.set(base, n);
    clip.version = n;
  }
}

// ---------------------------------------------------------------------------
// Rename drafts — persist in-progress naming so it survives an app restart
// (not just in-session navigation). Keyed by a per-clip fingerprint (name+size)
// so it re-attaches even if the card mounts under a different drive letter.
// ---------------------------------------------------------------------------
function clipKey(clip) { return `${clip.name}__${clip.size}`; }

function buildDraftMap() {
  const map = {};
  for (const clip of state.scannedFiles) {
    // Only persist a date the user actually chose (dateLocked); metadata/mtime
    // dates re-derive on next scan, so they shouldn't count as a "draft".
    const d = {
      date: clip.dateLocked ? (clip.date || '') : '',
      subject: clip.subject || '',
      description: clip.description || '',
      location: clip.location || '',
      context: clip.context || '',
      shotType: clip.shotType || '',
      observation: clip.observation || '',
      people: Array.isArray(clip.people) ? clip.people : [],
      peopleAuto: Array.isArray(clip.peopleAuto) ? clip.peopleAuto : [],   // unconfirmed face guesses
      tags: Array.isArray(clip.tags) ? clip.tags : [],
      facesScanned: !!clip._facesScanned,
      ledgerRel: clip._ledgerRel || ''
    };
    for (const fld of organizeFields) d[fld.id] = clip[fld.id] || '';
    map[clipKey(clip)] = d;
  }
  return map;
}

let draftSaveTimer = null;
function scheduleDraftSave() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    if (state.scannedFiles.length) window.api.saveDrafts(buildDraftMap());
  }, 600);
}
// IMMEDIATE save — use after a discrete action (batch apply, an AI-named clip, a batch
// AI-context note) so a crash right after never loses that work. No 600ms window.
function flushDraftSave() {
  clearTimeout(draftSaveTimer);
  if (state.scannedFiles.length) window.api.saveDrafts(buildDraftMap());
}

// After a fresh scan, if saved drafts exist for these clips, ASK whether to
// restore them (auto-fill the fields) or start fresh — rather than silently
// repopulating. "Start fresh" drops the saved drafts for this card.
let resumeJumpPending = false;   // jump to the first unnamed clip after the list builds
// Returns TRUE if these clips have prior saved work (so the caller skips the
// "fresh footage" batch offer — restored or not, it isn't fresh).
async function maybeRestoreDrafts() {
  let drafts = {};
  try { drafts = await window.api.getDrafts(); } catch { drafts = {}; }
  if (!drafts) return false;
  const total = state.scannedFiles.length;
  const namedBefore = state.scannedFiles.filter((c) => { const d = drafts[clipKey(c)]; return d && (d.subject || '').trim(); }).length;
  const anyData = state.scannedFiles.some((c) => { const d = drafts[clipKey(c)]; return d && Object.entries(d).some(([k, v]) => k !== 'ts' && v); });
  if (!anyData) return false;   // no prior work for these clips → genuinely fresh footage
  const leftN = total - namedBefore;
  // Default: silently restore previous work and jump to where they left off — no
  // prompt. Turn off "Auto-restore previous naming" in View to be asked instead.
  if (uiPrefs.autoRestore !== false) {
    applyDraftsToClips(drafts);
    resumeJumpPending = leftN > 0;
    showToast(leftN > 0
      ? `Restored your naming (${namedBefore}/${total}) — jumping to the next unnamed clip`
      : `Restored your naming for all ${total} clips`, 4000);
    return true;
  }
  return await new Promise((resolve) => {
    const ov = document.createElement('div'); ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal-card modal-form" style="width:min(470px,92vw);text-align:center">
      <div class="illo mob-illo">${ILLO_SCAN}</div>
      <h3>Pick up where you left off?</h3>
      <p class="muted small" style="margin:2px auto 12px;max-width:390px">You named <b>${namedBefore} of ${total}</b> clip${total !== 1 ? 's' : ''} here before${leftN > 0 ? ` — <b>${leftN}</b> still need names` : ''}. Restore that work and keep going?</p>
      <div class="modal-actions" style="justify-content:center"><button type="button" class="btn primary mrd-resume">Restore &amp; continue</button><button type="button" class="btn mrd-fresh">Start fresh</button></div>
    </div>`;
    document.body.appendChild(ov);
    const finish = () => { ov.remove(); resolve(true); };   // prior work existed either way
    ov.querySelector('.mrd-resume').addEventListener('click', () => { applyDraftsToClips(drafts); resumeJumpPending = leftN > 0; finish(); });
    ov.querySelector('.mrd-fresh').addEventListener('click', finish);   // keep the draft; just don't apply now
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) finish(); });
  });
}

// Apply saved drafts onto the currently-loaded clips (by file fingerprint).
function applyDraftsToClips(drafts) {
  let n = 0;
  for (const clip of state.scannedFiles) {
    const d = drafts[clipKey(clip)];
    if (!d) continue;
    if (d.subject) clip.subject = d.subject;
    if (d.description) clip.description = d.description;
    if (d.date) { clip.date = d.date; clip.dateLocked = true; }
    if (d.location) clip.location = d.location;
    if (d.context) clip.context = d.context;
    if (d.shotType) clip.shotType = d.shotType;
    if (d.observation) clip.observation = d.observation;
    if (Array.isArray(d.people) && d.people.length) clip.people = addUnique(clip.people, d.people);
    if (Array.isArray(d.peopleAuto) && d.peopleAuto.length) clip.peopleAuto = addUnique(clip.peopleAuto, d.peopleAuto);
    if (Array.isArray(d.tags) && d.tags.length) clip.tags = addUnique(clip.tags, d.tags);
    if (d.facesScanned) clip._facesScanned = true;
    if (d.ledgerRel) clip._ledgerRel = d.ledgerRel;
    for (const fld of organizeFields) if (d[fld.id]) clip[fld.id] = d[fld.id];
    n += 1;
  }
  return n;
}

// On-demand restore (Edit → Restore previous naming…) — recovers saved names if
// the restore prompt was dismissed, without needing to re-scan/restart.
async function restoreDraftsNow() {
  if (!state.scannedFiles.length) { showToast('Open a card first'); return; }
  let drafts = {};
  try { drafts = await window.api.getDrafts(); } catch { /* none */ }
  const n = applyDraftsToClips(drafts || {});
  if (n) {
    syncRowInputs(state.scannedFiles.map((_, i) => i));
    refreshNames();
    showToast(`Restored naming for ${n} clip${n !== 1 ? 's' : ''} ✓`);
  } else showToast('No saved naming found for these clips');
}

// ---------------------------------------------------------------------------
// Version history / save points. A save point is a full snapshot of every clip's
// naming (the same map shape as a draft). One is captured automatically before
// each AI run (so the user can always go back to what they had), and manually via
// Edit → "Save point now". Roll back from Edit → "Version history…".
// ---------------------------------------------------------------------------
let versionsCache = [];
let appVersionStr = '';   // real app version (from main) for the About box
let routesCache = [];      // standing filing rules (subject → folder, by-day)
let clipObsCache = {};     // clipKey → { obs, ts } prior AI observations
function newVersionId() { return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`; }
function countNamedClips() { return state.scannedFiles.filter((c) => c.subject || c.description).length; }
function fmtAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24); if (d < 7) return `${d} day${d > 1 ? 's' : ''} ago`;
  return new Date(ts).toLocaleString();
}

// Capture the current naming of all clips as a restore point. Synchronously
// builds the snapshot first (so even a fire-and-forget call grabs pre-run state),
// then persists it. `auto` save points are silent.
async function saveVersionPoint(label, auto) {
  if (!state.scannedFiles.length) { if (!auto) showToast('Open a card first'); return null; }
  const entry = { id: newVersionId(), ts: Date.now(), label: label || 'Save point', auto: !!auto, count: countNamedClips(), map: buildDraftMap() };
  try { versionsCache = (await window.api.saveVersion(entry)) || versionsCache; } catch { /* keep going */ }
  if (!auto) showToast(`Saved a restore point · ${entry.count} named ✓`);
  return entry;
}

// Faithfully revert clips to a snapshot — sets each field EXACTLY (clearing ones
// that were empty in the snapshot), unlike the additive draft-restore.
function applyVersionToClips(map) {
  let n = 0;
  for (const clip of state.scannedFiles) {
    const d = map[clipKey(clip)];
    if (!d) continue;
    clip.subject = d.subject || '';
    clip.description = d.description || '';
    clip.location = d.location || '';
    clip.context = d.context || '';
    clip.shotType = d.shotType || '';
    clip.observation = d.observation || '';
    if (d.date) { clip.date = d.date; clip.dateLocked = true; } else { clip.dateLocked = false; }
    for (const fld of organizeFields) clip[fld.id] = d[fld.id] || '';
    n += 1;
  }
  return n;
}

async function restoreVersion(entry) {
  const ok = await confirmDialog('Restore this save point?',
    `Replaces the naming of the matching clips with “${entry.label}” (${fmtAgo(entry.ts)}). Your current naming is saved first, so you can undo this.`,
    'Restore', 'Cancel');
  if (!ok) return false;
  await saveVersionPoint('Before restore', true);   // make the restore itself undoable
  const n = applyVersionToClips(entry.map || {});
  if (n) {
    syncRowInputs(state.scannedFiles.map((_, i) => i));
    refreshNames();
    scheduleDraftSave();
  }
  showToast(n ? `Restored ${n} clip${n !== 1 ? 's' : ''} ✓` : 'No matching clips on this card');
  return true;
}

function showVersionHistory() {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card modal-form vh-card">
    <h3>Version history</h3>
    <p class="muted small">Save points you can roll back to. One is saved automatically before every AI run.</p>
    <div class="vh-top">
      <button type="button" class="btn primary vh-save">Save point now</button>
      <button type="button" class="btn ghost vh-clear">Clear all</button>
    </div>
    <ul class="vh-list"></ul>
    <div class="modal-actions"><button type="button" class="btn vh-done">Done</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('.vh-done').addEventListener('click', close);

  function render() {
    const list = ov.querySelector('.vh-list');
    if (!versionsCache.length) { list.innerHTML = `<li class="dlg-empty"><span class="illo">${ILLO_HISTORY}</span><p class="dlg-empty-tx">No save points yet</p><p class="muted small">A snapshot is saved before each AI run — restore any naming you change your mind about.</p></li>`; return; }
    list.innerHTML = '';
    for (const v of versionsCache) {
      const li = document.createElement('li');
      li.className = 'vh-item';
      const badge = v.auto ? '<span class="vh-badge auto">before AI</span>' : '<span class="vh-badge manual">saved</span>';
      li.innerHTML = `<div class="vh-meta">
          <div class="vh-label">${escapeHtml(v.label)} ${badge}</div>
          <div class="vh-sub muted small">${escapeHtml(fmtAgo(v.ts))} · ${v.count} named</div>
        </div>
        <div class="vh-btns">
          <button type="button" class="btn primary vh-restore">Restore</button>
          <button type="button" class="btn ghost vh-del" title="Delete">✕</button>
        </div>`;
      li.querySelector('.vh-restore').addEventListener('click', async () => { if (await restoreVersion(v)) render(); });
      li.querySelector('.vh-del').addEventListener('click', async () => { try { versionsCache = (await window.api.deleteVersion(v.id)) || []; } catch { /* ignore */ } render(); });
      list.appendChild(li);
    }
  }
  ov.querySelector('.vh-save').addEventListener('click', async () => { await saveVersionPoint('Manual save point', false); render(); });
  ov.querySelector('.vh-clear').addEventListener('click', async () => {
    if (await confirmDialog('Clear all save points?', 'This deletes every save point. It can\'t be undone.', 'Clear all', 'Cancel')) {
      try { versionsCache = (await window.api.clearVersions()) || []; } catch { /* ignore */ }
      render();
    }
  });
  render();
}

