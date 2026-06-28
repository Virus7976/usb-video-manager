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
  $('actionList').classList.remove('hidden'); $('driveList').classList.remove('hidden');

  // A drive being detected refreshes the home Devices list (you pick from it) rather
  // than auto-jumping, so you always see every available drive.
  window.api.onDriveDetected(() => refreshDriveList());
  window.api.onDriveOptions((drives) => onDriveOptions(drives));
  refreshDriveList();   // populate the device list at startup

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
  if (!drives.length && !phones.length) {
    host.innerHTML = `<p class="section-label">Devices</p><div class="dl-empty"><span class="dl-empty-dot"></span><span class="muted small">No card or phone detected. Plug one in — it shows up here automatically — or use “Choose drive…” to pick a folder.</span></div>`;
    return;
  }
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
  host.innerHTML = `<p class="section-label">Devices · ${drives.length + phones.length}</p>${phoneCards}${driveCards}`;
  host.querySelectorAll('.dl-card').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.kind === 'phone') openPhone(phones[Number(b.dataset.i)]);
    else onDrive(drives[Number(b.dataset.i)]);
  }));
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
    $('actionList').classList.remove('hidden'); $('driveList').classList.remove('hidden');   // keep Organize reachable with no card
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
  $('actionList').classList.remove('hidden'); $('driveList').classList.remove('hidden');
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
  $('actionList').classList.remove('hidden'); $('driveList').classList.remove('hidden');
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
  $('actionList').classList.add('hidden'); $('driveList').classList.add('hidden');
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
    if (Array.isArray(d.people) && d.people.length) clip.people = [...new Set([...(clip.people || []), ...d.people])];
    if (Array.isArray(d.tags) && d.tags.length) clip.tags = [...new Set([...(clip.tags || []), ...d.tags])];
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
  $('actionList').classList.remove('hidden'); $('driveList').classList.remove('hidden');
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
    if (Array.isArray(d.people) && d.people.length) clip.people = [...new Set([...(clip.people || []), ...d.people])];
    if (Array.isArray(d.tags) && d.tags.length) clip.tags = [...new Set([...(clip.tags || []), ...d.tags])];
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

// ---------------------------------------------------------------------------
// Subject history — a custom Fluent combobox (the native <datalist> dropdown
// can't be themed). The list is cached and a styled flyout filters as you type.
// ---------------------------------------------------------------------------
let subjectsCache = [];
let descriptionsCache = [];
let locationsCache = [];
async function refreshSubjectOptions() {
  subjectsCache = await window.api.getSubjects();
}
async function refreshLocationOptions() {
  locationsCache = (await window.api.getLocations()) || [];
}
async function rememberLocation(value) {
  const s = slug(value);
  if (!s) return;
  if (!locationsCache.includes(s)) locationsCache = [...locationsCache, s];
  await window.api.addLocation(s);
  await refreshLocationOptions();
}
async function refreshDescriptionOptions() {
  descriptionsCache = await window.api.getDescriptions();
}
// Load the custom organizing fields + their remembered values.
async function refreshFields() {
  const list = await window.api.getFields();
  if (Array.isArray(list) && list.length) organizeFields = list;
  fieldHistoryCache = (await window.api.getFieldHistory()) || {};
}
async function rememberSubject(value) {
  const s = slug(value);
  if (!s) return;
  if (!subjectsCache.includes(s)) subjectsCache = [...subjectsCache, s]; // instant
  await window.api.addSubject(s);
  await refreshSubjectOptions();
}
// Remember a value for a custom organizing field (optimistic cache + persist).
async function rememberField(fieldId, value) {
  const s = slug(value);
  if (!s) return;
  if (!Array.isArray(fieldHistoryCache[fieldId])) fieldHistoryCache[fieldId] = [];
  if (!fieldHistoryCache[fieldId].includes(s)) fieldHistoryCache[fieldId] = [...fieldHistoryCache[fieldId], s];
  await window.api.addFieldHistory(fieldId, s);
}

// Generic Fluent combobox: a filtered dropdown flyout + grey inline ghost-text
// completion (accept with Enter → focus the next field, or → / End to fill).
//   getList()  → suggestion array (subjects or descriptions, "smart indexed")
//   getNext()  → field to focus when Enter accepts (or null)
// Fuzzy score of a query against a candidate (higher = closer; -Infinity = no
// match). Rewards prefix / word-boundary / contiguous / consecutive hits, and a
// subsequence match (typed chars appear in order) so it tolerates gaps & typos
// of the "skipped a letter" kind — all local, instant, no model needed.
// NOTE: uniquely named — a SECOND `fuzzyScore(text,q)` exists for the command palette
// and was silently overriding this one (JS hoisting), which broke autocomplete
// filtering (every suggestion showed for any query; Enter grabbed a random one).
function comboFuzzyScore(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t === q) return 1e6;
  const sub = t.indexOf(q);
  if (sub !== -1) {                                   // contiguous substring
    let s = 1000 - sub * 3 - (t.length - q.length);
    if (sub === 0) s += 600;                          // prefix
    else if (t[sub - 1] === '-' || t[sub - 1] === ' ') s += 300; // word start
    return s;
  }
  let qi = 0; let prev = -2; let s = 0;               // subsequence
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      s += 1;
      if (ti === prev + 1) s += 4;                    // consecutive run
      if (ti === 0 || t[ti - 1] === '-' || t[ti - 1] === ' ') s += 6; // word start
      prev = ti; qi += 1;
    }
  }
  if (qi < q.length) return -Infinity;                // not even a subsequence
  return s - (t.length - q.length) * 0.3;
}
// Rank a list by closeness to the query (closest first); empty query keeps the
// caller's order (e.g. most-used descriptions first).
function rankMatches(list, query) {
  const q = (query || '').trim();
  if (!q) return list.slice(0, 50);
  return list
    .map((s) => ({ s, score: comboFuzzyScore(q, s) }))
    .filter((x) => x.score > -Infinity)
    .sort((a, b) => b.score - a.score || a.s.length - b.s.length)
    .map((x) => x.s)
    .slice(0, 50);
}

function openComboFlyout(input, list) {
  const matches = rankMatches(list, input.value).slice(0, 10);   // keep the list short & snappy
  if (!matches.length) { if (openPopover && openPopover._comboInput === input) closePopover(); return; }
  const menu = document.createElement('div');
  menu.className = 'flyout dropdown-menu subject-combo';
  const items = [];
  matches.forEach((s, i) => {
    const item = document.createElement('button');
    item.className = 'flyout-item';
    item.dataset.value = s;
    item.innerHTML = `<span class="flyout-label">${escapeHtml(s)}</span>`;
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      input.value = s;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      closePopover();
    });
    item.addEventListener('mouseenter', () => { setComboHighlight(menu, i); });
    items.push(item);
    menu.appendChild(item);
  });
  menu._comboInput = input;
  menu._items = items;
  menu._highlight = -1;
  menu._navigated = false;   // true only once the user ARROW-keys into the list
  showPopover(input, menu, { matchWidth: true });
}

// Highlight a flyout item by index (for keyboard / hover selection).
function setComboHighlight(menu, idx) {
  const items = menu._items || [];
  menu._highlight = idx;
  items.forEach((it, i) => it.classList.toggle('combo-active', i === idx));
}
function moveComboHighlight(menu, delta) {
  const items = menu._items || [];
  if (!items.length) return;
  let idx = (menu._highlight == null ? -1 : menu._highlight) + delta;
  if (idx < 0) idx = items.length - 1;
  if (idx >= items.length) idx = 0;
  setComboHighlight(menu, idx);
  menu._navigated = true;   // keyboard navigation → Enter may accept the highlight
  items[idx].scrollIntoView({ block: 'nearest' });
}

function attachCombo(input, getList, getNext) {
  let wrap = input.parentElement;
  let ghost;
  if (!wrap.classList.contains('combo-wrap')) {
    wrap = document.createElement('span');
    wrap.className = 'combo-wrap';
    input.replaceWith(wrap);
    wrap.appendChild(input);
    ghost = document.createElement('span');
    ghost.className = 'combo-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    wrap.appendChild(ghost);
  } else {
    ghost = wrap.querySelector('.combo-ghost');
  }

  function topMatch() {
    const raw = input.value;
    if (!raw) return '';
    const lower = raw.toLowerCase();
    return getList().find((s) => s.toLowerCase().startsWith(lower) && s.length > raw.length) || '';
  }
  function updateGhost() {
    const raw = input.value;
    const m = topMatch();
    ghost.dataset.match = m;
    if (m) ghost.innerHTML = `<span class="combo-typed">${escapeHtml(raw)}</span>${escapeHtml(m.slice(raw.length))}`;
    else ghost.innerHTML = '';
  }

  input.addEventListener('focus', () => { openComboFlyout(input, getList()); updateGhost(); });
  input.addEventListener('click', () => openComboFlyout(input, getList()));
  input.addEventListener('input', () => { openComboFlyout(input, getList()); updateGhost(); });
  input.addEventListener('blur', () => { ghost.innerHTML = ''; ghost.dataset.match = ''; });
  input.addEventListener('keydown', (e) => {
    const m = ghost.dataset.match;
    const flyout = (openPopover && openPopover._comboInput === input) ? openPopover : null;

    // Space → hyphen: names slug spaces to '-', so show it live as you type.
    if (e.key === ' ') { e.preventDefault(); insertTextAtCursor(input, '-'); return; }

    // Up/Down arrows navigate the suggestion list.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!flyout) openComboFlyout(input, getList());
      const fly = (openPopover && openPopover._comboInput === input) ? openPopover : null;
      if (fly) moveComboHighlight(fly, e.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      // Are we actively scrolling the suggestion list with the KEYBOARD? (A mouse
      // hover also highlights a row, but Enter must NOT grab that — you typed a value
      // and want to keep it, e.g. "vlog" shouldn't become whatever's under the cursor.)
      const navigating = !!(flyout && flyout._navigated && flyout._highlight >= 0 && flyout._items[flyout._highlight]);
      const advance = () => {
        ghost.innerHTML = ''; ghost.dataset.match = '';
        closePopover();
        const next = getNext && getNext();
        if (next) next.focus(); else input.blur();
      };

      if (e.shiftKey) {
        if (navigating) {
          // Scrolling suggestions → take the highlighted one and come back to THIS
          // field (don't move to the next field).
          input.value = flyout._items[flyout._highlight].dataset.value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          ghost.innerHTML = ''; ghost.dataset.match = '';
          closePopover();
          input.focus();
          try { const p = input.value.length; input.setSelectionRange(p, p); } catch { /* ignore */ }
        } else {
          // Just typing → keep what's typed (ignore the suggestion) and advance.
          advance();
        }
        return;
      }

      // Plain Enter: accept the highlighted suggestion or ghost-text, then advance.
      if (navigating) {
        input.value = flyout._items[flyout._highlight].dataset.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (m) {
        input.value = m;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      advance();
    } else if ((e.key === 'ArrowRight' || e.key === 'End') && m
               && input.selectionStart === input.value.length) {
      e.preventDefault();
      input.value = m;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      updateGhost();
    }
  });
}

// Same-row field lookup (works inside a clip card OR the command/batch bar).
function finRowOf(input) { return input.closest('.rename-card') || input.closest('.batch-bar'); }
function sameRowField(input, sel) { const r = finRowOf(input); return r ? r.querySelector(sel) : null; }
function nextDescField(input) { return sameRowField(input, '.f-desc'); }
// Advance to a field on the NEXT clip card (scrolling it into view) — so you can
// rip through the list without the mouse. Returns null on the batch bar / last clip.
function nextClipField(input, sel) {
  const card = input.closest('.rename-card');
  if (!card) return null;
  const i = Number(card.dataset.i);
  const nextCard = document.querySelector(`.rename-card[data-i="${i + 1}"]`);
  if (!nextCard) return null;
  nextCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return nextCard.querySelector(sel);
}
// Meta (Category/Project) fields are visible only when shown AND not hidden by the
// clean-grid mode — otherwise Enter-flow must skip straight to the next clip.
function metaRowVisible() { return uiPrefs.showMetaRow && uiPrefs.cleanGrid === false; }

// Enter on DESCRIPTION:
//   'columns' (default) → next clip's subject  (sweep subjects/descriptions, then
//                          do categories/projects in a second pass)
//   'row'              → category on the SAME row (fill each clip fully)
function afterDescription(input) {
  // If the Location field is showing, Enter fills it next on the SAME row before
  // moving on (subject → description → location → …).
  if (uiPrefs.showLocation) {
    const loc = sameRowField(input, '.f-location');
    if (loc) return loc;
  }
  return afterLocation(input);
}
// Enter on LOCATION (or description when location is hidden): 'row' → meta fields
// on the same row; otherwise → the next clip's subject.
function afterLocation(input) {
  if (enterFlow === 'row' && metaRowVisible()) {
    return sameRowField(input, '.f-meta') || nextClipField(input, '.f-subject');
  }
  return nextClipField(input, '.f-subject');
}
// Enter on an organizing (meta) field → next meta field on the SAME row; after
// the last one: 'columns' → next clip's first meta field (continue the metadata
// pass), 'row' → next clip's subject (start the next clip fresh).
function metaFieldNext(input) {
  const row = finRowOf(input);
  const metas = row ? [...row.querySelectorAll('.f-meta')] : [];
  const idx = metas.indexOf(input);
  if (idx >= 0 && idx < metas.length - 1) return metas[idx + 1];
  return enterFlow === 'row'
    ? nextClipField(input, '.f-subject')
    : nextClipField(input, '.f-meta');
}

function attachSubjectCombo(input) {
  attachCombo(input, () => subjectsCache, () => nextDescField(input));
}
function attachDescriptionCombo(input) {
  attachCombo(input, () => descriptionsCache, () => afterDescription(input));
}
function attachLocationCombo(input) {
  attachCombo(input, () => locationsCache, () => afterLocation(input));
}
function attachFieldCombo(input, fieldId) {
  attachCombo(input, () => fieldHistoryCache[fieldId] || [], () => metaFieldNext(input));
}

// ---------------------------------------------------------------------------
// Step 1 — name the clips. Each row has date/subject/description fields and a
// scrubbable FFmpeg-frame preview (works for HEVC). Previews + metadata load
// lazily (IntersectionObserver) so 100s of clips don't all probe up front.
// ---------------------------------------------------------------------------
let previewObserver = null;

// Gentle, dismissable tips that teach the speed features a newcomer wouldn't find on
// their own. Rotates one per visit so they all get seen; "Got it" hides them for good.
const RENAME_TIPS = [
  'Press <b>Enter</b> in a field to jump to the next clip — name a whole card without touching the mouse.',
  '<b>Shift-click</b> two clips to select everything between them, then name them together.',
  'Hover a date and click <b>Select all</b> to grab a whole day’s shoot at once.',
  'Let AI name them: tick clips → <b>Edit → AI → Analyze</b> and it names them from what it sees.'
];
function renderRenameTip() {
  const el = $('renameTip'); if (!el) return;
  let done = false; try { done = !!localStorage.getItem('renameTipDone'); } catch { /* ignore */ }
  if (done || !state.scannedFiles.length) { el.classList.add('hidden'); return; }
  let idx = 0; try { idx = Number(localStorage.getItem('renameTipIdx') || 0) % RENAME_TIPS.length; } catch { /* ignore */ }
  el.innerHTML = `<span class="rt-ic keep-emoji">💡</span><span class="rt-tx">${RENAME_TIPS[idx]}</span><button type="button" class="rt-x" title="Don't show these tips again">Got it</button>`;
  el.classList.remove('hidden');
  el.querySelector('.rt-x').addEventListener('click', () => { try { localStorage.setItem('renameTipDone', '1'); } catch { /* ignore */ } el.classList.add('hidden'); });
  try { localStorage.setItem('renameTipIdx', String((idx + 1) % RENAME_TIPS.length)); } catch { /* ignore */ }
}

function buildRenameStep() {
  setStep(1);
  const listEl = $('renameList');
  listEl.innerHTML = '';
  const n = state.scannedFiles.length;
  const total = state.scannedFiles.reduce((s, f) => s + f.size, 0);
  $('renameCounter').textContent =
    `${n} clip${n > 1 ? 's' : ''} · ${fmtBytes(total)} total`;

  recomputeVersions();

  if (previewObserver) previewObserver.disconnect();
  previewObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const card = entry.target;
      previewObserver.unobserve(card);
      if (card.dataset.loaded) continue;
      card.dataset.loaded = '1';
      initPreview(Number(card.dataset.i));
    }
  }, { root: listEl, rootMargin: '500px' });

  const dayCounts = {};
  state.scannedFiles.forEach((c) => { const dk = c.date || ''; dayCounts[dk] = (dayCounts[dk] || 0) + 1; });
  let lastDay = null;
  for (let i = 0; i < n; i += 1) {
    const clip = state.scannedFiles[i];
    // Day dividers: a labelled split between clips shot on different days, so a
    // card's worth of footage is easy to batch-select. (Setting: View → Group by day.)
    if (uiPrefs.dayDividers !== false) {
      const day = clip.date || '';
      if (day !== lastDay) {
        const cnt = dayCounts[day] || 0;
        const div = document.createElement('div');
        div.className = 'day-divider';
        div.innerHTML = `<span class="day-divider-label">${escapeHtml(day || 'No date')}</span>
          <span class="day-divider-count">${cnt} clip${cnt !== 1 ? 's' : ''}</span>
          <button type="button" class="day-select" title="Select all ${cnt} clips from this day">Select all</button>`;
        div.querySelector('.day-select').addEventListener('click', () => selectDay(day));
        listEl.appendChild(div);
        lastDay = day;
      }
    }
    const card = document.createElement('div');
    card.className = 'rename-card' + (clip.selected ? ' selected' : '') + (clip._aiQ ? ' has-aiq' : '');
    card.dataset.i = i;
    card.innerHTML = `
      <input type="checkbox" class="clip-check" data-check="${i}" title="Select for batch naming — Shift-click another clip to select the whole range" ${clip.selected ? 'checked' : ''} />
      <div class="rename-preview${isPhotoClip(clip) ? ' is-photo' : ''}" data-preview="${i}">
        ${isPhotoClip(clip) ? mediaKindChip('photo') : ''}
        <div class="frame-wrap"><span class="placeholder">Scroll to preview…</span></div>
      </div>
      <div class="rename-fields">
        <span class="orig">${escapeHtml(clip.name)} · ${fmtBytes(clip.size)}</span>
        <div class="field-row">
          <button type="button" class="datefield" data-date="${i}" data-value="${escapeAttr(clip.date)}">
            <span class="df-text">${escapeHtml(clip.date || 'Date')}</span><span class="df-icon"></span>
          </button>
          <input type="text" class="f-subject" data-subject="${i}"
                 value="${escapeAttr(clip.subject)}" placeholder="subject" autocomplete="off" />
          <input type="text" class="f-desc" data-desc="${i}"
                 value="${escapeAttr(clip.description)}" placeholder="description" />
          <input type="text" class="f-location" data-location="${i}"
                 value="${escapeAttr(clip.location || '')}" placeholder="location" autocomplete="off" />
          <button class="btn ghost apply-row" data-apply="${i}"
                  title="Apply this name to all ticked clips (versions auto-number)">⤓</button>
        </div>
        <div class="meta-row">${organizeFields.map((fld) => `<input type="text" class="f-meta" data-field="${escapeAttr(fld.id)}" data-i="${i}" value="${escapeAttr(clip[fld.id] || '')}" placeholder="${escapeAttr(fld.label.toLowerCase())}" autocomplete="off" />`).join('')}</div>
        <div class="final-row">
          <div class="final-pill" data-final="${i}">${escapeHtml(finalName(clip))}</div>
        </div>
        <div class="clip-people" data-people="${i}">${peopleChipsHTML(clip, i)}</div>
        <div class="clip-tags" data-tags="${i}">${tagChipsHTML(clip, i)}</div>
      </div>`;
    listEl.appendChild(card);
    previewObserver.observe(card);
  }

  wireRowEditing(listEl);
  refreshNames();
  ensureClipFilterBar();
  applyClipFilter();
  // Remove a person chip from a clip (delegated).
  if (!listEl._peopleWired) {
    listEl._peopleWired = true;
    listEl.addEventListener('click', (e) => {
      const x = e.target.closest('.cpc-x');
      if (x) { e.stopPropagation(); const card = x.closest('.rename-card'); if (card) removePersonFromClip(Number(card.dataset.i), x.dataset.name); return; }
      const tx = e.target.closest('.ctc-x');
      if (tx) { e.stopPropagation(); removeTagFromClip(Number(tx.dataset.i), tx.dataset.tag); return; }
      const add = e.target.closest('.clip-tag-add');
      if (add) { e.stopPropagation(); showTagEditor(Number(add.dataset.tagadd)); return; }
      const view = e.target.closest('.clip-tag-auto');
      if (view) { e.stopPropagation(); showClipMetadata(Number(view.dataset.tagview)); return; }
    });
  }
  $('renameDoneBtn').disabled = false;
  renderRenameTip();
}

// Update every visible final-name pill + date input from current state.
function refreshNames() {
  recomputeVersions();
  // Query each element type ONCE (not per-clip), and only write the DOM when the value
  // actually changed — typing in one field used to re-write every clip's pill + date,
  // which got slow with a card full of clips.
  document.querySelectorAll('[data-final]').forEach((pill) => {
    const clip = state.scannedFiles[Number(pill.dataset.final)]; if (!clip) return;
    const name = finalName(clip);
    if (pill.textContent !== name) pill.textContent = name;
  });
  document.querySelectorAll('[data-date]').forEach((btn) => {
    const clip = state.scannedFiles[Number(btn.dataset.date)]; if (!clip) return;
    if ((btn.dataset.value || '') !== (clip.date || '')) setDateField(btn, clip.date);
  });
  updateBatchBar();
  updateProgress();
  scheduleDraftSave();
}

// People chips shown on a clip card (who's in the clip — from face tagging or
// added by hand). Each has an × to remove; add via the card's right-click → People.
function peopleChipsHTML(clip) {
  const ppl = Array.isArray(clip.people) ? clip.people.filter(Boolean) : [];
  if (!ppl.length) return '';
  return ppl.map((n) => `<span class="clip-person-chip">${escapeHtml(n)}<button type="button" class="cpc-x" data-name="${escapeAttr(n)}" title="Remove ${escapeAttr(n)}">×</button></span>`).join('');
}
// All the keyword tags that get embedded in the file at Finalize (mirrors main's
// buildEmbedTags) — so the user can SEE exactly what metadata will be written.
function clipEmbedKeywords(clip) {
  const fieldVals = organizeFields.map((f) => clip[f.id]).filter(Boolean);
  const date = clip.date || '';
  const year = /^(\d{4})/.test(date) ? date.slice(0, 4) : '';
  const words = [...new Set(`${clip.subject || ''} ${clip.description || ''} ${clip.location || ''}`.split(/[\s\-_]+/))].filter((w) => w && w.length > 1);
  const kws = [clip.subject, clip.location, clip.shotType, clip.category, clip.project, ...fieldVals, ...(clip.people || []), ...(clip.tags || []), date, year, ...words]
    .filter((k) => k && String(k).length > 1);
  return [...new Set(kws.map((k) => String(k)))];
}
// ---- Tags (digiKam-style) ---------------------------------------------------
// Custom keyword tags the user adds (on top of the auto keywords the AI derives
// from subject/description/people). Shown as chips on the card; embedded at Finalize.
function tagChipsHTML(clip, i) {
  const tags = Array.isArray(clip.tags) ? clip.tags.filter(Boolean) : [];
  const autoN = clipEmbedKeywords(clip).length;
  const userChips = tags.map((t) =>
    `<span class="clip-tag-chip"><span class="ctc-ic">🏷</span><span class="ctc-tx">${escapeHtml(t)}</span><button type="button" class="ctc-x" data-tag="${escapeAttr(t)}" data-i="${i}" title="Remove tag">×</button></span>`).join('');
  const add = `<button type="button" class="clip-tag-add" data-tagadd="${i}" title="Add tags (digiKam-style)"><span class="cta-plus">＋</span> Tag</button>`;
  const auto = autoN ? `<button type="button" class="clip-tag-auto" data-tagview="${i}" title="See all ${autoN} keyword tags that get embedded into the file">${autoN} auto</button>` : '';
  return `${userChips}${add}${auto}`;
}
function renderClipTags(i) {
  const host = document.querySelector(`.clip-tags[data-tags="${i}"]`);
  if (host) host.innerHTML = tagChipsHTML(state.scannedFiles[i], i);
}
function refreshAllClipTags() { (state.scannedFiles || []).forEach((c, i) => renderClipTags(i)); }
// Every distinct user tag across all clips — the shared pool digiKam-style pickers
// offer (so tags stay consistent instead of free-typed twenty different ways).
function allTagPool() {
  const set = new Set();
  (state.scannedFiles || []).forEach((c) => (Array.isArray(c.tags) ? c.tags : []).forEach((t) => t && set.add(t)));
  return [...set].sort((a, b) => a.localeCompare(b));
}
function addTagToClip(i, tag) {
  tag = String(tag || '').trim().replace(/\s+/g, ' ');
  if (!tag) return false;
  const c = state.scannedFiles[i]; if (!c) return false;
  const before = (c.tags || []).length;
  c.tags = [...new Set([...(c.tags || []), tag])];
  return c.tags.length !== before;
}
function removeTagFromClip(i, tag) {
  const c = state.scannedFiles[i]; if (!c || !Array.isArray(c.tags)) return;
  c.tags = c.tags.filter((t) => t !== tag);
  renderClipTags(i); scheduleDraftSave();
}
// digiKam-style tag panel: a checklist of the shared tag pool (check = on this clip),
// a type-to-add field with live autocomplete, and apply-to-selected. Fully local.
function showTagEditor(i) {
  const c = state.scannedFiles[i]; if (!c) return;
  if (!Array.isArray(c.tags)) c.tags = [];
  const selIdx = state.scannedFiles.map((cl, k) => (cl.selected ? k : -1)).filter((k) => k >= 0 && k !== i);
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card modal-form tag-editor" style="width:min(440px,94vw);text-align:left;max-height:88vh;display:flex;flex-direction:column">
    <div class="illo mob-illo">${ILLO_TAGS}</div>
    <div class="ai-hd" style="margin-top:2px"><div class="ai-hd-text"><h3>Tags</h3><p class="muted small">Type to add, or tick existing tags. Embedded into the file at Finalize — digiKam, Resolve &amp; Windows search read them.</p></div></div>
    <div class="te-input-row">
      <input type="text" class="ai-input te-input" placeholder="Enter tag here…" autocomplete="off" spellcheck="false" />
      <button type="button" class="btn primary te-add">Add</button>
    </div>
    <div class="te-current"></div>
    <div class="te-pool-head muted small">All tags <span class="te-pool-n"></span></div>
    <div class="te-pool"></div>
    ${selIdx.length ? `<label class="te-applysel"><input type="checkbox" class="te-applysel-cb" /> Also apply added tags to ${selIdx.length} other selected clip${selIdx.length !== 1 ? 's' : ''}</label>` : ''}
    <div class="modal-actions"><button type="button" class="btn primary te-done">Done</button></div>
  </div>`;
  document.body.appendChild(ov);
  const card = ov.querySelector('.tag-editor');
  const input = card.querySelector('.te-input');
  const close = () => ov.remove();
  const applySelCb = () => card.querySelector('.te-applysel-cb');
  const renderCurrent = () => {
    const cur = card.querySelector('.te-current');
    const tags = c.tags || [];
    cur.innerHTML = tags.length
      ? tags.map((t) => `<span class="te-chip"><span class="ctc-ic">🏷</span>${escapeHtml(t)}<button type="button" class="te-chip-x" data-tag="${escapeAttr(t)}">×</button></span>`).join('')
      : '<span class="muted small">No tags yet — add one above.</span>';
    cur.querySelectorAll('.te-chip-x').forEach((b) => b.addEventListener('click', () => { removeTagFromClip(i, b.dataset.tag); renderCurrent(); renderPool(); }));
  };
  const renderPool = () => {
    const pool = allTagPool();
    const host = card.querySelector('.te-pool');
    card.querySelector('.te-pool-n').textContent = pool.length;
    if (!pool.length) { host.innerHTML = '<span class="muted small">Your shared tag list builds up as you add tags.</span>'; return; }
    const on = new Set(c.tags || []);
    host.innerHTML = pool.map((t) => `<label class="te-pool-row"><input type="checkbox" class="te-pool-cb" data-tag="${escapeAttr(t)}" ${on.has(t) ? 'checked' : ''}/><span class="ctc-ic">🏷</span><span class="te-pool-tx">${escapeHtml(t)}</span></label>`).join('');
    host.querySelectorAll('.te-pool-cb').forEach((cb) => cb.addEventListener('change', () => {
      if (cb.checked) addTagToClip(i, cb.dataset.tag); else removeTagFromClip(i, cb.dataset.tag);
      renderClipTags(i); scheduleDraftSave(); renderCurrent();
    }));
  };
  const commitAdd = () => {
    const raw = input.value.trim();
    if (!raw) return;
    // Allow comma/semicolon-separated bulk add.
    const tags = raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    const targets = [i, ...(applySelCb() && applySelCb().checked ? selIdx : [])];
    for (const t of tags) for (const k of targets) addTagToClip(k, t);
    input.value = '';
    targets.forEach((k) => { renderClipTags(k); });
    scheduleDraftSave(); renderCurrent(); renderPool();
    input.focus();
  };
  card.querySelector('.te-add').addEventListener('click', commitAdd);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitAdd(); } });
  card.querySelector('.te-done').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  renderCurrent(); renderPool();
  setTimeout(() => input.focus(), 30);
}

function showClipMetadata(i) {
  const c = state.scannedFiles[i]; if (!c) return;
  const ppl = (c.people || []).filter(Boolean);
  const kws = clipEmbedKeywords(c);
  const deh = (s) => String(s || '').replace(/[-_]+/g, ' ').trim();
  const captionBits = [deh(c.subject), deh(c.description), c.shotType ? `${deh(c.shotType)} shot` : '', c.location ? `at ${deh(c.location)}` : '', c.date ? `on ${c.date}` : ''].filter(Boolean);
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  const chips = (arr, cls) => arr.length ? `<div class="md-chips">${arr.map((t) => `<span class="md-chip ${cls || ''}">${escapeHtml(t)}</span>`).join('')}</div>` : '<p class="muted small">—</p>';
  ov.innerHTML = `<div class="modal-card modal-form" style="width:min(540px,94vw);text-align:left;max-height:88vh;display:flex;flex-direction:column">
    <div class="ai-hd"><span class="ai-hd-icon keep-emoji">🏷️</span><div class="ai-hd-text"><h3>Metadata for this clip</h3><p class="muted small">Everything below is embedded into the file at Finalize — Resolve, digiKam, Bridge &amp; Windows search all read it.</p></div></div>
    <div style="overflow:auto">
      <div class="md-sec">People <span class="md-n">${ppl.length}</span></div>${chips(ppl, 'person')}
      <div class="md-sec">Caption</div><p class="md-cap">${escapeHtml(captionBits.join(', ') || '—')}</p>
      <div class="md-sec">Keywords <span class="md-n">${kws.length}</span></div>${chips(kws)}
      <div class="md-sec">Files into</div><p class="md-cap">${escapeHtml([c.category, c.project, c.subject].filter(Boolean).join(' / ') || 'unset')}</p>
    </div>
    <div class="modal-actions"><button type="button" class="btn md-close">Done</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('.md-close').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
}
function renderClipPeople(i) {
  const host = document.querySelector(`.clip-people[data-people="${i}"]`);
  if (host) host.innerHTML = peopleChipsHTML(state.scannedFiles[i]);
}
function refreshAllClipPeople() { (state.scannedFiles || []).forEach((c, i) => renderClipPeople(i)); }
function removePersonFromClip(i, name) {
  const c = state.scannedFiles[i]; if (!c || !Array.isArray(c.people)) return;
  c.people = c.people.filter((n) => n !== name);
  renderClipPeople(i); scheduleDraftSave(); applyClipFilter();
}
function addNameToClip(i, name) {
  name = String(name || '').trim(); if (!name) return;
  const c = state.scannedFiles[i]; if (!c) return;
  c.people = [...new Set([...(c.people || []), name])];
  rememberSubject && rememberSubject(name);
  renderClipPeople(i); scheduleDraftSave(); applyClipFilter();
}
// Small picker to tag a person on a clip — existing people (face-trained) + free text.
async function showAddPersonPicker(i) {
  let people = []; try { people = await window.api.getPeople(); } catch { people = []; }
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card modal-form" style="width:min(400px,92vw);text-align:left">
    <div class="illo mob-illo">${ILLO_PEOPLE}</div>
    <div class="ai-hd" style="margin-top:2px"><div class="ai-hd-text"><h3>Add person</h3><p class="muted small">Tag who's in this clip — written into the file's people metadata at Finalize.</p></div></div>
    <input type="text" class="ai-input pp-name" placeholder="Type a name…" autocomplete="off" />
    ${people.length ? `<div class="pp-existing">${people.map((p) => `<button type="button" class="pp-opt" data-name="${escapeAttr(p.name)}"><span class="people-thumb">${p.thumb ? `<img src="${p.thumb}"/>` : '<span class="face-ph-icon">🙂</span>'}</span><span>${escapeHtml(p.name)}</span></button>`).join('')}</div>` : ''}
    <div class="modal-actions"><button type="button" class="btn primary pp-add">Add</button><button type="button" class="btn pp-cancel">Cancel</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  const inp = ov.querySelector('.pp-name');
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('.pp-cancel').addEventListener('click', close);
  const add = (name) => { addNameToClip(i, name); close(); };
  ov.querySelector('.pp-add').addEventListener('click', () => add(inp.value));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(inp.value); } if (e.key === 'Escape') close(); });
  ov.querySelectorAll('.pp-opt').forEach((b) => b.addEventListener('click', () => add(b.dataset.name)));
  setTimeout(() => inp.focus(), 30);
}

// "This is someone else" — move a face to the right person (digiKam-style reassign).
async function showReassignFacePicker(fromId, index, onDone) {
  let people = []; try { people = await window.api.getPeople(); } catch { people = []; }
  const others = people.filter((p) => p.id !== fromId);
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card modal-form" style="width:min(400px,92vw);text-align:left">
    <div class="ai-hd"><span class="ai-hd-icon">⇄</span><div class="ai-hd-text"><h3>Who is this really?</h3><p class="muted small">Move this face to the right person — they'll learn from it. Type a new name or pick someone.</p></div></div>
    <input type="text" class="ai-input pp-name" placeholder="Type a name…" autocomplete="off" />
    ${others.length ? `<div class="pp-existing">${others.map((p) => `<button type="button" class="pp-opt" data-name="${escapeAttr(p.name)}"><span class="people-thumb">${p.thumb ? `<img src="${p.thumb}"/>` : '<span class="face-ph-icon">🙂</span>'}</span><span>${escapeHtml(p.name)}</span></button>`).join('')}</div>` : ''}
    <div class="modal-actions"><button type="button" class="btn primary pp-add">Move</button><button type="button" class="btn pp-cancel">Cancel</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  const inp = ov.querySelector('.pp-name');
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('.pp-cancel').addEventListener('click', close);
  const move = async (name) => {
    name = String(name || '').trim(); if (!name) return;
    const r = await window.api.reassignFace({ fromId, index, toName: name });
    close();
    if (r && r.ok) { rememberSubject && rememberSubject(name); showToast(`Moved to "${name}" ✓`); if (onDone) onDone(); } else showToast('Could not move that face');
  };
  ov.querySelector('.pp-add').addEventListener('click', () => move(inp.value));
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); move(inp.value); } if (e.key === 'Escape') close(); });
  ov.querySelectorAll('.pp-opt').forEach((b) => b.addEventListener('click', () => move(b.dataset.name)));
  setTimeout(() => inp.focus(), 30);
}

// ---------------------------------------------------------------------------
// Clip filter bar — quickly narrow a big batch by text or quick-filter chip.
// ---------------------------------------------------------------------------
let clipFilterText = '';
let clipFilterMode = 'all';   // all | unnamed | named | people | selected
function ensureClipFilterBar() {
  const list = $('renameList'); if (!list || document.getElementById('clipFilterBar')) return;
  const bar = document.createElement('div');
  bar.id = 'clipFilterBar';
  bar.className = 'clip-filter';
  bar.innerHTML = `<span class="cf-ic">⌕</span>
    <input type="text" class="cf-input" placeholder="Filter clips — name, subject, person…" spellcheck="false" />
    <div class="cf-chips">
      <button type="button" class="cf-chip active" data-f="all">All</button>
      <button type="button" class="cf-chip" data-f="unnamed">Unnamed</button>
      <button type="button" class="cf-chip" data-f="named">Named</button>
      <button type="button" class="cf-chip" data-f="people">People</button>
      <button type="button" class="cf-chip" data-f="selected">Selected</button>
    </div>
    <span class="cf-count muted small" id="clipFilterCount"></span>`;
  list.parentNode.insertBefore(bar, list);
  const input = bar.querySelector('.cf-input');
  input.value = clipFilterText;
  input.addEventListener('input', () => { clipFilterText = input.value; applyClipFilter(); });
  bar.querySelectorAll('.cf-chip').forEach((b) => b.addEventListener('click', () => {
    clipFilterMode = b.dataset.f;
    bar.querySelectorAll('.cf-chip').forEach((x) => x.classList.toggle('active', x === b));
    applyClipFilter();
  }));
}
function applyClipFilter() {
  const list = $('renameList'); if (!list) return;
  const q = (clipFilterText || '').trim().toLowerCase();
  let shown = 0; const total = state.scannedFiles.length;
  list.querySelectorAll('.rename-card').forEach((card) => {
    const i = Number(card.dataset.i); const c = state.scannedFiles[i]; if (!c) return;
    let ok = true;
    const named = !!(c.subject && c.subject.trim());
    if (clipFilterMode === 'unnamed') ok = !named;
    else if (clipFilterMode === 'named') ok = named;
    else if (clipFilterMode === 'people') ok = Array.isArray(c.people) && c.people.length > 0;
    else if (clipFilterMode === 'selected') ok = !!c.selected;
    if (ok && q) {
      const hay = [c.name, c.subject, c.description, c.location, c.date, ...(Array.isArray(c.people) ? c.people : []), ...(Array.isArray(c.tags) ? c.tags : [])].filter(Boolean).join(' ').toLowerCase();
      ok = hay.includes(q);
    }
    const disp = ok ? '' : 'none';
    if (card.style.display !== disp) card.style.display = disp;   // only write when it changes (avoids layout thrash)
    if (ok) shown += 1;
  });
  // Hide day dividers whose whole group is filtered out.
  let divider = null; let groupVisible = false;
  list.childNodes.forEach((el) => {
    if (el.nodeType !== 1) return;
    if (el.classList.contains('day-divider')) { if (divider) divider.style.display = groupVisible ? '' : 'none'; divider = el; groupVisible = false; }
    else if (el.classList.contains('rename-card') && el.style.display !== 'none') groupVisible = true;
  });
  if (divider) divider.style.display = groupVisible ? '' : 'none';
  const cnt = $('clipFilterCount');
  if (cnt) cnt.textContent = (q || clipFilterMode !== 'all') ? `${shown} of ${total}` : '';
}

// Anchor for shift-click range selection on the rename list.
let lastClipClickIndex = -1;
// Select every clip between two indices (inclusive) — used by shift-click and the
// "select between" hotkey. Updates state + checkboxes + card highlight.
function selectClipRange(a, b) {
  const lo = Math.min(a, b); const hi = Math.max(a, b);
  for (let j = lo; j <= hi; j += 1) {
    const clip = state.scannedFiles[j]; if (!clip) continue;
    clip.selected = true;
    const c = document.querySelector(`[data-check="${j}"]`); if (c) c.checked = true;
    const card = c && c.closest('.rename-card'); if (card) card.classList.add('selected');
  }
  updateBatchBar();
}
// One-click: select every clip shot on a given day (clips from one day are usually
// the same shoot — fastest path to batch-naming a card's worth of footage).
function selectDay(day) {
  let nSel = 0;
  state.scannedFiles.forEach((c, j) => {
    if ((c.date || '') !== day) return;
    c.selected = true; nSel += 1;
    const cb = document.querySelector(`[data-check="${j}"]`); if (cb) cb.checked = true;
    const card = cb && cb.closest('.rename-card'); if (card) card.classList.add('selected');
  });
  updateBatchBar();
  showToast(`Selected ${nSel} clip${nSel !== 1 ? 's' : ''} from ${day || 'no date'} ✓`, 2000);
}
// Hotkey: select everything between the first and last already-selected clips.
function selectBetweenSelected() {
  const sel = state.scannedFiles.map((c, i) => (c.selected ? i : -1)).filter((i) => i >= 0);
  if (sel.length < 1) { showToast('Tick at least one clip first, then press this to fill the range'); return; }
  const lo = sel[0]; const hi = sel[sel.length - 1];
  if (hi <= lo) { showToast('Tick a second clip further down to define a range'); return; }
  selectClipRange(lo, hi);
  showToast(`Selected ${hi - lo + 1} clips in between ✓`, 2200);
}

function wireRowEditing(listEl) {
  listEl.querySelectorAll('[data-date]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openPopover) { closePopover(); return; }
      const i = Number(btn.dataset.date);
      openCalendar(btn, state.scannedFiles[i].date, (ds) => {
        state.scannedFiles[i].date = ds;
        state.scannedFiles[i].dateLocked = true;   // user choice wins over metadata
        refreshNames();
      });
    });
  });
  listEl.querySelectorAll('[data-subject]').forEach((inp) => {
    inp.addEventListener('input', () => {
      state.scannedFiles[Number(inp.dataset.subject)].subject = inp.value;
      refreshNames();
    });
    inp.addEventListener('change', () => { recordAiEdit(state.scannedFiles[Number(inp.dataset.subject)], 'subject', inp.value); rememberSubject(inp.value); });
    wireEditPlay(inp, Number(inp.dataset.subject));
    attachSubjectCombo(inp);
  });
  listEl.querySelectorAll('[data-desc]').forEach((inp) => {
    inp.addEventListener('input', () => {
      state.scannedFiles[Number(inp.dataset.desc)].description = inp.value;
      refreshNames();
    });
    inp.addEventListener('change', () => { recordAiEdit(state.scannedFiles[Number(inp.dataset.desc)], 'description', inp.value); rememberDescription(inp.value); });
    wireEditPlay(inp, Number(inp.dataset.desc));
    attachDescriptionCombo(inp);
  });
  listEl.querySelectorAll('[data-location]').forEach((inp) => {
    inp.addEventListener('input', () => { state.scannedFiles[Number(inp.dataset.location)].location = inp.value; scheduleDraftSave(); });
    inp.addEventListener('change', () => rememberLocation(inp.value));
    attachLocationCombo(inp);
  });
  listEl.querySelectorAll('.meta-row [data-field]').forEach((inp) => {
    const fid = inp.dataset.field;
    inp.addEventListener('input', () => { state.scannedFiles[Number(inp.dataset.i)][fid] = inp.value; scheduleDraftSave(); });
    inp.addEventListener('change', () => rememberField(fid, inp.value));
    attachFieldCombo(inp, fid);
  });
  listEl.querySelectorAll('[data-check]').forEach((cb) => {
    // Shift-click a clip to select the whole RANGE between it and the last one you
    // clicked (like a file explorer) — fast way to grab a burst of similar shots.
    cb.addEventListener('click', (e) => {
      const i = Number(cb.dataset.check);
      if (e.shiftKey && lastClipClickIndex >= 0 && lastClipClickIndex !== i) {
        selectClipRange(lastClipClickIndex, i);
        showToast(`Selected ${Math.abs(i - lastClipClickIndex) + 1} clips`, 1800);
      }
      lastClipClickIndex = i;
    });
    cb.addEventListener('change', () => {
      const i = Number(cb.dataset.check);
      state.scannedFiles[i].selected = cb.checked;
      cb.closest('.rename-card').classList.toggle('selected', cb.checked);
      updateBatchBar();
      // Ticking a clip plays its preview right away so you can decide keep/skip
      // without having to click into a field first.
      if (cb.checked && activeMode !== 'audio') { playClip(i, 'edit'); maybePreview(i); }
    });
  });
  listEl.querySelectorAll('[data-apply]').forEach((btn) => {
    btn.addEventListener('click', () => applyRowNameToSelected(Number(btn.dataset.apply)));
  });
  // Record which clip's description field was right-clicked, so the context-menu
  // AI actions (Run on this clip / Leave feedback) can target it.
  listEl.querySelectorAll('[data-desc]').forEach((inp) => {
    inp.addEventListener('contextmenu', () => { aiFeedbackExample = inp.value || ''; aiCtxIndex = Number(inp.dataset.desc); });
  });
}

// ---------------------------------------------------------------------------
// Local AI suggestions (Ollama). Analyses a clip's frames and fills
// subject/description (+ optional category). mode 'all' overwrites, 'empty'
// only fills blank fields. Invoked from Edit → AI → Analyze selected clips.
// ---------------------------------------------------------------------------
let aiFeedbackExample = '';   // last right-clicked description (for AI feedback)
let aiCtxIndex = -1;          // last right-clicked clip index

// Background-task indicator in the rename footer ("N tasks running · <task> i/total").
const bgTasks = new Map();    // id -> { label, current, total, phase, detail, startedAt, baseCur, markAt, markCur }
function setTask(id, label, current, total, phase = '', detail = '') {
  const prev = bgTasks.get(id);
  // startedAt/baseCur: when we began tracking and at what count. markAt/markCur: the
  // time of the LAST item-boundary (= when the previous item finished). The rate is
  // measured only across COMPLETED items, frozen between boundaries — so a single slow
  // clip can't inflate the estimate while it's still running.
  const startedAt = prev ? prev.startedAt : Date.now();
  const baseCur = prev ? prev.baseCur : Math.max(0, (current || 1) - 1);
  let markAt = prev ? prev.markAt : Date.now();
  let markCur = prev ? prev.markCur : (current || 1);
  if (!prev || current !== prev.current) { markAt = Date.now(); markCur = current; }
  bgTasks.set(id, { label, current, total, phase, detail, startedAt, baseCur, markAt, markCur });
  renderTaskBar();
}
// Human "~Xs / ~Xm left" from a task's measured rate. Empty until we have a real sample.
function fmtEta(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 1) return 'almost done';
  if (s < 60) return `~${s}s left`;
  const m = Math.floor(s / 60); const r = s % 60;
  if (m < 60) return r >= 10 ? `~${m}m ${r}s left` : `~${m}m left`;
  const h = Math.floor(m / 60); return `~${h}h ${m % 60}m left`;
}
function etaText(t) {
  if (!t || !t.total || !t.startedAt || !t.markAt) return '';
  const completed = (t.current - 1) - (t.baseCur || 0);   // items finished since tracking began
  if (completed < 1) return '';                            // need ≥1 finished item to estimate
  const per = (t.markAt - t.startedAt) / completed;        // avg per item, frozen at last boundary
  if (!(per > 0)) return '';
  const remainingItems = Math.max(0, t.total - t.current); // items not yet started
  const onCurrent = Math.max(0, per - (Date.now() - t.markAt)); // time left on the in-progress clip (counts DOWN, floors at 0)
  return fmtEta(remainingItems * per + onCurrent);
}
function clearTask(id) { bgTasks.delete(id); if (id === 'ai') aiStageClose(); renderTaskBar(); }
let taskEtaTicker = null;
function primaryTask() { const e = [...bgTasks.entries()]; return e.length ? e[0] : null; }
// renderTaskBar keeps its name (called from everywhere) but now drives the small bubble.
function renderTaskBar() {
  const bub = $('taskBubble'); if (!bub) return;
  // Keep ETAs live even while a single long clip processes (re-render each second).
  if (bgTasks.size && !taskEtaTicker) taskEtaTicker = setInterval(() => { if (bgTasks.size) renderTaskBar(); else { clearInterval(taskEtaTicker); taskEtaTicker = null; } }, 1000);
  if (!bgTasks.size) { if (taskEtaTicker) { clearInterval(taskEtaTicker); taskEtaTicker = null; } bub.classList.add('hidden'); closeTaskPop(); theaterOpenWanted = false; closeTheater(); return; }
  bub.classList.remove('hidden');
  const n = bgTasks.size;
  $('taskBubbleCount').textContent = n;
  $('taskBubbleLbl').textContent = n === 1 ? 'task' : 'tasks';
  placeTaskChip();
  if (taskPopEl) renderTaskPop();
  if (theaterOpen()) renderTheater();
}
// The current screen's bottom action bar (Continue/Back, Copy, etc.). All screens use
// .row-actions; pick the one actually on screen right now.
function visibleActionBar() {
  for (const b of document.querySelectorAll('.row-actions')) if (b.offsetParent !== null) return b;
  return null;
}
// EMBED the task chip into that action bar (right-aligned) so it lives inside the
// "Continue · N clips" bar instead of floating over it. If the current screen has no
// action bar, fall back to a fixed bottom-right chip so it's still persistent.
function placeTaskChip() {
  const chip = document.getElementById('taskBubble'); if (!chip) return;
  const bar = visibleActionBar();
  if (bar) {
    if (chip.parentElement !== bar) bar.appendChild(chip);
    chip.classList.add('embedded');
  } else {
    if (chip.parentElement !== document.body) document.body.appendChild(chip);
    chip.classList.remove('embedded');
  }
}

// ---- Compact popup (click the bubble): a bit of live data + a Fullscreen button ----
let taskPopEl = null;
function closeTaskPop() { if (taskPopEl) { taskPopEl.remove(); taskPopEl = null; document.removeEventListener('mousedown', taskPopOutside, true); } }
function taskPopOutside(e) { const bub = $('taskBubble'); if (taskPopEl && !taskPopEl.contains(e.target) && bub && !bub.contains(e.target)) closeTaskPop(); }
function taskRowsHtml() {
  return [...bgTasks.entries()].map(([id, t]) => {
    const pct = t.total ? Math.round((t.current / t.total) * 100) : 0;
    const e = etaText(t);
    const cancel = isCancellable(id) ? `<button class="tp-cancel" data-cancel-task="${id}" type="button">Cancel</button>` : '';
    return `<div class="tp-task">
      <div class="tp-task-row"><span class="tp-task-label">${escapeHtml(t.label)}${t.phase ? ` · ${escapeHtml(t.phase)}` : ''}</span><span class="tp-task-count">${t.current}/${t.total}${e ? ` · ${e}` : ''}</span>${cancel}</div>
      ${t.detail ? `<div class="tp-task-detail muted small">${escapeHtml(t.detail)}</div>` : ''}
      <div class="tp-task-track"><div class="tp-task-fill" style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
}
function renderTaskPop() {
  if (!taskPopEl) return;
  const thumb = aiStageCur && aiStageCur._posterUrl;
  taskPopEl.innerHTML = `
    <div class="tp-hd">${thumb ? `<span class="tp-thumb" style="background-image:url('${thumb}')"></span>` : ''}<span class="tp-hd-title">${bgTasks.size} task${bgTasks.size !== 1 ? 's' : ''} running</span></div>
    <div class="tp-tasks">${taskRowsHtml()}</div>
    <button id="tpFull" class="tp-full" type="button">⤢ Fullscreen</button>`;
}
function openTaskPop() {
  if (taskPopEl) { closeTaskPop(); return; }
  if (!bgTasks.size) return;
  taskPopEl = document.createElement('div');
  taskPopEl.className = 'task-pop';
  document.body.appendChild(taskPopEl);
  renderTaskPop();
  taskPopEl.addEventListener('click', (e) => {
    if (e.target.closest('#tpFull')) { closeTaskPop(); theaterOpenWanted = true; openTheater(); return; }
    const btn = e.target.closest('[data-cancel-task]');
    if (btn) { cancelTaskById(btn.dataset.cancelTask); closeTaskPop(); }
  });
  const bub = $('taskBubble'); const r = bub.getBoundingClientRect();
  taskPopEl.style.right = `${Math.max(12, window.innerWidth - r.right)}px`;
  taskPopEl.style.bottom = `${window.innerHeight - r.top + 8}px`;
  setTimeout(() => document.addEventListener('mousedown', taskPopOutside, true), 0);
}
{ const bub = document.getElementById('taskBubble'); if (bub) bub.addEventListener('click', openTaskPop); }

// ---- Live activity feed: the ACTUAL operations the AI/scan is doing, line by line.
// pushActivity() is called from each granular step in the pipelines below so you can
// watch frames being extracted, faces detected/matched, descriptions written, etc.
const ttActivity = [];   // { text, kind, img } — newest last; capped
let actVer = 0; let actDrawn = -1;   // version-guard so we only re-draw (and re-animate) on a REAL change
function pushActivity(text, kind = 'step', img = '') {
  if (!text) return;
  ttActivity.push({ text: String(text), kind, img });
  if (ttActivity.length > 80) ttActivity.shift();
  actVer += 1; renderActivity();
}
// Recognized faces seen THIS run, shown as a strip of face-crop avatars (pending your
// confirmation) — "show, don't tell". name -> { thumb, count }.
const ttPeople = new Map();
let peopleVer = 0; let peopleDrawn = -1;
function notePerson(name, thumb) {
  if (!name) return;
  const p = ttPeople.get(name) || { thumb: '', count: 0 };
  p.count += 1; if (thumb) p.thumb = thumb; ttPeople.set(name, p);
  peopleVer += 1; renderPeopleStrip();
}
function clearActivity() { ttActivity.length = 0; ttPeople.clear(); actVer += 1; peopleVer += 1; renderActivity(); renderPeopleStrip(); }
const ACT_ICON = { frame: '🎞', face: '👤', match: '✅', describe: '✦', write: '✎', done: '✓', warn: '⚠', step: '·' };
function renderActivity() {
  const ul = document.getElementById('ttFeed'); if (!ul) return;
  // Skip redundant renders (the 1s ETA ticker calls renderTheater→here): re-rendering
  // unchanged content re-triggers the entrance animation on the top row = blinking.
  if (actDrawn === actVer && ul.childElementCount) return;
  actDrawn = actVer;
  // Render newest first (most recent at the top). A face crop (if present) shows instead
  // of the emoji — show, don't tell.
  ul.innerHTML = ttActivity.slice(-40).reverse().map((a, i) => {
    const lead = a.img ? `<span class="tt-feed-av" style="background-image:url('${a.img}')"></span>` : `<span class="tt-feed-ic">${ACT_ICON[a.kind] || '·'}</span>`;
    return `<li class="tt-feed-li${i === 0 ? ' fresh' : ''} act-${a.kind}">${lead}<span class="tt-feed-tx">${escapeHtml(a.text)}</span></li>`;
  }).join('') || '<li class="tt-feed-li muted">Waiting for the first step…</li>';
}
function renderPeopleStrip() {
  const el = document.getElementById('ttPeople'); if (!el) return;
  if (peopleDrawn === peopleVer && el.childElementCount) return;
  peopleDrawn = peopleVer;
  if (!ttPeople.size) { el.innerHTML = ''; el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const chips = [...ttPeople.entries()].map(([name, p]) =>
    `<span class="tt-person" title="${escapeHtml(name)} — ${p.count} face${p.count !== 1 ? 's' : ''}, pending your confirmation">
      <span class="tt-person-av${p.thumb ? '' : ' noimg'}"${p.thumb ? ` style="background-image:url('${p.thumb}')"` : ''}></span>
      <span class="tt-person-name">${escapeHtml(name)}</span>${p.count > 1 ? `<span class="tt-person-n">${p.count}</span>` : ''}
    </span>`
  ).join('');
  el.innerHTML = `<span class="tt-people-lbl muted small">Faces to confirm</span><div class="tt-people-row">${chips}</div>`;
}

// ---- Full-screen task "theater": an immersive view of any running task ----
function theaterOpen() { const th = $('taskTheater'); return !!(th && !th.classList.contains('hidden')); }
// Big animated illustration chosen per task type (extensible — every task type can
// later get its own bespoke illustration here).
function ttIlloFor(id) {
  if (id === 'faces' && typeof SCAN_ANIM !== 'undefined') return SCAN_ANIM;
  if (id === 'compress' && typeof ILLO_COMPRESS !== 'undefined') return ILLO_COMPRESS;
  if (id === 'copy' && typeof ILLO_MERGE !== 'undefined') return ILLO_MERGE;
  if (typeof ILLO_THINKING !== 'undefined') return ILLO_THINKING;
  return '';
}
function cancelTaskById(id) {
  if (id === 'faces') { faceScanAborted = true; showToast('Cancelling face scan…'); }
  else if (id === 'ai') { aiAborted = true; showToast('Cancelling AI… (finishes the current clip)', 3500); }
  else if (id === 'compress') { window.api.compressCancel(); showToast('Cancelling compression…'); }
}
function isCancellable(id) { return id === 'faces' || id === 'ai' || id === 'compress'; }
function openTheater() {
  const th = $('taskTheater'); if (!th || !bgTasks.size) return;
  aiStageEnsure();                                   // make sure the conveyor exists…
  const slot = $('ttConveyor');
  if (slot && aiStageEl && aiStageEl.parentElement !== slot) slot.appendChild(aiStageEl);   // …and lives in the theater
  th.classList.remove('hidden');
  requestAnimationFrame(() => th.classList.add('show'));
  renderTheater();
}
function closeTheater() {
  const th = $('taskTheater'); if (!th || th.classList.contains('hidden')) return;
  th.classList.remove('show');
  setTimeout(() => { if (!theaterOpenWanted) th.classList.add('hidden'); }, 240);
}
let theaterOpenWanted = false;
function renderTheater() {
  if (!theaterOpen()) return;
  const p = primaryTask(); if (!p) { theaterOpenWanted = false; closeTheater(); return; }
  const [pid, pt] = p;
  const il = $('ttIllo'); if (il && il.dataset.for !== pid) { il.innerHTML = ttIlloFor(pid); il.dataset.for = pid; }
  const eta = etaText(pt);
  $('ttTitle').textContent = `${pt.label}${pt.phase ? ` · ${pt.phase}` : ''}`;
  $('ttSub').textContent = `${pt.current} of ${pt.total}${eta ? ` · ${eta}` : ''}${pt.detail ? ` · ${pt.detail}` : ''}`;
  const tasks = [...bgTasks.entries()];
  // Single task → the header already shows label·phase·count·eta, so don't repeat it;
  // just offer a slim Cancel. Multiple tasks → show a row per task.
  if (tasks.length <= 1) {
    const cancellable = tasks.length && isCancellable(pid);
    $('ttTasks').innerHTML = cancellable ? `<button class="tt-cancel solo" data-cancel-task="${pid}" type="button">Cancel</button>` : '';
  } else {
    $('ttTasks').innerHTML = tasks.map(([id, t]) => {
      const pct = t.total ? Math.round((t.current / t.total) * 100) : 0;
      const e = etaText(t);
      const cancel = isCancellable(id) ? `<button class="tt-cancel" data-cancel-task="${id}" type="button">Cancel</button>` : '';
      return `<div class="tt-task">
        <div class="tt-task-row"><span class="tt-task-label">${escapeHtml(t.label)}${t.phase ? ` · ${escapeHtml(t.phase)}` : ''}</span><span class="tt-task-count">${t.current}/${t.total}${e ? ` · ${e}` : ''}</span>${cancel}</div>
        <div class="tt-task-track"><div class="tt-task-fill" style="width:${pct}%"></div></div>
      </div>`;
    }).join('');
  }
  renderPeopleStrip();
  renderActivity();
}
// Wire the theater (minimize / backdrop / cancel) once the DOM is present.
{
  const th = document.getElementById('taskTheater');
  const close = () => { theaterOpenWanted = false; closeTheater(); };
  if (th) {
    const ttClose = document.getElementById('ttClose');
    const backdrop = document.getElementById('ttBackdrop');
    if (ttClose) ttClose.addEventListener('click', close);
    if (backdrop) backdrop.addEventListener('click', close);
    th.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cancel-task]');
      if (btn) cancelTaskById(btn.dataset.cancelTask);
    });
  }
}

// ---------------------------------------------------------------------------
// AI PROCESSING STAGE — a live conveyor that flows the REAL clip thumbnails
// through an AI "scanner" one at a time as they're analysed/improved, so the
// screen visibly shows what's happening. Driven entirely by markClipAnalyzing()
// (which every AI loop already calls per clip) + the 'ai' background task for the
// label/count, and an ordered index list set by each run via setAiRunOrder().
// ---------------------------------------------------------------------------
let aiStageEl = null;
let aiStageClips = [];      // clip OBJECTS in this run's order (works for ANY clip with a sourcePath)
let aiStageCur = null;      // clip currently in the scan frame
let aiStageHideTimer = null;
function setAiRunOrder(order) { aiStageClips = (order || []).map((i) => state.scannedFiles[i]).filter(Boolean); aiStageReset(); clearActivity(); }
function setAiRunClips(list) { aiStageClips = (list || []).filter(Boolean); aiStageReset(); clearActivity(); }
// Cache the real poster (frame thumbnail) per clip so we never re-probe.
async function stagePoster(clip) {
  if (!clip) return '';
  if (clip._posterUrl !== undefined) return clip._posterUrl;
  try { clip._posterUrl = (await window.api.getPoster(clip.sourcePath)) || ''; } catch { clip._posterUrl = ''; }
  return clip._posterUrl;
}
function stageThumb(url, cls) {
  const d = document.createElement('div');
  d.className = `aist-tn ${cls || ''}`.trim();
  if (url) d.style.backgroundImage = `url("${url}")`; else d.classList.add('aist-noimg');
  return d;
}
// The conveyor lives INSIDE the full-screen theater (#ttConveyor). It always exists and
// updates as clips flow through; it's only visible when the theater is open. The compact
// always-on view is the bottom bar (mini thumbnail + progress + ETA).
function aiStagePlace() {
  if (!aiStageEl) return;
  const slot = document.getElementById('ttConveyor');
  if (slot) { if (aiStageEl.parentElement !== slot) slot.appendChild(aiStageEl); }
  else if (!aiStageEl.parentElement) document.body.appendChild(aiStageEl);
}
function aiStageEnsure() {
  if (aiStageEl) { aiStagePlace(); return aiStageEl; }
  aiStageEl = document.createElement('div');
  aiStageEl.className = 'ai-stage';
  aiStageEl.innerHTML = `<div class="ai-stage-card">
    <div class="aist-hd"><span class="aist-illo">${typeof ILLO_THINKING !== 'undefined' ? ILLO_THINKING : ''}</span><span class="aist-title"></span><span class="aist-count"></span><span class="aist-eta"></span></div>
    <div class="aist-belt">
      <div class="aist-side aist-done" aria-hidden="true"></div>
      <div class="aist-scan"><div class="aist-frame"><div class="aist-thumbwrap"></div><span class="aist-scanline"></span><span class="aist-phase"></span></div></div>
      <div class="aist-side aist-queue" aria-hidden="true"></div>
    </div>
    <div class="aist-cap"></div>
    <div class="aist-track"><div class="aist-fill"></div></div>
  </div>`;
  aiStagePlace();
  return aiStageEl;
}
function aiStageReset() {
  aiStageEnsure();
  clearTimeout(aiStageHideTimer);
  aiStageCur = null;
  aiStageEl.querySelector('.aist-done').innerHTML = '';
  aiStageEl.querySelector('.aist-queue').innerHTML = '';
  aiStageEl.querySelector('.aist-thumbwrap').innerHTML = '';
  aiStageEl.classList.remove('finishing');
}
// Advance the conveyor to clip `i` with the given phase. Slides the previous focal
// thumb into the DONE pile and the new clip's real thumbnail into the scan frame.
async function aiStageAdvance(clip, phase) {
  if (!aiStageClips.length || !clip) return;   // only during a run that set the clips
  aiStageEnsure();
  const task = bgTasks.get('ai') || {};
  const pos = aiStageClips.indexOf(clip);
  const cur = task.current || (pos >= 0 ? pos + 1 : 0);
  const total = task.total || aiStageClips.length;
  aiStageEl.querySelector('.aist-title').textContent = task.label || aiModelLabel();
  aiStageEl.querySelector('.aist-phase').textContent = phase || task.phase || '';
  aiStageEl.querySelector('.aist-count').textContent = `${cur}/${total}`;
  const eta = etaText(bgTasks.get('ai')); const etaEl = aiStageEl.querySelector('.aist-eta'); if (etaEl) etaEl.textContent = eta ? `· ${eta}` : '';
  aiStageEl.querySelector('.aist-fill').style.width = `${total ? Math.min(100, (cur / total) * 100) : 0}%`;
  const nm = [clip.subject, clip.description].filter(Boolean).join(' / ');
  aiStageEl.querySelector('.aist-cap').innerHTML = `<span class="aist-cap-name">${escapeHtml(clip.name)}</span>${nm ? `<span class="aist-cap-result"> · ${escapeHtml(nm)}</span>` : ''}`;

  // Same clip, new phase (faces → analyzing) → keep the thumbnail, just update the badge.
  if (aiStageCur === clip) return;

  // Slide the outgoing focal thumb into the DONE pile (left).
  if (aiStageCur) {
    const doneRow = aiStageEl.querySelector('.aist-done');
    const dn = stageThumb(aiStageCur._posterUrl, 'aist-just');
    doneRow.prepend(dn);
    requestAnimationFrame(() => dn.classList.remove('aist-just'));
    while (doneRow.children.length > 4) doneRow.lastChild.remove();
  }

  // Bring the new clip's REAL thumbnail into the scan frame (enter from the right).
  const wrap = aiStageEl.querySelector('.aist-thumbwrap');
  const url = await stagePoster(clip);
  if (aiStageCur === clip) return;          // a newer advance won the race
  wrap.innerHTML = '';
  const tn = stageThumb(url, 'aist-focal aist-enter');
  wrap.appendChild(tn);
  requestAnimationFrame(() => tn.classList.remove('aist-enter'));
  aiStageCur = clip;
  renderTaskBar();   // refresh the bottom-bar mini thumbnail to the new focal clip

  // Upcoming queue (right) — the next few clips in this run's order.
  const upcoming = pos >= 0 ? aiStageClips.slice(pos + 1, pos + 5) : [];
  const q = aiStageEl.querySelector('.aist-queue');
  q.innerHTML = '';
  upcoming.forEach((c, k) => {
    const t = stageThumb(c && c._posterUrl, 'aist-queued');
    t.style.opacity = String(Math.max(0.2, 0.85 - k * 0.2));
    q.appendChild(t);
    if (c && c._posterUrl === undefined) stagePoster(c).then((u) => { if (u && t.isConnected) { t.style.backgroundImage = `url("${u}")`; t.classList.remove('aist-noimg'); } });
  });
}
// Run finished → drop the last focal into DONE and flash a ✓ (the theater/bar hide
// themselves when clearTask() removes the 'ai' task).
function aiStageClose() {
  aiStageClips = [];   // stop further advances immediately (the finish anim still plays)
  if (!aiStageEl) { aiStageCur = null; return; }
  if (aiStageCur) {
    const doneRow = aiStageEl.querySelector('.aist-done');
    const dn = stageThumb(aiStageCur._posterUrl, 'aist-just');
    doneRow.prepend(dn); requestAnimationFrame(() => dn.classList.remove('aist-just'));
    while (doneRow.children.length > 4) doneRow.lastChild.remove();
  }
  aiStageEl.classList.add('finishing');
  const ph = aiStageEl.querySelector('.aist-phase'); if (ph) ph.textContent = 'done ✓';
  const q = aiStageEl.querySelector('.aist-queue'); if (q) q.innerHTML = '';
  aiStageHideTimer = setTimeout(() => {
    if (!aiStageEl) return;
    aiStageEl.classList.remove('finishing');
    aiStageCur = null;
  }, 1300);
}

// Live multi-pass step ('perceiving' | 'naming' | 'checking') → bar + activity feed.
const AI_STEP_TEXT = { perceiving: 'Looking at the footage…', naming: 'Choosing a subject & description…', checking: 'Double-checking the result…', describing: 'Describing what it sees…' };
window.api.onAiSuggestStep((p) => {
  const t = bgTasks.get('ai');
  if (t && p && p.phase) { t.phase = p.phase; renderTaskBar(); pushActivity(AI_STEP_TEXT[p.phase] || p.phase, 'describe'); }
});
function aiModelLabel() { return (aiCfg.model || 'AI').split(':')[0]; }

// --- Learn from my edits (implicit) -----------------------------------------
// When the user changes a value the AI suggested, quietly record it; once a few
// pile up (or a run/copy ends) distil them into Memory in the background.
const aiEdits = [];           // [{field, from, to}] pending corrections
const AI_EDIT_FLUSH = 3;
let aiEditFlushing = false;
function recordAiEdit(clip, field, newVal) {
  if (!clip || !aiCfg.learnFromEdits) return;
  const key = field === 'subject' ? '_aiSubject' : '_aiDesc';
  const from = (clip[key] || '').trim();
  const to = (newVal || '').trim();
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) return;
  aiEdits.push({ field, from, to });
  clip[key] = '';             // record this correction only once
  maybeFlushEdits();
}
function maybeFlushEdits(force) {
  if (!aiCfg.learnFromEdits || aiEditFlushing || !aiEdits.length) return;
  if (!force && aiEdits.length < AI_EDIT_FLUSH) return;
  aiEditFlushing = true;
  const batch = aiEdits.splice(0);
  // The AI proposes rules from your edits — it does NOT save them. They become
  // pending questions you confirm (or ignore) via the ⚠ indicator.
  window.api.aiLearnEdits(batch).then(async (r) => {
    aiEditFlushing = false;
    if (r && r.ok && Array.isArray(r.proposed) && r.proposed.length) {
      // Auto-save what it learned from your corrections so memory actually grows
      // (no confirmation friction) and show it learned.
      const notes = r.proposed.map((p) => ({ text: p.text || p, example: p.example || '' })).filter((x) => x.text);
      if (notes.length) {
        try { await window.api.aiAddMemories(notes); if (!Array.isArray(aiCfg.memories)) aiCfg.memories = []; aiCfg.memories.push(...notes); } catch { /* non-fatal */ }
        showToast(`🧠 AI learned ${notes.length} thing${notes.length !== 1 ? 's' : ''} from your edits`);
      }
    }
  }).catch(() => { aiEditFlushing = false; });
}

// ---------------------------------------------------------------------------
// Pending AI questions — the AI only "asks" when it has something genuine to
// confirm: a brand-new subject/category it doesn't want to invent silently, or a
// rule it would like to remember from your edits. Questions never pop up on their
// own — they pile up behind the bottom-right ⚠ indicator until you review them.
// ---------------------------------------------------------------------------
let aiQuestions = [];          // [{id, _key, type:'subject'|'category'|'rule', clipIndex?, field?, suggested?, rule?}]
let aiQid = 0;
function aiQuestionKey(q) {
  if (q.type === 'rule') return 'rule|' + (q.rule || '').toLowerCase();
  if (q.type === 'confirm') return 'confirm|' + q.clipIndex;
  return `${q.type}|${q.clipIndex}|${(q.suggested || '').toLowerCase()}`;
}
// After an analyze run (when "Ask me to confirm" is on), queue a confirm question
// per named clip so the user can verify/correct each — corrections teach the AI.
function buildPostRunQuestions(idxs) {
  for (const i of idxs) {
    const clip = state.scannedFiles[i];
    if (clip && (clip.subject || clip.description)) addAiQuestion({ type: 'confirm', clipIndex: i });
  }
}
function addAiQuestion(q) {
  if (q.type === 'rule' && !q.rule) return;
  if ((q.type === 'subject' || q.type === 'category') && !q.suggested) return;
  const _key = aiQuestionKey(q);
  if (aiQuestions.some((x) => x._key === _key)) return;   // dedup
  aiQuestions.push({ id: `q${(aiQid += 1)}`, _key, field: q.type === 'category' ? (q.field || 'category') : q.field, ...q });
  if ((q.type === 'subject' || q.type === 'category') && typeof q.clipIndex === 'number') markClipQuestion(q.clipIndex, true);
  renderAiHazard();
}
function resolveAiQuestion(id) {
  const q = aiQuestions.find((x) => x.id === id);
  if (!q) return;
  aiQuestions = aiQuestions.filter((x) => x.id !== id);
  if ((q.type === 'subject' || q.type === 'category') && typeof q.clipIndex === 'number'
      && !aiQuestions.some((x) => x.clipIndex === q.clipIndex)) markClipQuestion(q.clipIndex, false);
  renderAiHazard();
}
function markClipQuestion(i, on) {
  const clip = state.scannedFiles[i];
  if (clip) clip._aiQ = on;
  const card = document.querySelector(`.rename-card[data-i="${i}"]`);
  if (card) card.classList.toggle('has-aiq', on);
}
// Live "the AI is looking at THIS clip right now" overlay — a scanning band sweeps
// the preview + an accent ring, and the card gently scrolls into view so you can
// watch the analysis move down the grid.
// Follow-mode: while the AI works, it gently keeps the active clip in view — but if
// YOU scroll away, it stops following and offers a "Follow AI" button to snap back.
let aiFollow = true;
let aiAborted = false;   // Cancel for AI analyze / improve / auto-enhance runs
let lastAutoScrollTs = 0;
let currentAnalyzingI = -1;
let aiFollowBtn = null;
function showFollowBtn(show) {
  if (show) {
    if (!aiFollowBtn) {
      aiFollowBtn = document.createElement('button');
      aiFollowBtn.type = 'button';
      aiFollowBtn.className = 'ai-follow-btn';
      aiFollowBtn.textContent = 'Follow AI ↓';
      aiFollowBtn.addEventListener('click', () => {
        aiFollow = true; aiAborted = false; showFollowBtn(false);
        if (currentAnalyzingI >= 0) { lastAutoScrollTs = Date.now(); const card = document.querySelector(`.rename-card[data-i="${currentAnalyzingI}"]`); if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      });
      document.body.appendChild(aiFollowBtn);
    }
    aiFollowBtn.classList.add('show');
  } else if (aiFollowBtn) aiFollowBtn.classList.remove('show');
}
function onAnalyzeScroll() {
  if (currentAnalyzingI < 0) return;                 // not analyzing → ignore
  if (Date.now() - lastAutoScrollTs < 700) return;   // this was our own auto-scroll
  if (aiFollow) { aiFollow = false; showFollowBtn(true); }
}
window.addEventListener('scroll', onAnalyzeScroll, true);
function markClipAnalyzing(i, phase) {
  const card = document.querySelector(`.rename-card[data-i="${i}"]`);
  if (!card) return;
  const prev = card.querySelector('.rename-preview');
  if (phase) {
    card.classList.add('analyzing');
    card.dataset.aiPhase = phase;
    if (prev) prev.dataset.aiPhase = phase;
    currentAnalyzingI = i;
    aiStageAdvance(state.scannedFiles[i], phase);   // flow this clip's real thumbnail through the live AI stage
    if (aiFollow) { lastAutoScrollTs = Date.now(); try { card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ } }
  } else {
    card.classList.remove('analyzing'); delete card.dataset.aiPhase;
    if (prev) delete prev.dataset.aiPhase;
  }
}
function clearAllAnalyzing() { currentAnalyzingI = -1; showFollowBtn(false); document.querySelectorAll('.rename-card.analyzing').forEach((c) => { c.classList.remove('analyzing'); delete c.dataset.aiPhase; const p = c.querySelector('.rename-preview'); if (p) delete p.dataset.aiPhase; }); }
// Brief green "name just landed" pulse on a card after the AI fills it in — gives a
// satisfying, glance-able confirmation as the run sweeps down the list.
function flashNamed(i) {
  const card = document.querySelector(`.rename-card[data-i="${i}"]`);
  if (!card) return;
  card.classList.remove('just-named');
  void card.offsetWidth;                 // restart the animation if it's still mid-flash
  card.classList.add('just-named');
  setTimeout(() => card.classList.remove('just-named'), 500);
}
function renderAiHazard() {
  const el = $('aiHazard'); if (!el) return;
  const n = aiQuestions.length;
  const cnt = $('aiHazardCount'); if (cnt) cnt.textContent = n;
  el.classList.toggle('hidden', n === 0);
  if (!n && hazardPopEl) closeHazardPop();
  if (hazardPopEl) fillHazardPop();
}

// Small popover anchored to the ⚠ button: a summary + a Review button.
let hazardPopEl = null;
function fillHazardPop() {
  if (!hazardPopEl) return;
  const n = aiQuestions.length;
  const c = (t) => aiQuestions.filter((q) => q.type === t).length;
  const parts = [];
  if (c('confirm')) parts.push(`${c('confirm')} clip${c('confirm') !== 1 ? 's' : ''} to confirm`);
  if (c('subject')) parts.push(`${c('subject')} new subject${c('subject') !== 1 ? 's' : ''}`);
  if (c('category')) parts.push(`${c('category')} new categor${c('category') !== 1 ? 'ies' : 'y'}`);
  if (c('rule')) parts.push(`${c('rule')} rule${c('rule') !== 1 ? 's' : ''} to remember`);
  hazardPopEl.querySelector('.ai-hazard-hd').textContent = `AI has ${n} question${n !== 1 ? 's' : ''}`;
  hazardPopEl.querySelector('.ai-hazard-sub').textContent = parts.join(' · ') || 'Nothing pending';
}
function closeHazardPop() {
  if (!hazardPopEl) return;
  hazardPopEl.remove(); hazardPopEl = null;
  document.removeEventListener('mousedown', hazardOutside, true);
}
function hazardOutside(e) {
  const hz = $('aiHazard');
  if (hazardPopEl && !hazardPopEl.contains(e.target) && hz && !hz.contains(e.target)) closeHazardPop();
}
function toggleHazardPop() {
  if (hazardPopEl) { closeHazardPop(); return; }
  hazardPopEl = document.createElement('div');
  hazardPopEl.className = 'ai-hazard-pop';
  hazardPopEl.innerHTML = `<div class="ai-hazard-hd"></div><div class="ai-hazard-sub muted small"></div><button type="button" class="btn primary ai-hazard-review">Review</button>`;
  document.body.appendChild(hazardPopEl);
  fillHazardPop();
  const r = $('aiHazard').getBoundingClientRect();
  hazardPopEl.style.right = `${Math.max(12, window.innerWidth - r.right)}px`;
  hazardPopEl.style.bottom = `${window.innerHeight - r.top + 10}px`;
  hazardPopEl.querySelector('.ai-hazard-review').addEventListener('click', () => { closeHazardPop(); showAiReview(); });
  setTimeout(() => document.addEventListener('mousedown', hazardOutside, true), 0);
}

// Apply an AI result {subject,description,shotType,category} to a clip. Subject /
// category are auto-applied ONLY if already known; new ones are returned for the
// user to confirm (don't invent silently).
function applyAiResult(i, res, mode = 'all') {
  const clip = state.scannedFiles[i];
  if (!clip || !res) return { ok: false };
  const capWords = (s, n) => slug(s).split('-').filter(Boolean).slice(0, n).join('-');
  const onlyEmpty = mode === 'empty';
  let newSubject = '';
  // Only touch the subject when the user allows it (default: keep my subjects,
  // AI just fills description + metadata). An empty subject is still fillable.
  if (res.subject && (aiCfg.updateSubject || !clip.subject) && (!onlyEmpty || !clip.subject)) {
    const subj = capWords(res.subject, 3);
    if (subjectsCache.map((s) => s.toLowerCase()).includes(subj)) { clip.subject = subj; clip._aiSubject = subj; rememberSubject(subj); }
    else if (subj) newSubject = subj;
  }
  if (res.shotType) clip.shotType = slug(res.shotType);   // kept for metadata/keywords even if folded into the description
  if ((res.description || res.shotType) && (!onlyEmpty || !clip.description)) {
    const shot = (aiCfg.detectShot && res.shotType) ? slug(res.shotType) : '';
    const desc = [shot, slug(res.description || '')].filter(Boolean).join('-');
    // No hard 5-word cap — keep what the model gave (names + setting can need more);
    // 12 is just a sanity ceiling so a runaway answer can't produce a giant filename.
    clip.description = capWords(desc, 12);
    if (clip.description) { clip._aiDesc = clip.description; rememberDescription(clip.description); }
  }
  let newCategory = '';
  if (res.category && aiCfg.suggestCategory && (!onlyEmpty || !clip.category)) {
    const known = (fieldHistoryCache.category || []).map((s) => s.toLowerCase());
    const cat = slug(res.category);
    if (known.includes(cat)) clip.category = cat;
    else if (cat) newCategory = cat;
  }
  // AI keyword tags → merge into the clip's tags (additive; never drops your own).
  if (Array.isArray(res.tags) && res.tags.length) {
    const before = (clip.tags || []).length;
    clip.tags = [...new Set([...(clip.tags || []), ...res.tags.filter(Boolean)])];
    if (clip.tags.length !== before) renderClipTags(i);
  }
  syncRowInputs([i]);
  refreshNames();
  if (clip.subject || clip.description) flashNamed(i);
  return { ok: true, newSubject, newCategory, note: res.note || '', switchedTo: res.switchedTo || '' };
}

// Watchdog: guarantee an AI loop ALWAYS advances even if one call wedges (a model
// reloading, a clip the model chokes on, a stalled HTTP body). Races the IPC call
// against a hard ceiling so we never sit on clip 1 forever — a stuck clip is marked
// failed (with a clear reason) and the loop moves to the next. This is the real fix
// for "stuck on the first clip and doesn't move to the second".
function aiCallGuard(promise, ms = 150000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => finish({ ok: false, error: 'Took too long — skipped this clip', _timeout: true }), ms);
    Promise.resolve(promise).then(finish, (e) => finish({ ok: false, error: (e && e.message) || String(e) }));
  });
}

// SELF-REVIEW pass: re-read each clip's saved visual observation + current name and
// IMPROVE it (text-only, no re-vision) using all the data — recognized people, shot
// type, motion, style + memories. "Go back, see where it went wrong, fix it."
async function aiImproveSelected() {
  if (!requireAi()) return;
  const sel = state.scannedFiles.map((c, i) => (c.selected ? i : -1)).filter((i) => i >= 0);
  const targets = sel.length ? sel : state.scannedFiles.map((c, i) => i);
  const obsOf = (c) => (c.observation && c.observation.trim()) || (clipObsCache[clipKey(c)] && clipObsCache[clipKey(c)].obs) || '';
  const withObs = targets.filter((i) => obsOf(state.scannedFiles[i]));
  if (!withObs.length) { showToast('Analyze these clips first — Improve refines the saved analysis'); return; }
  if (uiPrefs.autoVersionOnAi !== false) saveVersionPoint(`Before AI improve · ${withObs.length} clip${withObs.length !== 1 ? 's' : ''}`, true);
  setAiRunOrder(withObs);   // drive the live AI processing stage
  aiFollow = true; aiAborted = false; showFollowBtn(false);
  let done = 0; let ok = 0; let fail = 0; let lastErr = ''; let visionNote = '';
  for (const i of withObs) {
    if (aiAborted) break;
    const c = state.scannedFiles[i];
    setTask('ai', aiModelLabel(), done + 1, withObs.length, 'improving', c.name);
    markClipAnalyzing(i, 'improving');
    // eslint-disable-next-line no-await-in-loop
    const res = await aiCallGuard(window.api.aiImprove({
      sourcePath: c.sourcePath,   // lets Improve fall back to a vision pass if text-only fails
      observation: obsOf(c),
      draft: { subject: c.subject || '', description: c.description || '', shotType: c.shotType || '', category: c.category || '' },
      people: Array.isArray(c.people) ? c.people : [],
      context: runContext(c),
      subjects: subjectsCache,
      categories: (aiCfg.suggestCategory && fieldHistoryCache.category) ? fieldHistoryCache.category : []
    }), 200000);
    markClipAnalyzing(i, false);
    if (res && res.ok) {
      if (res.switchedTo) aiCfg.model = res.switchedTo;   // a broken vision model auto-swapped
      if (res.note) visionNote = res.note;
      const ap = applyAiResult(i, res, 'all'); queueQuestions(i, ap); ok += 1;
    } else { fail += 1; lastErr = res ? res.error : 'no response'; logIssue('AI improve', `${c.name}: ${lastErr}`); }
    flushDraftSave();   // persist each improved clip immediately — survives a crash
    done += 1;
  }
  clearAllAnalyzing(); clearTask('ai');
  maybeFlushEdits(true);
  if (visionNote) showToast(visionNote, 8000);   // surfaced an auto-swapped vision model
  // Improve refines names from the saved observation — learn from the result too, so
  // memory grows from every AI pass, not just the first Analyze.
  if (aiCfg.learnFromAnalysis !== false && ok >= 2) {
    reflectFromClips(withObs.filter((i) => { const c = state.scannedFiles[i]; return c && (c.subject || c.description); }));
  }
  if (ok) showToast(`Improved ${ok} description${ok !== 1 ? 's' : ''}${fail ? ` · ${fail} failed` : ''} ✓`, 4000);
  else showToast(`Couldn't improve${lastErr ? `: ${lastErr}` : ''}`, 5000);
}

// INSTANT, OFFLINE name-swap: rewrite existing descriptions to use recognized people's
// FIRST names instead of generic words ("a man" → "liam") — the SAME deterministic swap
// the analyzer applies, but with NO AI call. Perfect after tagging faces on clips that
// were already named generically: fixes them in milliseconds, fully local.
const SWAP_STOP = new Set(['a', 'an', 'the', 'is', 'are', 'am', 'was', 'were', 'be', 'being', 'been', 'of', 'on', 'in', 'at', 'to', 'into', 'onto', 'with', 'and', 'or', 'for', 'from', 'by', 'as', 'over', 'under', 'this', 'that', 'these', 'those', 'it', 'its', 'their', 'there', 'while', 'who', 'which']);
const SWAP_GENERIC = new Set(['someone', 'somebody', 'anyone', 'person', 'persons', 'people', 'man', 'men', 'woman', 'women', 'guy', 'guys', 'lady', 'boy', 'boys', 'girl', 'girls', 'kid', 'kids', 'child', 'children', 'male', 'female', 'figure', 'individual', 'individuals', 'subject', 'human', 'adult', 'adults']);
const SWAP_COUNT = new Set(['two', 'three', 'four', 'five', 'several', 'multiple', 'group', 'couple', 'bunch', 'pair']);
function swapNamesLocal(raw, people) {
  const firsts = [...new Set((people || []).map((s) => String(s || '').trim()).filter(Boolean))]
    .map((n) => (n.toLowerCase().replace(/[^a-z0-9\s-]+/g, '').split(/[\s-]+/).filter(Boolean)[0] || '')).filter(Boolean);
  const toks = String(raw || '').toLowerCase().replace(/[^a-z0-9\s_-]+/g, ' ').split(/[\s_-]+/).filter(Boolean).filter((t) => !SWAP_STOP.has(t));
  const out = []; let injected = false;
  const inject = () => { if (!injected) { out.push(...firsts); injected = true; } };
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if ((SWAP_COUNT.has(t) || /^\d+$/.test(t)) && (SWAP_GENERIC.has(toks[i + 1]) || SWAP_GENERIC.has(toks[i + 2]))) continue;
    if (SWAP_GENERIC.has(t)) { if (firsts.length) inject(); else out.push(t); continue; }
    out.push(t);
  }
  const seen = new Set();
  let res = out.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
  if (!res.length && firsts.length) res = firsts;
  return res.join('-');
}
function applyNamesToDescriptions() {
  const sel = state.scannedFiles.map((c, i) => (c.selected ? i : -1)).filter((i) => i >= 0);
  const targets = (sel.length ? sel : state.scannedFiles.map((c, i) => i)).filter((i) => {
    const c = state.scannedFiles[i];
    return Array.isArray(c.people) && c.people.length && (c.description || c.subject);
  });
  if (!targets.length) { showToast('Tag people on some clips first — this swaps generic words ("a man") for their names'); return; }
  let changed = 0;
  for (const i of targets) {
    const c = state.scannedFiles[i];
    const nd = swapNamesLocal(c.description || '', c.people);
    if (nd && nd !== c.description) { c.description = nd; c._aiDesc = nd; changed += 1; flashNamed(i); }
  }
  syncRowInputs(targets); refreshNames(); flushDraftSave();
  showToast(changed ? `Used people's names in ${changed} description${changed !== 1 ? 's' : ''} ✓` : 'Descriptions already use the names', 3500);
}

// REFLECT: after analysis, work BACKWARDS from what the AI saw + how it named the
// clips → derive durable rules and fold them into memory (the app learning from its
// own analysis). Background-friendly; deduped + capped in main.
async function reflectFromClips(idxs, { manual = false } = {}) {
  const obsOf = (c) => (c.observation && c.observation.trim()) || (clipObsCache[clipKey(c)] && clipObsCache[clipKey(c)].obs) || '';
  const samples = (idxs || []).map((i) => {
    const c = state.scannedFiles[i]; if (!c) return null;
    const obs = obsOf(c);
    return obs && (c.subject || c.description) ? { observation: obs, subject: c.subject || '', description: c.description || '', shotType: c.shotType || '', people: Array.isArray(c.people) ? c.people : [], context: (c.context || '').trim() } : null;
  }).filter(Boolean);
  if (samples.length < 2) { if (manual) showToast('Analyze at least 2 clips first — this learns from the analysis'); return; }
  setTask('ai', aiModelLabel(), 1, 1, 'learning');
  try {
    const r = await window.api.aiReflect({ samples });
    clearTask('ai');
    if (r && r.ok && Array.isArray(r.added) && r.added.length) {
      if (!Array.isArray(aiCfg.memories)) aiCfg.memories = [];
      for (const t of r.added) aiCfg.memories.push({ text: t, example: '' });
      showToast(`🧠 Learned ${r.added.length} rule${r.added.length !== 1 ? 's' : ''} from this analysis`, 4500);
    } else if (manual) showToast(r && r.error ? r.error : 'Nothing new to learn — memory already covers it');
  } catch (e) { clearTask('ai'); if (manual) showToast('Could not learn from this analysis'); }
}
function learnFromAnalysisNow() {
  if (!requireAi()) return;
  const sel = state.scannedFiles.map((c, i) => (c.selected ? i : -1)).filter((i) => i >= 0);
  reflectFromClips(sel.length ? sel : state.scannedFiles.map((c, i) => i), { manual: true });
}

// After you NAME clips by hand (batch apply / batch dialog), quietly learn from
// the ones the AI has already SEEN — so your manual naming + typed context grow
// memory too, not just AI-suggested names. Debounced; no-ops unless ≥2 of the
// named clips have an observation, and respects the "learn from edits" toggle.
let reflectBatchTimer = null;
function scheduleReflectFromNaming(indices) {
  if (!aiCfg.enabled || aiCfg.learnFromEdits === false) return;
  const obsIdxs = (indices || []).filter((i) => {
    const c = state.scannedFiles[i]; if (!c || !(c.subject || c.description)) return false;
    return !!((c.observation && c.observation.trim()) || (clipObsCache[clipKey(c)] && clipObsCache[clipKey(c)].obs));
  });
  if (obsIdxs.length < 2) return;   // nothing the AI has both seen AND you've named
  clearTimeout(reflectBatchTimer);
  reflectBatchTimer = setTimeout(() => reflectFromClips(obsIdxs), 4500);
}

// One-click AUTO-ENHANCE: kick off the AI in the background to do useful work —
// name any unnamed clips, then learn rules from the whole batch. Non-modal; you can
// keep working (and scroll away — the Follow button brings you back).
let autoEnhancing = false;
async function aiAutoEnhance() {
  if (!requireAi()) return;
  if (autoEnhancing) { showToast('AI is already enhancing…'); return; }
  const all = state.scannedFiles.map((c, i) => i);
  if (!all.length) { showToast('No clips to enhance'); return; }
  autoEnhancing = true;
  aiFollow = true; aiAborted = false; showFollowBtn(false);
  if (uiPrefs.autoVersionOnAi !== false) saveVersionPoint('Before AI auto-enhance', true);
  showToast('AI is enhancing your clips in the background…', 3500);
  const obsOf = (c) => (c.observation && c.observation.trim()) || (clipObsCache[clipKey(c)] && clipObsCache[clipKey(c)].obs) || '';
  try {
    // 1) name any clips that have no subject yet
    const unnamed = all.filter((i) => !((state.scannedFiles[i].subject || '').trim()));
    setAiRunOrder(unnamed);   // drive the live AI processing stage
    let done = 0;
    for (const i of unnamed) {
      if (aiAborted) break;
      setTask('ai', aiModelLabel(), done + 1, unnamed.length, 'naming', state.scannedFiles[i].name);
      markClipAnalyzing(i, 'naming');
      // eslint-disable-next-line no-await-in-loop
      const r = await aiSuggestClip(i, 'empty', { quiet: true });
      queueQuestions(i, r);
      markClipAnalyzing(i, false); flushDraftSave(); done += 1;
    }
    // 2) learn durable rules from everything analyzed
    const withObs = all.filter((i) => { const c = state.scannedFiles[i]; return obsOf(c) && (c.subject || c.description); });
    if (withObs.length >= 2) await reflectFromClips(withObs);
  } catch { /* best-effort */ }
  clearAllAnalyzing(); clearTask('ai'); maybeFlushEdits(true);
  autoEnhancing = false;
  showToast('AI auto-enhance complete ✓', 4000);
  pcNotify('AI auto-enhance complete', 'Your clips were named and rules were learned.');
}

// Direction the user typed in the Analyze dialog for THIS run — folded into the
// per-clip context so it steers naming, and optionally saved to memory afterwards.
let aiRunDirection = '';
function runContext(clip) { return [aiRunDirection, clip && clip.context].map((s) => (s || '').trim()).filter(Boolean).join(' — '); }

async function aiSuggestClip(i, mode = 'all', opts = {}) {
  const clip = state.scannedFiles[i];
  if (!clip || !aiReady()) return { ok: false };
  try {
    const res = await window.api.aiSuggest({
      sourcePath: clip.sourcePath,
      model: aiCfg.model,
      subjects: subjectsCache,
      categories: (aiCfg.suggestCategory && fieldHistoryCache.category) ? fieldHistoryCache.category : [],
      context: runContext(clip),
      people: Array.isArray(clip.people) ? clip.people : [],
      observation: opts.observation || '',
      draft: mode === 'refine' ? { subject: clip.subject || '', description: clip.description || '', location: clip.location || '' } : null
    });
    if (!res || !res.ok) { if (!opts.quiet) showToast(`AI: ${res ? res.error : 'no response'}`); return { ok: false, error: res ? res.error : 'no response' }; }
    // Persist what the AI SAW (from this run, or precomputed) so every other feature —
    // Improve, Learn-rules, rich XMP — can reuse it without re-watching the footage.
    const obs = (opts.observation || res.observation || '').trim();
    if (obs) {
      clip.observation = obs;
      const key = clipKey(clip);
      clipObsCache[key] = { obs, ts: Date.now() };
      try { window.api.saveClipObs({ key, obs }); } catch { /* non-fatal */ }
    }
    return applyAiResult(i, res, mode);
  } catch (err) {
    if (!opts.quiet) showToast(`AI error: ${err.message || err}`);
    return { ok: false, error: err.message || String(err) };
  }
}

// Analyze the ticked clips with AI (Edit → AI → Analyze selected clips). If any
// already have content, ask whether to overwrite or only fill empty fields.
let faceScanOffered = false;   // only nudge once per session
// Before analyzing, offer to scan faces first so the AI can use who's in each clip.
async function maybeOfferFaceScan(idxs) {
  if (faceScanOffered) return 'continue';
  const anyPeople = idxs.some((i) => Array.isArray(state.scannedFiles[i].people) && state.scannedFiles[i].people.length);
  if (anyPeople) return 'continue';
  // Already scanned these clips (even if nothing matched / suggestions left unconfirmed)?
  // Don't nag — the scan is remembered and unconfirmed faces wait in the dashboard.
  if (idxs.every((i) => state.scannedFiles[i]._facesScanned)) return 'continue';
  const probe = await ensureFaceModels();
  if (!probe.ok) return 'continue';   // face recognition not set up — don't nag
  faceScanOffered = true;
  return new Promise((resolve) => {
    const ov = document.createElement('div'); ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal-card modal-form" style="width:min(440px,92vw);text-align:left">
      <div class="ai-hd"><span class="ai-hd-icon fg-hd-anim">${typeof SCAN_ANIM !== 'undefined' ? SCAN_ANIM : '🙂'}</span><div class="ai-hd-text"><h3>Scan faces first?</h3><p class="muted small">None of these clips have people tagged yet. Scanning for faces lets the AI weave in <b>who's in each clip</b> for much better descriptions.</p></div></div>
      <div class="modal-actions"><button type="button" class="btn primary mof-scan">Scan faces first</button><button type="button" class="btn mof-skip">Analyze without</button><button type="button" class="btn mof-cancel">Cancel</button></div>
    </div>`;
    document.body.appendChild(ov);
    const done = (v) => { ov.remove(); resolve(v); };
    ov.querySelector('.mof-scan').addEventListener('click', () => done('scan'));
    ov.querySelector('.mof-skip').addEventListener('click', () => done('continue'));
    ov.querySelector('.mof-cancel').addEventListener('click', () => done('cancel'));
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) done('cancel'); });
  });
}

// Same-shoot detection: if the clips' dates match a project filed earlier, offer to
// add them to it. Tags accepted clips with `_ledgerRel` so the destination map files
// them straight into that project at the organize phase.
async function maybeOfferLedgerProject(idxs) {
  const clips = idxs.map((i) => state.scannedFiles[i]).filter(Boolean);
  const fresh = clips.filter((c) => !c._ledgerAsked && !c._ledgerRel);
  if (!fresh.length) return;
  const dates = [...new Set(fresh.map((c) => c.date).filter(Boolean))];
  if (!dates.length) return;
  const subjects = [...new Set(fresh.map((c) => c.subject).filter(Boolean))];
  const people = [...new Set(fresh.flatMap((c) => (Array.isArray(c.people) ? c.people : [])).filter(Boolean))];
  const locations = [...new Set(fresh.map((c) => c.location).filter(Boolean))];
  let matches = [];
  try { matches = await window.api.ledgerMatchDates({ dates, subjects, people, locations }); } catch { matches = []; }
  fresh.forEach((c) => { c._ledgerAsked = true; });   // asked once, even if nothing matched
  // Only offer GENUINELY related projects (shared content), not date-only coincidences.
  const related = matches.filter((m) => m.related);
  if (!related.length) return;
  const chosen = await showLedgerMatchDialog(related, fresh);
  if (!chosen) return;
  const projDates = new Set(chosen.dates || []);
  let n = 0;
  for (const c of fresh) { if (c.date && projDates.has(c.date)) { c._ledgerRel = chosen.rel; n += 1; } }
  flushDraftSave();
  if (n) showToast(`Will file ${n} clip${n !== 1 ? 's' : ''} into “${chosen.name}” at the organize step`, 5000);
}

function showLedgerMatchDialog(matches, fresh) {
  return new Promise((resolve) => {
    let cur = matches[0];
    const fmtDates = (m) => { const ds = (m.sharedDates || []).slice().sort(); return ds.length ? (ds.length === 1 ? ds[0] : `${ds[0]} – ${ds[ds.length - 1]} · ${ds.length} days`) : ''; };
    const ov = document.createElement('div'); ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal-card modal-form" style="width:min(510px,92vw);text-align:left">
      <div class="illo mob-illo">${ILLO_LINK}</div>
      <div class="ai-hd" style="margin-top:2px"><div class="ai-hd-text"><h3>Part of an existing project?</h3><p class="muted small lm-sub"></p></div></div>
      <div class="lm-pick"></div>
      <blockquote class="lm-summary muted small"></blockquote>
      <div class="modal-actions"><button type="button" class="btn primary lm-yes">Yes — add to this project</button><button type="button" class="btn lm-no">No, decide later</button></div>
    </div>`;
    document.body.appendChild(ov);
    const sub = ov.querySelector('.lm-sub'); const sumEl = ov.querySelector('.lm-summary'); const pick = ov.querySelector('.lm-pick');
    const render = () => {
      sub.innerHTML = `Some of these clips are from <b>${escapeHtml(fmtDates(cur))}</b> — when you filed <b>${escapeHtml(cur.name)}</b> (${cur.clips} clip${cur.clips !== 1 ? 's' : ''}). Add them there when you organize?`;
      if (cur.summary) { sumEl.textContent = cur.summary; sumEl.style.display = ''; } else sumEl.style.display = 'none';
    };
    if (matches.length > 1) {
      const lab = document.createElement('label'); lab.className = 'pref-label'; lab.textContent = 'Project'; lab.style.cssText = 'display:block;margin-bottom:6px';
      const sel = createSelect({ value: cur.rel, style: 'width:100%' });
      sel.setOptions(matches.map((m) => ({ value: m.rel, label: `${m.name} · ${m.clips} clip${m.clips !== 1 ? 's' : ''}` })));
      sel.onChange((v) => { cur = matches.find((m) => m.rel === v) || cur; render(); });
      pick.appendChild(lab); pick.appendChild(sel.el);
    }
    render();
    const close = (val) => { ov.remove(); resolve(val); };
    ov.querySelector('.lm-yes').addEventListener('click', () => close(cur));
    ov.querySelector('.lm-no').addEventListener('click', () => close(null));
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(null); });
  });
}
async function aiAnalyzeSelected() {
  if (!requireAi()) return;
  const idxs = state.scannedFiles.map((c, i) => (c.selected ? i : -1)).filter((i) => i >= 0);
  if (!idxs.length) { showToast('Tick the clips you want to analyse first'); return; }
  const faceChoice = await maybeOfferFaceScan(idxs);
  if (faceChoice === 'cancel') return;
  if (faceChoice === 'scan') {
    // ONE pass: scan faces + let you confirm who's who, THEN keep going and name the
    // clips with those people woven in (no more "scan, then Analyze again").
    const sel = idxs.map((i) => state.scannedFiles[i]);
    await scanFacesForClips(sel);
    if (aiAborted) return;
    // fall through to the naming phase below — people are now tagged on the clips.
  }
  // Same-shoot detection: if these dates match a project filed before, offer to add
  // them to it in the organize phase (tags clips with _ledgerRel for the dest map).
  await maybeOfferLedgerProject(idxs);
  const hasContent = idxs.some((i) => {
    const c = state.scannedFiles[i];
    return c.subject || c.description || organizeFields.some((f) => c[f.id]);
  });
  const cachedCount = idxs.filter((i) => { const o = clipObsCache[clipKey(state.scannedFiles[i])]; return o && o.obs; }).length;
  const dlg = await showAnalyzeDialog({ count: idxs.length, hasContent, cachedCount });
  if (!dlg) return;
  const mode = dlg.mode;
  // Direction the user typed steers this run (folded into each clip's context)…
  aiRunDirection = dlg.direction || '';
  // …and, if they asked, is remembered so future runs benefit too.
  if (dlg.direction && dlg.remember) {
    try {
      await window.api.aiAddMemories([{ text: dlg.direction, example: '' }]);
      if (!Array.isArray(aiCfg.memories)) aiCfg.memories = [];
      aiCfg.memories.push({ text: dlg.direction, example: '' });
    } catch { /* non-fatal */ }
  }
  // Snapshot the current naming BEFORE the AI changes anything, so it's always
  // recoverable from Edit → Version history (unless the user turned this off).
  if (uiPrefs.autoVersionOnAi !== false) await saveVersionPoint(`Before AI analyze · ${idxs.length} clip${idxs.length !== 1 ? 's' : ''}`, true);
  setAiRunOrder(idxs);   // drive the live AI processing stage in this order
  aiFollow = true; aiAborted = false; showFollowBtn(false);
  let okCount = 0; let failCount = 0; let lastErr = ''; let visionNote = '';
  const queueQuestions = (i, r) => {
    if (r && r.ok) {
      okCount += 1;
      if (r.note) visionNote = r.note;
      if (r.switchedTo) aiCfg.model = r.switchedTo;   // broken vision model was swapped — stop re-trying it
      if (r.newSubject) addAiQuestion({ type: 'subject', clipIndex: i, suggested: r.newSubject });
      if (r.newCategory) addAiQuestion({ type: 'category', clipIndex: i, field: 'category', suggested: r.newCategory });
    } else { failCount += 1; if (r && r.error) lastErr = r.error; logIssue('AI analyze', `${(state.scannedFiles[i] || {}).name || 'clip'}: ${(r && r.error) || 'no response'}`); }
  };
  let done = 0;
  if (aiCfg.multiPass) {
    // PHASE 1 — the vision model "looks" at EVERY clip first (it stays loaded the
    // whole phase, no per-clip reload), producing an observation each.
    const observations = {};
    for (const i of idxs) {
      if (aiAborted) break;
      const clip = state.scannedFiles[i];
      const key = clipKey(clip);
      // Reuse a prior observation of this exact clip when the user opted in — no
      // need to look again, and it keeps results consistent run-to-run.
      if (dlg.reuse && clipObsCache[key] && clipObsCache[key].obs) {
        observations[i] = clipObsCache[key].obs;
        setTask('ai', aiModelLabel(), done + 1, idxs.length, 'reusing', clip.name);
        done += 1; continue;
      }
      setTask('ai', aiModelLabel(), done + 1, idxs.length, 'looking', clip.name);
      markClipAnalyzing(i, 'looking');
      // eslint-disable-next-line no-await-in-loop
      const r = await aiCallGuard(window.api.aiPerceive({ sourcePath: clip.sourcePath, model: aiCfg.model, context: runContext(clip), people: Array.isArray(clip.people) ? clip.people : [] }), 200000);
      if (r && r.ok) {
        observations[i] = r.observation; if (r.note) visionNote = r.note; if (r.switchedTo) aiCfg.model = r.switchedTo;
        clipObsCache[key] = { obs: r.observation, ts: Date.now() };
        window.api.saveClipObs({ key, obs: r.observation });   // remember for next time
      } else if (r && r.error) lastErr = r.error;
      markClipAnalyzing(i, false);
      done += 1;
    }
    // PHASE 2 — the reasoning model names them all from those observations (it
    // stays loaded for this phase). No swapping vision↔text per clip.
    done = 0;
    for (const i of idxs) {
      if (aiAborted) break;
      setTask('ai', aiModelLabel(), done + 1, idxs.length, 'naming', state.scannedFiles[i].name);
      markClipAnalyzing(i, 'naming');
      // eslint-disable-next-line no-await-in-loop
      const r = await aiSuggestClip(i, mode, { observation: observations[i] || '', quiet: true });
      queueQuestions(i, r);
      markClipAnalyzing(i, false);
      flushDraftSave();   // persist each named clip immediately — survives a mid-run crash
      done += 1;
    }
  } else {
    for (const i of idxs) {
      if (aiAborted) break;
      setTask('ai', aiModelLabel(), done + 1, idxs.length, 'analyzing', state.scannedFiles[i].name);
      markClipAnalyzing(i, 'analyzing');
      // eslint-disable-next-line no-await-in-loop
      const r = await aiSuggestClip(i, mode, { quiet: true });
      queueQuestions(i, r);
      markClipAnalyzing(i, false);
      flushDraftSave();   // persist each named clip immediately — survives a mid-run crash
      done += 1;
    }
  }
  clearAllAnalyzing();
  clearTask('ai');
  const q = aiQuestions.length;
  if (failCount && !okCount) showToast(`AI couldn't name any clips — ${lastErr || 'check the model in AI settings'}`, 6000);
  else if (failCount) showToast(`AI named ${okCount}, ${failCount} failed${lastErr ? ` (${lastErr})` : ''} · ${q} to review`, 5000);
  else { showToast(`AI analysed ${okCount} clip${okCount !== 1 ? 's' : ''}${q ? ` · ${q} to review` : ''}${mode === 'empty' ? ' (filled empty fields only)' : ''}`); pcNotify('AI analysis done', `Named ${okCount} clip${okCount !== 1 ? 's' : ''}${q ? ` · ${q} to review` : ''}.`); }
  if (visionNote) showToast(visionNote, 8000);   // tell the user we auto-swapped a broken vision model
  aiRunDirection = '';   // direction was for this run only (it’s saved to memory if requested)
  maybeFlushEdits(true);   // distil any edits the user made during/after this run
  if (postRunConfirmEnabled() && okCount) buildPostRunQuestions(idxs);
  // Learn from this analysis: work backwards from what was SEEN + NAMED → durable
  // rules. Background, non-blocking; gated by the "Learn from each analysis" setting.
  if (aiCfg.learnFromAnalysis !== false && okCount >= 2) {
    const named = idxs.filter((i) => { const c = state.scannedFiles[i]; return c && (c.subject || c.description); });
    reflectFromClips(named);
  }
}

// Pre-analyze dialog: lets the user type free-form DIRECTION for this run (folded
// into every clip's context), optionally remember it for the future, and — when
// some clips already have content — choose how the AI treats them. Resolves to
// { direction, remember, mode, reuse } or null if cancelled.
function showAnalyzeDialog({ count, hasContent, cachedCount }) {
  return new Promise((resolve) => {
    const modeOpts = [
      { v: 'refine', t: 'Refine what I wrote', d: 'use my subject/description/location as context' },
      { v: 'empty', t: 'Only fill empty fields', d: 'leave anything I already typed' },
      { v: 'all', t: 'Overwrite from scratch', d: 'ignore what\'s there and start fresh' }
    ];
    let mode = hasContent ? 'refine' : 'all';
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal-card modal-form an-card">
      <h3>Analyze ${count} clip${count !== 1 ? 's' : ''} with AI</h3>
      <p class="muted small">Tell the AI anything that helps it name these clips — who's in them, what the shoot is, how to group them. It uses this for every clip in this run.</p>
      <textarea class="ai-input an-dir" rows="3" placeholder="e.g. These are calisthenics clips shot in different backyards — keep them separate from the lawn-mowing jobs. The person is Liam."></textarea>
      <label class="an-remember"><input type="checkbox" class="an-remember-cb" checked /> <span>Remember this for future runs</span></label>
      ${cachedCount ? `<label class="an-remember an-reuse"><input type="checkbox" class="an-reuse-cb" checked /> <span>Reuse earlier analysis of ${cachedCount} of these clip${cachedCount !== 1 ? 's' : ''} (faster)</span></label>` : ''}
      ${hasContent ? `<div class="an-mode"><div class="an-mode-h muted small">Some clips already have content:</div><div class="an-mode-list"></div></div>` : ''}
      <button type="button" class="btn subtle an-rules">Manage filing rules…</button>
      <div class="modal-actions">
        <button type="button" class="btn primary an-go">Analyze</button>
        <button type="button" class="btn an-cancel">Cancel</button>
      </div></div>`;
    document.body.appendChild(ov);
    const q = (s) => ov.querySelector(s);
    const done = (v) => { ov.remove(); resolve(v); };
    const dir = q('.an-dir');
    const rememberCb = q('.an-remember-cb');
    const rememberRow = q('.an-remember:not(.an-reuse)');
    const syncRemember = () => { const has = !!dir.value.trim(); rememberRow.classList.toggle('disabled', !has); rememberCb.disabled = !has; };
    dir.addEventListener('input', syncRemember);
    syncRemember();
    q('.an-rules').addEventListener('click', () => showRoutingRules());
    if (hasContent) {
      const list = q('.an-mode-list');
      for (const o of modeOpts) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'an-mode-opt' + (o.v === mode ? ' sel' : '');
        b.dataset.v = o.v;
        b.innerHTML = `<span class="an-mode-dot"></span><span class="an-mode-tx"><b>${escapeHtml(o.t)}</b><span class="muted small">${escapeHtml(o.d)}</span></span>`;
        b.addEventListener('click', () => { mode = o.v; list.querySelectorAll('.an-mode-opt').forEach((x) => x.classList.toggle('sel', x.dataset.v === mode)); });
        list.appendChild(b);
      }
    }
    const reuseCb = q('.an-reuse-cb');
    q('.an-go').addEventListener('click', () => done({ direction: dir.value.trim(), remember: !!(rememberCb.checked && dir.value.trim()), mode, reuse: reuseCb ? reuseCb.checked : false }));
    q('.an-cancel').addEventListener('click', () => done(null));
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(null); });
    dir.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) q('.an-go').click(); });
    setTimeout(() => dir.focus(), 30);
  });
}

// ---------------------------------------------------------------------------
// In-app feedback tool — Help → Feedback, or right-click → Report feedback.
// We track which UI section was last right-clicked/interacted-with so feedback is
// tagged with where it's about (handy when reviewing it later).
// ---------------------------------------------------------------------------
let lastFeedbackSection = '';
function sectionAt(el) {
  const tagged = el && el.closest && el.closest('[data-section]');
  if (tagged) return tagged.dataset.section;
  // Fallback: the visible top-level screen.
  if (el && el.closest) {
    const card = el.closest('.rename-card');
    if (card) return `Rename clip #${Number(card.dataset.i) + 1}`;
    if (el.closest('#batchBar')) return 'Rename — command bar';
    if (el.closest('#finalize')) return 'Organize / Finalize';
    if (el.closest('.ai-settings')) return 'AI settings';
    if (el.closest('#step1')) return 'Rename screen';
    if (el.closest('#actionList')) return 'Home';
  }
  return 'General';
}
document.addEventListener('contextmenu', (e) => {
  lastFeedbackSection = sectionAt(e.target);
  // Right-clicking ANYWHERE in a clip row targets that clip for "Run AI on this
  // clip" / feedback — not just the description field (that was the bug).
  const card = e.target.closest && e.target.closest('.rename-card');
  if (card) {
    aiCtxIndex = Number(card.dataset.i);
    const desc = card.querySelector('[data-desc]');
    aiFeedbackExample = desc ? (desc.value || '') : '';
  }
}, true);
window.api.onFeedbackOpen(() => showFeedbackReportDialog(lastFeedbackSection));

function showFeedbackReportDialog(section) {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card ai-fb">
    <div class="ai-hd"><span class="ai-hd-icon">📝</span><div class="ai-hd-text"><h3>Report feedback</h3><p class="muted small">Note anything about the app while you build. Saved locally; export anytime.</p></div></div>
    <div class="ai-fb-about">About <code>${escapeHtml(section || 'General')}</code></div>
    <textarea class="ai-textarea fbr-text" rows="4" placeholder="What's working, what isn’t, what you'd change…"></textarea>
    <div class="me-actions"><button type="button" class="btn subtle fbr-img">Attach image…</button><span class="fbr-imgs muted small"></span></div>
    <div class="modal-actions">
      <button type="button" class="btn primary fbr-save">Save feedback</button>
      <button type="button" class="btn fbr-cancel">Cancel</button>
    </div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  let images = [];
  const imgsEl = ov.querySelector('.fbr-imgs');
  const showImgs = () => { imgsEl.textContent = images.length ? `${images.length} image${images.length !== 1 ? 's' : ''} attached` : ''; };
  ov.querySelector('.fbr-img').addEventListener('click', async () => {
    const picked = await window.api.pickImages();
    if (Array.isArray(picked) && picked.length) { images = images.concat(picked); showImgs(); }
  });
  ov.querySelector('.fbr-cancel').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  const ta = ov.querySelector('.fbr-text');
  setTimeout(() => ta.focus(), 30);
  ov.querySelector('.fbr-save').addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text && !images.length) { close(); return; }
    close();
    const r = await window.api.feedbackAdd({ text, section: section || 'General', images });
    showToast(r && r.ok ? 'Feedback saved ✓' : `Couldn’t save: ${r ? r.error : 'unknown'}`);
  });
}

function showFeedbackExportDialog() {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card modal-form ai-fb fbx-card">
    <div class="ai-hd"><span class="ai-hd-icon">📤</span><div class="ai-hd-text"><h3>Export feedback</h3><p class="muted small">Everything you've reported, ready to copy. “Refine with AI” tidies it into a grouped summary.</p></div></div>
    <textarea class="ai-input fbx-text" rows="12" readonly placeholder="Loading…"></textarea>
    <div class="fbx-status muted small"></div>
    <div class="modal-actions">
      <button type="button" class="btn primary fbx-copy">Copy to clipboard</button>
      <button type="button" class="btn fbx-refine">Refine with AI</button>
      <button type="button" class="btn fbx-csv">Save .md file</button>
      <button type="button" class="btn fbx-cancel">Close</button>
    </div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  const status = ov.querySelector('.fbx-status');
  const ta = ov.querySelector('.fbx-text');
  ov.querySelector('.fbx-cancel').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  async function load(refine) {
    status.textContent = refine ? 'Bundling with AI…' : 'Loading…';
    const r = await window.api.feedbackText({ refine });
    if (r && r.ok) { ta.value = r.text; status.textContent = refine ? 'Refined ✓ — copy it below.' : `${(r.text.match(/\n/g) || []).length + 1} notes — copy below.`; }
    else { ta.value = ''; status.textContent = r ? r.error : 'Nothing to export'; }
  }
  ov.querySelector('.fbx-copy').addEventListener('click', async () => {
    if (!ta.value.trim()) { showToast('Nothing to copy yet'); return; }
    let ok = false; try { ok = await window.api.clipboardWrite(ta.value); } catch { ok = false; }
    if (!ok) { try { await navigator.clipboard.writeText(ta.value); ok = true; } catch { /* fall back to select */ } }
    if (ok) { status.textContent = 'Copied to clipboard ✓'; showToast('Feedback copied — paste anywhere'); }
    else { ta.removeAttribute('readonly'); ta.focus(); ta.select(); status.textContent = 'Select-all + Ctrl+C to copy.'; }
  });
  ov.querySelector('.fbx-refine').addEventListener('click', () => load(true));
  ov.querySelector('.fbx-csv').addEventListener('click', async () => {
    const r = await window.api.feedbackExport({ refine: false });
    if (r && r.ok) { status.textContent = `Saved: ${r.path}`; window.api.openFolder(r.path.replace(/[\\/][^\\/]+$/, '')); }
    else status.textContent = `Couldn't save: ${r ? r.error : 'unknown'}`;
  });
  load(false);
}

// Review the AI's pending questions, one per step. Handles all question types:
//  - subject / category : confirm a brand-new value (use new / existing / custom / skip)
//  - rule               : remember a learned preference, or discard it
// Resolves each question as it's answered; confirmed rules are committed to memory
// in one batch at the end. Opened only via the ⚠ indicator → Review.
function showAiReview() {
  const items = aiQuestions.slice();   // snapshot of what to walk through
  if (!items.length) { showToast('No AI questions right now'); return; }
  let step = 0;
  const confirmedRules = [];
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card ai-wiz">
    <div class="illo mob-illo">${ILLO_ASK}</div>
    <div class="ai-hd" style="margin-top:2px"><div class="ai-hd-text"><h3>Review AI questions</h3><p class="muted small">The AI only asks when it's unsure — confirm a new subject/category, or whether to remember something it learned.</p></div></div>
    <div class="wiz-stepno muted small"></div>
    <div class="wiz-body"></div>
    <div class="modal-actions">
      <button type="button" class="btn wiz-back">Back</button>
      <button type="button" class="btn primary wiz-next">Next</button>
    </div></div>`;
  document.body.appendChild(ov);
  const $w = (s) => ov.querySelector(s);
  const body = $w('.wiz-body');
  let wizSelect = null;   // custom dropdown for "use an existing subject/category"
  // Live looping preview of the clip being reviewed (decode-session-safe: only one
  // <video> at a time — we free the grid's active video first).
  let reviewVid = null;
  function unmountReviewVideo() { if (reviewVid) { try { reviewVid.pause(); reviewVid.removeAttribute('src'); reviewVid.load(); reviewVid.remove(); } catch { /* ignore */ } reviewVid = null; } }
  async function mountReviewVideo(clip, holder) {
    unmountReviewVideo();
    if (activeVideoIndex !== null) teardownVideo(activeVideoIndex);   // never two HEVC decoders
    if (!clip || !holder) return;
    const url = await window.api.mediaUrl(clip.sourcePath);
    if (!holder.isConnected) return;   // stepped away while awaiting
    const v = document.createElement('video');
    v.className = 'wiz-video'; v.muted = true; v.loop = true; v.autoplay = true; v.playbackRate = currentSpeed;
    v.addEventListener('error', () => { /* keep the poster fallback */ });
    v.src = url;
    holder.innerHTML = ''; holder.appendChild(v);
    reviewVid = v;
    v.play().catch(() => { /* autoplay race */ });
  }
  const close = () => { unmountReviewVideo(); ov.remove(); };
  const thumbImg = (clip) => (clip && clip.posterUrl ? `<img class="wiz-thumb" src="${escapeAttr(clip.posterUrl)}" alt="" />` : '');

  function render() {
    const it = items[step];
    $w('.wiz-stepno').textContent = `${step + 1} of ${items.length}`;
    if (it.type === 'rule') {
      unmountReviewVideo();   // no clip for rule steps
      body.innerHTML = `
        <div class="wiz-rule">
          <p class="wiz-rule-q">Want me to remember this?</p>
          <input type="text" class="wiz-rule-text ai-input" value="${escapeAttr(it.rule)}" />
          ${it.example ? `<div class="wiz-rule-eg muted small">e.g. ${escapeHtml(it.example)}</div>` : ''}
          <div class="wiz-options">
            <label class="fin-radio"><input type="radio" name="wiz" value="remember" checked /> <span>Remember it (add to Memory)</span></label>
            <label class="fin-radio"><input type="radio" name="wiz" value="discard" /> <span>Don't remember</span></label>
          </div>
        </div>`;
    } else if (it.type === 'confirm') {
      const clip = state.scannedFiles[it.clipIndex];
      body.innerHTML = `
        <div class="wiz-clip"><span class="wiz-media">${thumbImg(clip)}</span><span class="wiz-name">${escapeHtml(clip ? clip.name : '')}</span></div>
        <p class="muted small" style="margin:4px 0 8px">The AI named this — fix anything wrong (your corrections teach it), or just hit Next if it's right.</p>
        <label class="pref-label">Subject</label><input type="text" class="ai-input wiz-cf-subject" value="${escapeAttr(clip ? (clip.subject || '') : '')}" />
        <label class="pref-label" style="margin-top:8px">Description</label><input type="text" class="ai-input wiz-cf-desc" value="${escapeAttr(clip ? (clip.description || '') : '')}" />`;
      mountReviewVideo(clip, $w('.wiz-media'));
    } else {
      const clip = state.scannedFiles[it.clipIndex];
      const kind = it.type === 'category' ? 'category' : 'subject';
      const existing = it.type === 'category' ? (fieldHistoryCache[it.field || 'category'] || []) : subjectsCache;
      body.innerHTML = `
        <div class="wiz-clip"><span class="wiz-media">${thumbImg(clip)}</span><span class="wiz-name">${escapeHtml(clip ? clip.name : '')}</span></div>
        <div class="wiz-options">
          <label class="fin-radio"><input type="radio" name="wiz" value="new" checked /> <span>Use new ${kind}: <b>${escapeHtml(it.suggested)}</b></span></label>
          <label class="fin-radio"><input type="radio" name="wiz" value="existing" /> <span>Use an existing ${kind}</span> <span class="wiz-existing-mount"></span></label>
          <label class="fin-radio"><input type="radio" name="wiz" value="custom" /> <span>Type my own</span> <input type="text" class="wiz-custom ai-input" placeholder="${kind}" /></label>
          <label class="fin-radio"><input type="radio" name="wiz" value="skip" /> <span>Skip (leave blank)</span></label>
        </div>`;
      wizSelect = createSelect({ value: existing[0] || '', placeholder: '(none yet)', empty: '(none yet)', style: 'min-width:150px' });
      wizSelect.setOptions(existing.map((s) => ({ value: s, label: s })));
      $w('.wiz-existing-mount').appendChild(wizSelect.el);
      mountReviewVideo(clip, $w('.wiz-media'));
    }
    $w('.wiz-back').disabled = step === 0;
    $w('.wiz-next').textContent = step === items.length - 1 ? 'Finish' : 'Next';
  }
  function applyCurrent() {
    const it = items[step];
    if (it.type === 'rule') {
      const choice = ov.querySelector('input[name="wiz"]:checked').value;
      if (choice === 'remember') { const t = ($w('.wiz-rule-text').value || '').trim(); if (t) confirmedRules.push({ text: t, example: it.example || '' }); }
    } else if (it.type === 'confirm') {
      const clip = state.scannedFiles[it.clipIndex];
      if (clip) {
        const ns = slug($w('.wiz-cf-subject').value);
        const nd = slug($w('.wiz-cf-desc').value);
        if (ns !== (clip.subject || '')) { recordAiEdit(clip, 'subject', ns); clip.subject = ns; if (ns) rememberSubject(ns); }
        if (nd !== (clip.description || '')) { recordAiEdit(clip, 'description', nd); clip.description = nd; if (nd) rememberDescription(nd); }
        syncRowInputs([it.clipIndex]);
      }
    } else {
      const choice = ov.querySelector('input[name="wiz"]:checked').value;
      const clip = state.scannedFiles[it.clipIndex];
      let value = '';
      if (choice === 'new') value = it.suggested;
      else if (choice === 'existing') value = (wizSelect && wizSelect.value) || '';
      else if (choice === 'custom') value = slug($w('.wiz-custom').value);
      if (clip && choice !== 'skip' && value) {
        if (it.type === 'category') { clip[it.field || 'category'] = value; rememberField(it.field || 'category', value); }
        else { clip.subject = value; rememberSubject(value); }
        syncRowInputs([it.clipIndex]);
      }
    }
    resolveAiQuestion(it.id);
  }
  $w('.wiz-back').addEventListener('click', () => { if (step > 0) { step -= 1; render(); } });
  $w('.wiz-next').addEventListener('click', async () => {
    applyCurrent();
    if (step < items.length - 1) { step += 1; render(); return; }
    refreshNames();
    close();
    if (confirmedRules.length) {
      const r = await window.api.aiAddMemories(confirmedRules);
      if (r && r.ok && Array.isArray(r.memories)) aiCfg.memories = r.memories;
    }
    maybeFlushEdits(true);   // learn from any corrections made in the confirm steps
    showToast('All caught up ✓');
  });
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) { refreshNames(); close(); } });
  render();
}

// Full editor for one memory — write freely, optionally Refine with AI (compacts
// to a tidy keyword rule, keeping the original for a one-click revert).
function showMemoryEditor(initial, onSave) {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card ai-memedit">
    <div class="illo mob-illo">${ILLO_MEMORY}</div>
    <div class="ai-hd" style="margin-top:2px"><div class="ai-hd-text"><h3>Add a memory</h3><p class="muted small">Write a preference in your own words. "Refine with AI" tidies it into a keyword rule — you can always revert.</p></div></div>
    <label class="pref-label">Rule</label>
    <textarea class="ai-textarea me-text" rows="4" placeholder="e.g. always put the person's name in the subject, like josiah-lawn-mow">${escapeHtml(initial.text || '')}</textarea>
    <label class="pref-label" style="margin-top:10px">Example <span class="muted small">(optional)</span></label>
    <input type="text" class="ai-input me-eg" value="${escapeAttr(initial.example || '')}" placeholder="a concrete example" />
    <div class="me-actions">
      <button type="button" class="btn me-refine">✨ Refine with AI</button>
      <button type="button" class="btn subtle me-revert hidden">Revert</button>
      <span class="me-status muted small"></span>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn primary me-save">Save</button>
      <button type="button" class="btn me-cancel">Cancel</button>
    </div></div>`;
  document.body.appendChild(ov);
  const q = (s) => ov.querySelector(s);
  const close = () => ov.remove();
  let original = null;   // snapshot before a refine, for revert
  q('.me-refine').addEventListener('click', async () => {
    const text = q('.me-text').value.trim();
    if (!text) { showToast('Write something first'); return; }
    if (!aiReady()) { showToast('Turn on AI first'); return; }
    original = { text: q('.me-text').value, example: q('.me-eg').value };
    const btn = q('.me-refine'); btn.disabled = true; q('.me-status').textContent = 'Refining…';
    const r = await window.api.aiRefineMemory(text);
    btn.disabled = false;
    if (r && r.ok) { q('.me-text').value = r.text; if (r.example) q('.me-eg').value = r.example; q('.me-status').textContent = 'Refined ✓'; q('.me-revert').classList.remove('hidden'); }
    else { q('.me-status').textContent = `Couldn’t refine: ${r ? r.error : 'unknown'}`; }
  });
  q('.me-revert').addEventListener('click', () => {
    if (original) { q('.me-text').value = original.text; q('.me-eg').value = original.example; q('.me-status').textContent = 'Reverted'; q('.me-revert').classList.add('hidden'); }
  });
  q('.me-save').addEventListener('click', () => {
    const text = q('.me-text').value.trim();
    if (!text) { showToast('Write something first'); return; }
    onSave({ text, example: q('.me-eg').value.trim() });
    close();
  });
  q('.me-cancel').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  setTimeout(() => q('.me-text').focus(), 30);
}

// Reusable confirm dialog for a set of AI-proposed memory rules (used by
// "Learn my style" and "Tidy & group"). opts.replace → replaces the whole list.
function showProposedRulesDialog(title, subtitle, proposed, onApplied, opts = {}) {
  const replace = !!opts.replace;
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card ai-import">
    <div class="ai-hd"><span class="ai-hd-icon">✨</span><div class="ai-hd-text"><h3>${escapeHtml(title)}</h3><p class="muted small">${escapeHtml(subtitle)}</p></div></div>
    <div class="imp-results"></div>
    <div class="modal-actions"><button type="button" class="btn primary pr-apply">${replace ? 'Apply' : 'Add selected'}</button><button type="button" class="btn pr-cancel">Cancel</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  const res = ov.querySelector('.imp-results');
  proposed.forEach((p, i) => {
    const row = document.createElement('label'); row.className = 'fin-radio imp-row';
    row.innerHTML = `<input type="checkbox" data-i="${i}" checked /> <span>${escapeHtml(p.text)}${p.example ? ` <span class="muted small">— e.g. ${escapeHtml(p.example)}</span>` : ''}</span>`;
    res.appendChild(row);
  });
  ov.querySelector('.pr-cancel').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('.pr-apply').addEventListener('click', async () => {
    const picked = [...ov.querySelectorAll('.imp-row input:checked')].map((cb) => proposed[Number(cb.dataset.i)]).filter(Boolean);
    if (!picked.length) { showToast('Tick at least one'); return; }
    const r = replace ? await window.api.aiReplaceMemories(picked) : await window.api.aiAddMemories(picked);
    if (r && r.ok) { if (Array.isArray(r.memories)) aiCfg.memories = r.memories; onApplied(r.memories || []); showToast(replace ? 'Memories grouped ✓' : `Added ${picked.length} ✓`); close(); }
    else showToast(`Couldn't apply: ${r ? r.error : 'unknown'}`);
  });
}

// Import a document (naming SOP / notes) — paste text or choose a file, AI
// extracts proposed rules, you tick which to keep.
function showImportDialog(onAdd) {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card ai-import">
    <div class="illo mob-illo">${ILLO_DOC}</div>
    <div class="ai-hd" style="margin-top:2px"><div class="ai-hd-text"><h3>Import notes / SOP</h3><p class="muted small">Paste your naming notes (or choose a .txt/.md file). The AI pulls out the useful rules — you choose which to keep.</p></div></div>
    <textarea class="ai-textarea imp-text" rows="6" placeholder="Paste your naming SOP / notes here…"></textarea>
    <div class="me-actions">
      <button type="button" class="btn subtle imp-file">Choose file…</button>
      <button type="button" class="btn imp-extract">Extract rules</button>
      <span class="imp-status muted small"></span>
    </div>
    <div class="imp-results"></div>
    <div class="modal-actions">
      <button type="button" class="btn primary imp-add hidden">Add selected</button>
      <button type="button" class="btn imp-cancel">Close</button>
    </div></div>`;
  document.body.appendChild(ov);
  const q = (s) => ov.querySelector(s);
  const close = () => ov.remove();
  let proposed = [];
  q('.imp-file').addEventListener('click', async () => {
    const p = await window.api.pickFile({ title: 'Choose a notes / SOP document' });
    if (p) { q('.imp-status').textContent = p.split(/[\\/]/).pop(); ov.dataset.path = p; }
  });
  q('.imp-extract').addEventListener('click', async () => {
    if (!aiReady()) { showToast('Turn on AI first'); return; }
    const text = q('.imp-text').value.trim();
    const path = ov.dataset.path || '';
    if (!text && !path) { showToast('Paste notes or choose a file'); return; }
    const btn = q('.imp-extract'); btn.disabled = true; q('.imp-status').textContent = 'Reading & extracting…';
    const r = await window.api.aiImportDoc(text ? { text } : { path });
    btn.disabled = false;
    if (!r || !r.ok) { q('.imp-status').textContent = `Couldn’t extract: ${r ? r.error : 'unknown'}`; return; }
    proposed = r.proposed || [];
    q('.imp-status').textContent = `Found ${proposed.length} rule${proposed.length !== 1 ? 's' : ''}`;
    const res = q('.imp-results'); res.innerHTML = '';
    proposed.forEach((p, i) => {
      const row = document.createElement('label'); row.className = 'fin-radio imp-row';
      row.innerHTML = `<input type="checkbox" data-i="${i}" checked /> <span>${escapeHtml(p.text)}${p.example ? ` <span class="muted small">— e.g. ${escapeHtml(p.example)}</span>` : ''}</span>`;
      res.appendChild(row);
    });
    q('.imp-add').classList.toggle('hidden', !proposed.length);
  });
  q('.imp-add').addEventListener('click', async () => {
    const picked = [...ov.querySelectorAll('.imp-row input:checked')].map((cb) => proposed[Number(cb.dataset.i)]).filter(Boolean);
    if (!picked.length) { showToast('Tick at least one'); return; }
    const r = await window.api.aiAddMemories(picked);
    if (r && r.ok) { if (Array.isArray(r.memories)) aiCfg.memories = r.memories; onAdd(picked); showToast(`Added ${picked.length} memor${picked.length !== 1 ? 'ies' : 'y'} ✓`); close(); }
    else showToast(`Couldn't add: ${r ? r.error : 'unknown'}`);
  });
  q('.imp-cancel').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  setTimeout(() => q('.imp-text').focus(), 30);
}

// ---------------------------------------------------------------------------
// AI feedback → memory: right-click a description → AI → Leave feedback.
// ---------------------------------------------------------------------------
function showAiFeedbackDialog(example) {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card ai-fb">
    <div class="ai-hd">
      <span class="ai-hd-icon">✨</span>
      <div class="ai-hd-text">
        <h3>Teach the AI</h3>
        <p class="muted small">Say what you like or don't like — it becomes a memory the AI follows next time.</p>
      </div>
    </div>
    ${example ? `<div class="ai-fb-about">About this name <code>${escapeHtml(example)}</code></div>` : ''}
    <textarea class="ai-textarea aifb-text" rows="4" placeholder="e.g. descriptions are too long and literal — keep them to 2-3 keywords, no filler words like 'a' or 'the'"></textarea>
    <div class="modal-actions">
      <button type="button" class="btn primary aifb-save">Save to memory</button>
      <button type="button" class="btn aifb-cancel">Cancel</button>
    </div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('.aifb-cancel').addEventListener('click', close);
  const ta = ov.querySelector('.aifb-text');
  setTimeout(() => ta.focus(), 30);
  ov.querySelector('.aifb-save').addEventListener('click', async () => {
    const feedback = ta.value.trim();
    if (!feedback) { close(); return; }
    close();
    showToast('Feedback received — updating AI memory…', 120000);
    const r = await window.api.aiFeedback({ feedback, example: example || '' });
    if (r && r.ok) {
      if (Array.isArray(r.memories)) aiCfg.memories = r.memories;
      const added = (r.added && r.added.length) ? `: ${r.added.join(' · ')}` : '';
      showToast(`AI memory updated ✓${added}`);
    } else showToast(`Couldn't save feedback: ${r ? r.error : 'unknown'}`);
  });
}
// Run the AI on a single clip by index (shared by the right-click menu + AI submenu).
function runAiOnClip(idx) {
  if (!requireAi()) return;
  if (!(idx >= 0 && state.scannedFiles[idx])) { showToast('No clip to analyze'); return; }
  if (uiPrefs.autoVersionOnAi !== false) saveVersionPoint(`Before AI · ${state.scannedFiles[idx].name}`, true);
  setTask('ai', aiModelLabel(), 1, 1);
  markClipAnalyzing(idx, 'analyzing');
  aiSuggestClip(idx, 'all').then((r) => {
    markClipAnalyzing(idx, false);
    clearTask('ai');
    if (r && r.ok) {
      if (r.switchedTo) aiCfg.model = r.switchedTo;
      if (r.newSubject) addAiQuestion({ type: 'subject', clipIndex: idx, suggested: r.newSubject });
      if (r.newCategory) addAiQuestion({ type: 'category', clipIndex: idx, field: 'category', suggested: r.newCategory });
      showToast(aiQuestions.length ? 'AI done · question to review ⚠' : 'AI done ✓');
      if (r.note) showToast(r.note, 8000);
    }
  });
}
// Right-click AI submenu actions.
window.api.onAiMenu((action) => {
  if (action === 'settings') { showAiSettings(); return; }
  if (!aiCfg.enabled) { showToast('Enable AI in Edit → AI → AI settings first'); return; }
  if (action === 'feedback') showAiFeedbackDialog(aiFeedbackExample);
  else if (action === 'run-this') {
    if (aiCtxIndex >= 0 && state.scannedFiles[aiCtxIndex]) runAiOnClip(aiCtxIndex);
    else showToast('Right-click a clip\'s description first');
  } else if (action === 'analyze') aiAnalyzeSelected();
});
// When the AI learns new rules (feedback / edits / reflect) and you already have
// analyzed clips, nudge — from the bottom — that you can re-apply them.
let lastMemCount = 0;
let learnedSinceImprove = 0;
window.api.onAiMemoryUpdated((p) => {
  if (p && Array.isArray(p.memories)) {
    const grew = lastMemCount && p.memories.length > lastMemCount ? p.memories.length - lastMemCount : 0;
    lastMemCount = p.memories.length;
    aiCfg.memories = p.memories;
    if (grew) { learnedSinceImprove += grew; maybeOfferReimprove(); }
  }
});
let reimproveBanner = null;
function maybeOfferReimprove() {
  if (learnedSinceImprove < 3) return;                                   // only after a few new rules
  const anyNamed = (state.scannedFiles || []).some((c) => (c.subject || c.description));
  if (!anyNamed || reimproveBanner) return;
  reimproveBanner = document.createElement('div');
  reimproveBanner.className = 'reimprove-banner';
  reimproveBanner.innerHTML = `<span class="rb-ic">${typeof SCAN_ANIM !== 'undefined' ? SCAN_ANIM : '🧠'}</span><span class="rb-tx">You've taught the AI ${learnedSinceImprove} new thing${learnedSinceImprove !== 1 ? 's' : ''} — re-improve your descriptions with it?</span><button type="button" class="btn primary rb-go">Re-improve</button><button type="button" class="rb-x" title="Dismiss">✕</button>`;
  document.body.appendChild(reimproveBanner);
  requestAnimationFrame(() => reimproveBanner.classList.add('show'));
  const close = () => { if (reimproveBanner) { reimproveBanner.classList.remove('show'); const b = reimproveBanner; reimproveBanner = null; setTimeout(() => b.remove(), 240); } };
  reimproveBanner.querySelector('.rb-x').addEventListener('click', () => { learnedSinceImprove = 0; close(); });
  reimproveBanner.querySelector('.rb-go').addEventListener('click', () => { learnedSinceImprove = 0; close(); aiImproveSelected(); });
}

// Apply this clip's date/subject/description to every ticked clip (and itself),
// so a whole group shares one name; versions auto-number afterwards.
async function applyRowNameToSelected(i) {
  const src = state.scannedFiles[i];
  if (!src) return;
  const copyDate = await decideCopyDate();
  if (copyDate === null) return;     // user cancelled the ask-popup
  const targets = state.scannedFiles
    .map((c, idx) => ({ c, idx }))
    .filter(({ c }) => c.selected || c === src);
  for (const { c } of targets) {
    if (copyDate) { c.date = src.date; c.dateLocked = src.dateLocked || !!src.date; }
    c.subject = src.subject;
    c.description = src.description;
    for (const fld of organizeFields) c[fld.id] = src[fld.id];
  }
  syncRowInputs(targets.map((t) => t.idx));
  rememberSubject(src.subject);
  rememberDescription(src.description);
  for (const fld of organizeFields) rememberField(fld.id, src[fld.id]);
  clearSelection();                 // applied → untick the group
  refreshNames();
}

// Push state values back into a set of rows' input fields.
function syncRowInputs(indices) {
  for (const idx of indices) {
    const clip = state.scannedFiles[idx]; if (!clip) continue;
    // One document lookup for the card, then scoped lookups inside it (faster + fewer
    // global queries — this runs per-clip during AI runs and per-index on batch apply).
    const card = document.querySelector(`.rename-card[data-i="${idx}"]`);
    if (!card) continue;
    const s = card.querySelector('[data-subject]'); if (s) s.value = clip.subject || '';
    const d = card.querySelector('[data-desc]'); if (d) d.value = clip.description || '';
    const dt = card.querySelector('[data-date]'); if (dt) setDateField(dt, clip.date);
    const loc = card.querySelector('[data-location]'); if (loc) loc.value = clip.location || '';
    for (const fld of organizeFields) {
      const inp = card.querySelector(`.meta-row [data-field="${fld.id}"]`);
      if (inp) inp.value = clip[fld.id] || '';
    }
  }
}

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
    ph.textContent = 'No preview';
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
    wrap.innerHTML = '<span class="placeholder">Preview unavailable</span>';
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

  // Default the batch date to the first selected clip so a batch shares one
  // identical name (versions then differentiate). User can still override it.
  if (count > 0 && !$('batchDate').dataset.value && sel[0].date) {
    setDateField($('batchDate'), sel[0].date);
  }
  renderCheckedStrip();
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
  attachCombo(q('.bd-subject'), () => subjectsCache, () => q('.bd-desc'));
  attachCombo(q('.bd-desc'), () => descriptionsCache, () => q('.bd-location'));
  attachCombo(q('.bd-location'), () => locationsCache, () => q('.bd-context'));
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
  state.scannedFiles.forEach((c) => { c.selected = on; });
  document.querySelectorAll('[data-check]').forEach((cb) => { cb.checked = on; });
  document.querySelectorAll('.rename-card').forEach((card) => card.classList.toggle('selected', on));
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
  for (const i of sel) {
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
}

$('rpJumpBtn').addEventListener('click', jumpNextUnnamed);
$('checkedClearBtn').addEventListener('click', clearSelection);

// ---------------------------------------------------------------------------
// Pop-out preview window — mirrors the clip you're currently working on
// ---------------------------------------------------------------------------
let previewOpen = false;
let lastPreviewIndex = null;
function maybePreview(i) {
  lastPreviewIndex = i;
  if (!previewOpen) return;
  const clip = state.scannedFiles[i];
  // Mirror the in-card preview: muted unless "Play audio on hover" is on, same speed.
  if (clip) window.api.previewSet(clip.sourcePath, clip.name, { muted: !uiPrefs.autoplayAudio, speed: currentSpeed });
}
// Re-push the current clip when the mute/speed settings change.
function refreshPreview() { if (previewOpen && lastPreviewIndex != null) maybePreview(lastPreviewIndex); }
async function togglePreviewWindow() {
  const r = await window.api.togglePreview();
  previewOpen = !!(r && r.open);
  if (previewOpen) {
    const card = document.activeElement && document.activeElement.closest
      && document.activeElement.closest('.rename-card');
    if (card) maybePreview(Number(card.dataset.i));
    else if (state.scannedFiles.length) maybePreview(0);
  }
}
window.api.onPreviewClosed(() => { previewOpen = false; });
window.api.previewState().then((s) => { previewOpen = !!(s && s.open); });

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

// ---------------------------------------------------------------------------
// Custom Fluent date field + calendar flyout (replaces native <input type=date>)
// ---------------------------------------------------------------------------
function setDateField(btn, dateStr) {
  btn.dataset.value = dateStr || '';
  const txt = btn.querySelector('.df-text');
  if (dateStr) { txt.textContent = dateStr; txt.classList.remove('muted'); }
  else { txt.textContent = 'Date'; txt.classList.add('muted'); }
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Calendar with day → month → year zoom levels (click the title to zoom out),
// so changing the year is one or two clicks instead of paging month-by-month.
function openCalendar(anchor, currentStr, onPick) {
  const cal = document.createElement('div');
  cal.className = 'flyout calendar';
  const base = currentStr ? new Date(`${currentStr}T00:00:00`) : new Date();
  let vy = base.getFullYear();
  let vm = base.getMonth();
  let mode = 'day'; // 'day' | 'month' | 'year'

  function head(title) {
    return `<div class="cal-head"><button type="button" class="cal-title">${title}</button>
      <span class="cal-nav"><button type="button" class="cal-prev" title="Previous">‹</button>
      <button type="button" class="cal-next" title="Next">›</button></span></div>`;
  }

  function renderDay() {
    const firstDow = new Date(vy, vm, 1).getDay();
    const days = new Date(vy, vm + 1, 0).getDate();
    let html = head(`${MONTHS[vm]} ${vy}`)
      + `<div class="cal-grid cal-dow">${WEEKDAYS.map((d) => `<span>${d}</span>`).join('')}</div>`
      + '<div class="cal-grid cal-days">';
    for (let i = 0; i < firstDow; i += 1) html += '<span class="cal-day empty"></span>';
    for (let d = 1; d <= days; d += 1) {
      const ds = `${vy}-${String(vm + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      html += `<button type="button" class="cal-day${ds === currentStr ? ' selected' : ''}" data-d="${ds}">${d}</button>`;
    }
    html += '</div><div class="cal-foot"><button type="button" class="cal-today">Today</button></div>';
    cal.innerHTML = html;
    cal.querySelector('.cal-prev').onclick = () => { vm -= 1; if (vm < 0) { vm = 11; vy -= 1; } render(); };
    cal.querySelector('.cal-next').onclick = () => { vm += 1; if (vm > 11) { vm = 0; vy += 1; } render(); };
    cal.querySelector('.cal-title').onclick = () => { mode = 'month'; render(); };
    cal.querySelector('.cal-today').onclick = () => { onPick(toDateStr(Date.now())); closePopover(); };
    cal.querySelectorAll('.cal-day[data-d]').forEach((b) => {
      b.onclick = () => { onPick(b.dataset.d); closePopover(); };
    });
  }

  function renderMonth() {
    let html = head(`${vy}`) + '<div class="cal-grid cal-cells">';
    for (let m = 0; m < 12; m += 1) {
      const sel = (m === vm && vy === base.getFullYear()) ? ' selected' : '';
      html += `<button type="button" class="cal-cell${sel}" data-m="${m}">${MONTHS_SHORT[m]}</button>`;
    }
    html += '</div>';
    cal.innerHTML = html;
    cal.querySelector('.cal-prev').onclick = () => { vy -= 1; render(); };
    cal.querySelector('.cal-next').onclick = () => { vy += 1; render(); };
    cal.querySelector('.cal-title').onclick = () => { mode = 'year'; render(); };
    cal.querySelectorAll('.cal-cell[data-m]').forEach((b) => {
      b.onclick = () => { vm = Number(b.dataset.m); mode = 'day'; render(); };
    });
  }

  function renderYear() {
    const start = vy - (vy % 10) - 1; // decade block
    let html = head(`${start + 1} – ${start + 10}`) + '<div class="cal-grid cal-cells">';
    for (let i = 0; i < 12; i += 1) {
      const y = start + i;
      const muted = (i === 0 || i === 11) ? ' muted' : '';
      const sel = y === vy ? ' selected' : '';
      html += `<button type="button" class="cal-cell${sel}${muted}" data-y="${y}">${y}</button>`;
    }
    html += '</div>';
    cal.innerHTML = html;
    cal.querySelector('.cal-prev').onclick = () => { vy -= 10; render(); };
    cal.querySelector('.cal-next').onclick = () => { vy += 10; render(); };
    cal.querySelector('.cal-title').onclick = () => {};
    cal.querySelectorAll('.cal-cell[data-y]').forEach((b) => {
      b.onclick = () => { vy = Number(b.dataset.y); mode = 'month'; render(); };
    });
  }

  function render() {
    if (mode === 'day') renderDay();
    else if (mode === 'month') renderMonth();
    else renderYear();
  }
  render();
  showPopover(anchor, cal);
}

// Batch date field
$('batchDate').addEventListener('click', (e) => {
  e.stopPropagation();
  if (openPopover) { closePopover(); return; }
  openCalendar($('batchDate'), $('batchDate').dataset.value || '', (ds) => {
    setDateField($('batchDate'), ds);
    updateBatchBar();
  });
});

// ---------------------------------------------------------------------------
// Menu bar (File / Edit / View / Help) — digiKam-style; home for future features
// ---------------------------------------------------------------------------
const MENUS = {
  // File = navigation hub — jump to any screen from anywhere.
  file: [
    { label: 'Home', action: goHome },
    { label: 'Name & copy clips', action: goToRename },
    { label: 'Organize & back up…', action: openFinalize },
    { sep: true },
    { label: 'Choose drive…', action: () => $('manualPickBtn').click() },
    { label: 'Open intake folder', action: () => window.api.openFolder(state.intakeFolder) },
    { label: 'Open Projects folder', action: async () => { try { const r = await window.api.getProjectsRoot(); if (r) window.api.openFolder(r); } catch { /* ignore */ } } },
    { sep: true },
    { label: 'Quit', action: () => window.api.quit() }
  ],
  edit: [
    { label: 'Settings…', action: showSettingsHub },
    { label: 'Keyboard shortcuts…', action: showKeyboardShortcuts },
    { sep: true },
    { label: 'Preferences…', action: showPreferences },
    { label: 'Organizing fields…', action: showOrganizeFields },
    { label: 'Edit subjects…', action: showEditSubjects },
    { sep: true },
    { label: 'Filing & destinations', submenu: () => [
      { label: 'Visualize destinations…', action: showDestinationMapAuto },
      { label: 'Projects index…', desc: 'Browse filed projects + their AI summaries; search people, places, contents.', action: showProjectsIndex },
      { label: 'Undo last organize…', desc: 'Move the clips from the last Organize back out of the Projects tree.', action: undoLastOrganize },
      { label: 'Filing rules…', action: () => showRoutingRules() },
      { label: 'Restore previous naming…', action: restoreDraftsNow },
      { label: 'Save point now', action: () => saveVersionPoint('Manual save point', false) },
      { label: 'Version history…', action: showVersionHistory }
    ] },
    { label: 'AI',
      submenu: () => [
        { header: 'Name your footage' },
        { label: 'Analyze selected clips', desc: 'One pass: scans faces → you confirm who’s who → then watches & names the ticked clips, people woven in.', action: aiAnalyzeSelected },
        { label: 'Improve descriptions', desc: 'Sharpens names already written (yours or AI’s) using the saved analysis — keeps your subjects.', action: aiImproveSelected },
        { label: 'Auto-name everything (background)', desc: 'Analyzes every still-unnamed clip on its own while you keep working.', action: aiAutoEnhance },
        { sep: true },
        { header: 'People' },
        { label: 'People & faces…', desc: 'Tag who’s in each clip so names and metadata can use real names.', action: showPeopleManager },
        { label: 'Use names in descriptions (instant)', desc: 'Swaps generic words like “a man” for the recognized name. No AI call, instant.', action: applyNamesToDescriptions },
        { sep: true },
        { header: 'Teach & tune' },
        { label: 'Auto-analyze after copying', desc: 'Analyze footage in the background right after copy, so it organizes itself later.', type: 'check', checked: uiPrefs.autoAnalyzeAfterCopy !== false, action: () => togglePref('autoAnalyzeAfterCopy') },
        { label: 'Learn rules from this analysis', desc: 'Turns what was seen + how you named it into saved preferences for next time.', action: learnFromAnalysisNow },
        { label: 'AI settings…', action: showAiSettings },
        { label: 'Models — browse & download…', action: () => showModelStore() }
      ] }
  ],
  view: [
    // Layout/display toggles tucked into one submenu so the View menu stays tidy.
    { label: 'Display options', submenu: () => [
      { label: 'Simple naming (Subject + Description)', type: 'check', checked: uiPrefs.cleanGrid !== false, action: () => togglePref('cleanGrid') },
      { label: 'Category/Project per clip', type: 'check', checked: uiPrefs.showMetaRow, action: () => togglePref('showMetaRow') },
      { label: 'Location field per clip', type: 'check', checked: !!uiPrefs.showLocation, action: () => togglePref('showLocation') },
      { label: 'Command bar', type: 'check', checked: uiPrefs.showCommandBar, action: () => togglePref('showCommandBar') },
      { label: 'Compact view', type: 'check', checked: uiPrefs.compact, action: () => togglePref('compact') },
      { label: 'Show result filename', type: 'check', checked: uiPrefs.showResult, action: () => togglePref('showResult') },
      { label: 'Group by day (date dividers)', type: 'check', checked: uiPrefs.dayDividers !== false, action: () => { togglePref('dayDividers'); if (state.scannedFiles.length && !$('step1').classList.contains('hidden')) buildRenameStep(); } },
      { label: 'Naming help', type: 'check', checked: uiPrefs.showHelp, action: () => togglePref('showHelp') },
      { label: 'Save a version before each AI run', type: 'check', checked: uiPrefs.autoVersionOnAi !== false, action: () => togglePref('autoVersionOnAi') },
      { label: 'Auto-restore previous naming (off = start fresh / ask)', type: 'check', checked: uiPrefs.autoRestore !== false, action: () => togglePref('autoRestore') }
    ] },
    { sep: true },
    { label: () => `Preview speed: ${currentSpeed}×`,
      submenu: () => SPEED_OPTIONS.map((s) => ({ label: `${s}×`, checked: s === currentSpeed, action: () => setSpeed(s) })) },
    { label: () => `Copy date to selected: ${({ always: 'Always', ask: 'Ask', never: 'Never' }[copyDateMode] || 'Always')}`,
      submenu: () => [
        { label: 'Always copy date', checked: copyDateMode === 'always', action: () => setCopyDateMode('always') },
        { label: 'Ask each time', checked: copyDateMode === 'ask', action: () => setCopyDateMode('ask') },
        { label: 'Never copy date', checked: copyDateMode === 'never', action: () => setCopyDateMode('never') }
      ] },
    { label: () => `Enter after description: ${enterFlow === 'row' ? 'Along the row' : 'Next clip'}`,
      submenu: () => [
        { label: 'Jump to the next clip (do subjects, then categories)', checked: enterFlow === 'columns', action: () => setEnterFlow('columns') },
        { label: 'Continue along the row (→ category → project)', checked: enterFlow === 'row', action: () => setEnterFlow('row') }
      ] },
    { sep: true },
    { label: 'Play audio on hover', type: 'check', checked: () => uiPrefs.autoplayAudio, action: () => togglePref('autoplayAudio') },
    { label: 'Pop-out preview window', type: 'check', checked: () => previewOpen, action: togglePreviewWindow },
    { label: 'Show notifications', type: 'check', checked: () => uiPrefs.notifications, action: () => togglePref('notifications') },
    { sep: true },
    { label: 'Back to home', action: goHome },
    { label: 'Open intake folder', action: () => window.api.openFolder(state.intakeFolder) }
  ],
  help: [
    { label: 'Setup wizard…', action: () => showSetupWizard() },
    { label: 'How this app works…', action: () => showWorkflowGuide() },
    { label: 'Take a tour', action: () => startTour() },
    { label: 'Command palette… (Ctrl+K)', action: () => showCommandPalette() },
    { sep: true },
    { label: 'Feedback',
      submenu: () => [
        { label: 'Report feedback…', action: () => showFeedbackReportDialog(lastFeedbackSection) },
        { label: 'Export feedback…', action: showFeedbackExportDialog }
      ] },
    { label: 'Activity log…', action: showActivityLog },
    { label: 'Copy diagnostics…', action: showDiagnostics },
    { sep: true },
    { label: 'Simulate a phone (testing)', type: 'check', checked: () => !!(cfg && cfg.simulatePhone !== false), action: () => { const v = !(cfg && cfg.simulatePhone !== false); if (cfg) cfg.simulatePhone = v; window.api.setPrefs({ simulatePhone: v }); showToast(v ? 'Simulated phone ON — start a backup to test it' : 'Simulated phone OFF', 3500); } },
    { label: 'About USB / SD Auto-Action', action: showAbout }
  ]
};

function togglePref(key) {
  uiPrefs[key] = !uiPrefs[key];
  applyUiPrefs();
  if (key === 'autoplayAudio') refreshPreview();   // mute setting → update pop-out
  window.api.setUiPref(key, uiPrefs[key]);
}

function openMenu(trigger) {
  const items = MENUS[trigger.dataset.menu] || [];
  const hasChecks = items.some((it) => it.type === 'check');
  const menu = document.createElement('div');
  menu.className = 'flyout menu-flyout';
  let activeSub = null;
  let subTimer = null;
  const closeSub = () => { if (activeSub) { activeSub.remove(); activeSub = null; } };
  const scheduleCloseSub = () => { clearTimeout(subTimer); subTimer = setTimeout(closeSub, 260); };
  const cancelCloseSub = () => clearTimeout(subTimer);

  function openSubmenu(anchorBtn, item) {
    cancelCloseSub();
    if (activeSub && activeSub.dataset.for === anchorBtn.dataset.key) return; // already open
    closeSub();
    const opts = typeof item.submenu === 'function' ? item.submenu() : item.submenu;
    const sub = document.createElement('div');
    sub.className = 'flyout dropdown-menu submenu';
    sub.dataset.for = anchorBtn.dataset.key || '';
    const subHasChecks = opts.some((o) => o.type === 'check');   // toggle list → show ✓ column
    for (const o of opts) {
      if (o.sep) { const s = document.createElement('div'); s.className = 'flyout-sep'; sub.appendChild(s); continue; }
      if (o.header) { const h = document.createElement('div'); h.className = 'flyout-header'; h.textContent = typeof o.header === 'function' ? o.header() : o.header; sub.appendChild(h); continue; }
      const si = document.createElement('button');
      // Check-type items show a ✓ column; radio-style items (speed/date) stay highlighted.
      si.className = 'flyout-item' + (o.type !== 'check' && o.checked ? ' selected' : '') + (o.desc ? ' has-desc' : '');
      const olabel = escapeHtml(typeof o.label === 'function' ? o.label() : o.label);
      let inner = '';
      if (subHasChecks) inner += `<span class="flyout-check">${o.type === 'check' && o.checked ? '✓' : ''}</span>`;
      // A `desc` gives the item a second muted line explaining what it does — used to
      // disambiguate similar AI actions (analyze vs improve vs auto-name).
      inner += o.desc
        ? `<span class="flyout-stack"><span class="flyout-label">${olabel}</span><span class="flyout-desc">${escapeHtml(o.desc)}</span></span>`
        : `<span class="flyout-label">${olabel}</span>`;
      si.innerHTML = inner;
      si.addEventListener('click', () => { closePopover(); o.action(); });
      sub.appendChild(si);
    }
    sub.addEventListener('mouseenter', cancelCloseSub);
    sub.addEventListener('mouseleave', scheduleCloseSub);
    sub.style.position = 'fixed';
    sub.style.visibility = 'hidden';
    // Append to <body>, NOT the menu: the menu's backdrop-filter makes it the
    // containing block for fixed children (breaking viewport coords) and nesting
    // backdrop-filter renders see-through. Body keeps it aligned + opaque.
    document.body.appendChild(sub);
    const mr = menu.getBoundingClientRect();
    const r = anchorBtn.getBoundingClientRect();
    const sr = sub.getBoundingClientRect();
    let left = mr.right - 3;               // hug the menu's right edge (slight overlap bridges hover)
    if (left + sr.width > window.innerWidth - 8) left = mr.left - sr.width + 3;
    let top = r.top - 5;
    if (top + sr.height > window.innerHeight - 8) top = window.innerHeight - sr.height - 8;
    sub.style.left = `${Math.max(8, left)}px`;
    sub.style.top = `${Math.max(8, top)}px`;
    sub.style.visibility = 'visible';
    activeSub = sub;
  }

  let keyN = 0;
  for (const it of items) {
    if (it.sep) {
      const s = document.createElement('div'); s.className = 'flyout-sep'; menu.appendChild(s); continue;
    }
    const b = document.createElement('button');
    b.dataset.key = `k${keyN += 1}`;
    b.className = 'flyout-item' + (it.disabled ? ' disabled' : '') + (it.submenu ? ' has-submenu' : '');
    let inner = '';
    if (hasChecks) {
      // checked may be a function OR a plain boolean — tolerate both (a boolean
      // here used to throw and silently kill the whole menu, e.g. Help).
      const on = it.type === 'check' && (typeof it.checked === 'function' ? it.checked() : it.checked);
      inner += `<span class="flyout-check">${on ? '✓' : ''}</span>`;
    }
    const label = typeof it.label === 'function' ? it.label() : it.label;
    inner += `<span class="flyout-label">${escapeHtml(label)}</span>`;
    if (it.submenu) inner += '<span class="flyout-caret">›</span>';
    if (it.note) inner += `<span class="flyout-note">${escapeHtml(it.note)}</span>`;
    b.innerHTML = inner;
    if (it.submenu) {
      b.addEventListener('mouseenter', () => openSubmenu(b, it));
      b.addEventListener('mouseleave', scheduleCloseSub);
      b.addEventListener('click', () => openSubmenu(b, it));
    } else {
      b.addEventListener('mouseenter', scheduleCloseSub); // hovering elsewhere closes the sub (delayed)
      if (!it.disabled) b.addEventListener('click', () => { closePopover(); it.action(); });
    }
    menu.appendChild(b);
  }
  showPopover(trigger, menu);
  trigger.classList.add('active');
}

document.querySelectorAll('.menu-trigger').forEach((trigger) => {
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasActive = trigger.classList.contains('active');
    closePopover();
    if (!wasActive) openMenu(trigger);
  });
  // Hover-switch between menus while one is open (classic menu-bar behavior).
  trigger.addEventListener('mouseenter', () => {
    if (openPopover && !trigger.classList.contains('active')) openMenu(trigger);
  });
});

// ---------------------------------------------------------------------------
// Reusable right-click CONTEXT MENU (on-theme, same flyout look as the menu bar).
// items: [{ label, action, sep, submenu, type:'check', checked, disabled, danger }]
// label/checked may be functions. Submenus are one level (flat items).
// ---------------------------------------------------------------------------
function showContextMenu(x, y, items) {
  closePopover();
  items = (items || []).filter(Boolean);
  if (!items.length) return;
  const menu = document.createElement('div');
  menu.className = 'flyout menu-flyout context-flyout';
  const hasChecks = items.some((it) => it.type === 'check');
  let activeSub = null; let subTimer = null;
  const closeSub = () => { if (activeSub) { activeSub.remove(); activeSub = null; } };
  const scheduleCloseSub = () => { clearTimeout(subTimer); subTimer = setTimeout(closeSub, 260); };
  const cancelCloseSub = () => clearTimeout(subTimer);
  const val = (v) => (typeof v === 'function' ? v() : v);
  function openSub(anchorBtn, item) {
    cancelCloseSub();
    if (activeSub && activeSub.dataset.for === anchorBtn.dataset.key) return;
    closeSub();
    const opts = (val(item.submenu) || []).filter(Boolean);
    const sub = document.createElement('div');
    sub.className = 'flyout dropdown-menu submenu';
    sub.dataset.for = anchorBtn.dataset.key || '';
    const subHasChecks = opts.some((o) => o.type === 'check');
    for (const o of opts) {
      if (o.sep) { const s = document.createElement('div'); s.className = 'flyout-sep'; sub.appendChild(s); continue; }
      const oc = val(o.checked);
      const si = document.createElement('button');
      si.className = 'flyout-item' + (o.type !== 'check' && oc ? ' selected' : '') + (o.danger ? ' danger' : '') + (o.disabled ? ' disabled' : '');
      let inner = '';
      if (subHasChecks) inner += `<span class="flyout-check">${o.type === 'check' && oc ? '✓' : ''}</span>`;
      inner += `<span class="flyout-label">${escapeHtml(val(o.label))}</span>`;
      si.innerHTML = inner;
      if (!o.disabled) si.addEventListener('click', () => { closePopover(); if (o.action) o.action(); });
      sub.appendChild(si);
    }
    sub.addEventListener('mouseenter', cancelCloseSub);
    sub.addEventListener('mouseleave', scheduleCloseSub);
    sub.style.position = 'fixed'; sub.style.visibility = 'hidden';
    document.body.appendChild(sub);
    const mr = menu.getBoundingClientRect(); const r = anchorBtn.getBoundingClientRect(); const sr = sub.getBoundingClientRect();
    let left = mr.right - 3; if (left + sr.width > window.innerWidth - 8) left = mr.left - sr.width + 3;
    let top = r.top - 5; if (top + sr.height > window.innerHeight - 8) top = window.innerHeight - sr.height - 8;
    sub.style.left = `${Math.max(8, left)}px`; sub.style.top = `${Math.max(8, top)}px`; sub.style.visibility = 'visible';
    activeSub = sub;
  }
  let keyN = 0;
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'flyout-sep'; menu.appendChild(s); continue; }
    if (it.header) { const h = document.createElement('div'); h.className = 'flyout-header'; h.textContent = val(it.header); menu.appendChild(h); continue; }
    const b = document.createElement('button');
    b.dataset.key = `c${keyN += 1}`;
    const ic = val(it.checked);
    b.className = 'flyout-item' + (it.disabled ? ' disabled' : '') + (it.submenu ? ' has-submenu' : '') + (it.danger ? ' danger' : '') + (it.type !== 'check' && ic ? ' selected' : '');
    let inner = '';
    if (hasChecks) inner += `<span class="flyout-check">${it.type === 'check' && ic ? '✓' : ''}</span>`;
    inner += `<span class="flyout-label">${escapeHtml(val(it.label))}</span>`;
    if (it.submenu) inner += '<span class="flyout-caret">›</span>';
    b.innerHTML = inner;
    if (it.submenu) {
      b.addEventListener('mouseenter', () => openSub(b, it));
      b.addEventListener('mouseleave', scheduleCloseSub);
      b.addEventListener('click', () => openSub(b, it));
    } else {
      b.addEventListener('mouseenter', scheduleCloseSub);
      if (!it.disabled) b.addEventListener('click', () => { closePopover(); if (it.action) it.action(); });
    }
    menu.appendChild(b);
  }
  const anchor = { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y, width: 0, height: 0 }), contains: () => false };
  showPopover(anchor, menu);
}

// Menu shown when right-clicking a clip card (rename grid).
function clipContextItems(i) {
  const c = state.scannedFiles[i];
  if (!c) return null;
  const aiOn = aiCfg.enabled;
  const srcDir = (c.sourcePath || '').replace(/[\\/][^\\/]+$/, '');
  return [
    { label: 'Play / preview', action: () => playClip(i) },
    { label: 'AI', disabled: !aiOn, submenu: () => [
      { label: 'Run AI on this clip', action: () => runAiOnClip(i) },
      { label: 'Analyze selected clips', action: aiAnalyzeSelected },
      { label: 'Improve descriptions (use all data)', action: aiImproveSelected },
      { sep: true },
      { label: 'AI settings…', action: showAiSettings },
      { label: 'People & faces…', action: showPeopleManager }
    ] },
    { label: 'People', submenu: () => {
      const ppl = (c.people || []).filter(Boolean);
      const items = ppl.map((n) => ({ label: `Remove "${n}"`, danger: true, action: () => removePersonFromClip(i, n) }));
      if (ppl.length) items.push({ sep: true });
      items.push({ label: 'Add person…', action: () => showAddPersonPicker(i) });
      return items;
    } },
    { label: 'Tags & metadata…', action: () => showClipMetadata(i) },
    { sep: true },
    { label: 'Apply this name to selected', action: () => applyRowNameToSelected(i) },
    { label: 'Name selected as a batch… (Ctrl+B)', action: () => showBatchDialog() },
    { label: 'Tag location on selected… (Ctrl+L)', action: () => showLocationTagPopup() },
    { label: 'Set date…', action: () => { const btn = document.querySelector(`.rename-card[data-i="${i}"] [data-date]`); if (btn) btn.click(); } },
    { sep: true },
    { label: c.selected ? 'Deselect this clip' : 'Select this clip', action: () => setClipSelected(i, !c.selected) },
    { label: 'Open source folder', disabled: !srcDir, action: () => window.api.openFolder(srcDir) },
    { sep: true },
    { label: 'Report feedback about this…', action: () => showFeedbackReportDialog(lastFeedbackSection) }
  ];
}

// Default app menu (right-click empty space) — the menu bar, available anywhere.
function defaultContextItems() {
  return [
    { label: 'Command palette… (Ctrl+K)', action: showCommandPalette },
    { sep: true },
    { label: 'Home', action: goHome },
    { label: 'Name & copy clips', action: goToRename },
    { label: 'Organize & back up…', action: openFinalize },
    { sep: true },
    { label: 'Select', submenu: () => [
      { label: 'Select all clips', action: () => selectAllClips(true) },
      { label: 'Deselect all', action: () => selectAllClips(false) },
      { label: 'Invert selection', action: invertClipSelection }
    ] },
    { sep: true },
    { label: 'AI', submenu: () => [
      { label: 'AI settings…', action: showAiSettings },
      { label: 'Analyze selected clips', action: aiAnalyzeSelected },
      { label: 'People & faces…', action: showPeopleManager }
    ] },
    { label: 'Filing & destinations', submenu: () => [
      { label: 'Visualize destinations…', action: showDestinationMapAuto },
      { label: 'Filing rules…', action: () => showRoutingRules() },
      { label: 'Save point now', action: () => saveVersionPoint('Manual save point', false) },
      { label: 'Version history…', action: showVersionHistory }
    ] },
    { label: 'Display options', submenu: () => MENUS.view[0].submenu() },
    { sep: true },
    { label: 'Choose drive…', action: () => $('manualPickBtn').click() },
    { label: 'Open Projects folder', action: async () => { try { const r = await window.api.getProjectsRoot(); if (r) window.api.openFolder(r); } catch { /* ignore */ } } },
    { sep: true },
    { label: 'Report feedback about this…', action: () => showFeedbackReportDialog(lastFeedbackSection) }
  ];
}

// Global right-click router. Text fields fall through to the native menu (real
// cut/copy/paste + spellcheck). Modals with their own menus (people, map) stop
// propagation before this runs. Everything else gets a rich on-theme menu.
document.addEventListener('contextmenu', (e) => {
  const t = e.target;
  if (!t || !t.closest) return;
  if (t.closest('input, textarea, [contenteditable="true"], .ai-textarea')) return;   // native edit menu
  let items = null;
  const card = t.closest('.rename-card');
  if (card) items = clipContextItems(Number(card.dataset.i));
  else if (!t.closest('.modal-overlay')) items = defaultContextItems();
  if (items && items.length) { e.preventDefault(); showContextMenu(e.clientX, e.clientY, items); }
});

// Bulk selection helpers (used by the palette + default context menu).
function selectAllClips(on) { (state.scannedFiles || []).forEach((c, i) => setClipSelected(i, on)); }
function invertClipSelection() { (state.scannedFiles || []).forEach((c, i) => setClipSelected(i, !c.selected)); }

// ---------------------------------------------------------------------------
// Command palette (Ctrl+K) — fuzzy-search every command AND jump to any clip by
// name. One launcher for the whole app; reuses the existing action functions.
// ---------------------------------------------------------------------------
function jumpToClip(i) {
  const go = () => {
    const card = document.querySelector(`.rename-card[data-i="${i}"]`);
    if (card) { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); card.classList.add('just-placed'); setTimeout(() => card.classList.remove('just-placed'), 900); const subj = card.querySelector('[data-subject]'); if (subj) setTimeout(() => subj.focus(), 320); }
  };
  if ($('step1') && $('step1').classList.contains('hidden')) { goToRename(); setTimeout(go, 120); } else go();
}
function getCommands() {
  const onRename = $('step1') && !$('step1').classList.contains('hidden');
  const selN = (state.scannedFiles || []).filter((c) => c.selected).length;
  const cmds = [
    { label: 'Go to: Home', hint: 'nav', run: goHome },
    { label: 'Go to: Name & copy clips', hint: 'nav', run: goToRename },
    { label: 'Go to: Organize & back up', hint: 'nav', run: openFinalize },
    { label: 'Drive: Choose drive…', hint: 'drive', run: () => $('manualPickBtn').click() },
    { label: 'Open: Projects folder', hint: 'open', run: async () => { try { const r = await window.api.getProjectsRoot(); if (r) window.api.openFolder(r); } catch { /* ignore */ } } },
    { label: 'Open: Intake folder', hint: 'open', run: () => window.api.openFolder(state.intakeFolder) },
    { label: 'AI: Settings…', hint: 'ai', run: showAiSettings },
    { label: 'AI: Auto-enhance in background', hint: 'ai', run: aiAutoEnhance },
    { label: 'AI: Analyze selected clips', hint: 'ai', run: aiAnalyzeSelected },
    { label: 'AI: Improve descriptions (use all data)', hint: 'ai', run: aiImproveSelected },
    { label: 'AI: Learn rules from this analysis', hint: 'ai', run: learnFromAnalysisNow },
    { label: 'AI: People & faces…', hint: 'ai', run: showPeopleManager },
    { label: 'AI: Model store…', hint: 'ai', run: () => showModelStore() },
    { label: 'Filing: Visualize destinations…', hint: 'filing', run: showDestinationMapAuto },
    { label: 'Filing: Filing rules…', hint: 'filing', run: () => showRoutingRules() },
    { label: 'Versions: Save point now', hint: 'versions', run: () => saveVersionPoint('Manual save point', false) },
    { label: 'Versions: History…', hint: 'versions', run: showVersionHistory },
    { label: 'Settings…', hint: 'settings', run: showSettingsHub },
    { label: 'Keyboard shortcuts…', hint: 'settings', run: showKeyboardShortcuts },
    { label: 'Edit: Preferences…', hint: 'edit', run: showPreferences },
    { label: 'Edit: Organizing fields…', hint: 'edit', run: showOrganizeFields },
    { label: 'Edit: Subjects…', hint: 'edit', run: showEditSubjects },
    { label: 'Select: All clips', hint: 'select', run: () => selectAllClips(true) },
    { label: 'Select: None', hint: 'select', run: () => selectAllClips(false) },
    { label: 'Select: Invert', hint: 'select', run: invertClipSelection },
    { label: 'Feedback: Report…', hint: 'help', run: () => showFeedbackReportDialog(lastFeedbackSection) },
    { label: 'Feedback: Export…', hint: 'help', run: showFeedbackExportDialog },
    { label: 'Help: Setup wizard…', hint: 'help', run: () => showSetupWizard() },
    { label: 'Help: How this app works…', hint: 'help', run: () => showWorkflowGuide() },
    { label: 'Help: Take a tour', hint: 'help', run: () => startTour() },
    { label: 'Help: Diagnostics…', hint: 'help', run: showDiagnostics },
    { label: 'Help: About', hint: 'help', run: showAbout }
  ];
  for (const a of HOTKEY_ACTIONS) cmds.push({ label: `Action: ${a.label}`, hint: 'action', run: a.run });
  try { for (const o of (MENUS.view[0].submenu() || [])) { const lbl = typeof o.label === 'function' ? o.label() : o.label; cmds.push({ label: `Toggle: ${lbl}`, hint: 'view', run: o.action }); } } catch { /* ignore */ }
  void onRename; void selN;
  return cmds;
}
// subsequence fuzzy match → score (lower = better); null = no match.
function fuzzyScore(text, q) {
  text = text.toLowerCase();
  const idx = text.indexOf(q);
  if (idx >= 0) return idx;                 // substring: best, earlier = better
  let ti = 0; let qi = 0; let gaps = 0; let last = -1;
  while (ti < text.length && qi < q.length) {
    if (text[ti] === q[qi]) { if (last >= 0) gaps += ti - last - 1; last = ti; qi += 1; }
    ti += 1;
  }
  return qi === q.length ? 1000 + gaps : null;
}
let cmdPaletteOpen = false;
let lastCommandLabel = '';   // last command run from the palette → shown at the top next time
function showCommandPalette() {
  if (cmdPaletteOpen) return;
  closePopover();
  cmdPaletteOpen = true;
  const ov = document.createElement('div'); ov.className = 'modal-overlay cmdp-overlay';
  ov.innerHTML = `<div class="cmdp-card">
    <div class="cmdp-search"><span class="cmdp-ic">⌕</span><input type="text" class="cmdp-input" placeholder="Type a command or clip name…" spellcheck="false" /><span class="cmdp-kbd">Esc</span></div>
    <div class="cmdp-list"></div>
  </div>`;
  document.body.appendChild(ov);
  const input = ov.querySelector('.cmdp-input');
  const listEl = ov.querySelector('.cmdp-list');
  let commands = getCommands();
  // Surface the last command you ran at the very top (only on the empty query).
  if (lastCommandLabel) {
    const li = commands.findIndex((c) => (typeof c.label === 'function' ? c.label() : c.label) === lastCommandLabel);
    if (li > 0) { const [last] = commands.splice(li, 1); last.hint = 'recent'; commands = [last, ...commands]; }
  }
  const clips = (state.scannedFiles || []).map((c, i) => ({ label: `${c.subject ? `${c.subject} — ` : ''}${c.name}`, hint: 'clip', run: () => jumpToClip(i) }));
  const all = [...commands, ...clips];
  let filtered = all.slice(0, 60); let active = 0;
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey, true); cmdPaletteOpen = false; };
  function render() {
    listEl.innerHTML = filtered.length ? filtered.map((c, i) => `<button type="button" class="cmdp-item${i === active ? ' active' : ''}" data-i="${i}"><span class="cmdp-label">${escapeHtml(typeof c.label === 'function' ? c.label() : c.label)}</span>${c.hint ? `<span class="cmdp-hint">${escapeHtml(c.hint)}</span>` : ''}</button>`).join('') : '<div class="cmdp-empty muted small">No matches</div>';
    listEl.querySelectorAll('.cmdp-item').forEach((b) => {
      b.addEventListener('click', () => run(Number(b.dataset.i)));
      b.addEventListener('mousemove', () => { const n = Number(b.dataset.i); if (n !== active) { active = n; highlight(); } });
    });
  }
  function highlight() { listEl.querySelectorAll('.cmdp-item').forEach((b, i) => b.classList.toggle('active', i === active)); const a = listEl.querySelector('.cmdp-item.active'); if (a) a.scrollIntoView({ block: 'nearest' }); }
  function run(i) { const c = filtered[i]; if (!c) return; if (c.hint !== 'clip') lastCommandLabel = typeof c.label === 'function' ? c.label() : c.label; close(); setTimeout(() => { try { c.run(); } catch (err) { showToast(`Couldn't run: ${err.message || err}`); } }, 0); }
  function doFilter() {
    const q = input.value.trim().toLowerCase();
    if (!q) { filtered = all.slice(0, 60); active = 0; render(); return; }
    filtered = all.map((c) => ({ c, s: fuzzyScore(typeof c.label === 'function' ? c.label() : c.label, q) }))
      .filter((x) => x.s !== null).sort((a, b) => a.s - b.s).slice(0, 60).map((x) => x.c);
    active = 0; render();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, filtered.length - 1); highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(active); }
  }
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  input.addEventListener('input', doFilter);
  document.addEventListener('keydown', onKey, true);
  render();
  setTimeout(() => input.focus(), 30);
}
// Ctrl/Cmd+K (and Ctrl+Shift+P) opens the palette from anywhere.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K' || ((e.key === 'p' || e.key === 'P') && e.shiftKey))) {
    e.preventDefault(); showCommandPalette();
  }
}, true);

// ---------------------------------------------------------------------------
// DaVinci-Resolve-style keyboard shortcuts editor — a visual keyboard + a command
// list where you click a binding to rebind it (press the new keys).
// ---------------------------------------------------------------------------
const KB_ROWS = [
  ['Esc', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'],
  ['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', 'Backspace'],
  ['Tab', 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '[', ']', '\\'],
  ['Caps', 'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', "'", 'Enter'],
  ['Shift', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/', 'RShift'],
  ['Ctrl', 'Alt', 'Space', 'RAlt', 'RCtrl']
];
const KB_WIDE = { Backspace: 'w2', Tab: 'w15', '\\': 'w15', Caps: 'w18', Enter: 'w2', Shift: 'w22', RShift: 'w22', Space: 'w8', Ctrl: 'w15', RCtrl: 'w15', Alt: 'w12', RAlt: 'w12' };
// fixed (non-rebindable) shortcuts shown for reference
const KB_FIXED = [
  { combo: 'Ctrl+K', label: 'Command palette' },
  { combo: 'Enter', label: 'Next field / clip' }
];
function kbBaseKey(combo) { const p = String(combo || '').split('+'); return (p[p.length - 1] || '').toUpperCase(); }
function showKeyboardShortcuts() {
  const pending = { ...hotkeys };
  let capturingId = null;
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card ksc-card">
    <div class="pd-hd"><span class="pd-hd-icon keep-emoji">⌨️</span><div class="pd-hd-tx"><h3>Keyboard shortcuts</h3><p class="muted small pd-hd-sub">Click a shortcut to rebind it, then press the new keys (Esc cancels). Bound keys glow on the keyboard.</p></div>
      <button type="button" class="btn subtle ksc-reset">Reset to defaults</button></div>
    <div class="kb-board"></div>
    <div class="kb-hint muted small"></div>
    <div class="ksc-list"></div>
    <div class="modal-actions"><button type="button" class="btn primary ksc-save">Save</button><button type="button" class="btn ksc-close">Close</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => { document.removeEventListener('keydown', onCapture, true); document.removeEventListener('keydown', onMods, true); document.removeEventListener('keyup', onMods, true); ov.remove(); };
  ov.querySelector('.ksc-close').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov && !capturingId) close(); });
  ov.querySelector('.ksc-save').addEventListener('click', async () => { hotkeys = { ...hotkeys, ...pending }; try { await window.api.setPrefs({ hotkeys, textMacros }); } catch { /* */ } showToast('Shortcuts saved ✓'); close(); });
  ov.querySelector('.ksc-reset').addEventListener('click', () => { Object.assign(pending, DEFAULT_HOTKEYS); render(); });
  const board = ov.querySelector('.kb-board');
  const hint = ov.querySelector('.kb-hint');
  const list = ov.querySelector('.ksc-list');
  let heldMods = '';   // e.g. 'Ctrl', 'Ctrl+Shift' — the modifier LAYER being previewed
  // Split a combo into its modifier set + base key, normalized & sorted.
  function parseBinding(combo) {
    const parts = String(combo || '').split('+');
    const base = (parts.pop() || '').toUpperCase();
    const mods = parts.map((p) => p).filter((p) => ['Ctrl', 'Alt', 'Shift'].includes(p)).sort().join('+');
    return { base, mods };
  }
  function allBindings() {
    const out = [];
    for (const a of HOTKEY_ACTIONS) { if (pending[a.id]) { const b = parseBinding(pending[a.id]); out.push({ ...b, label: a.label }); } }
    for (const f of KB_FIXED) { const b = parseBinding(f.combo); out.push({ ...b, label: f.label }); }
    return out;
  }
  function renderBoard() {
    const all = allBindings();
    const layer = heldMods;   // '' = show every binding; else only this modifier layer (DaVinci-style)
    board.innerHTML = KB_ROWS.map((row) => `<div class="kb-row">${row.map((k) => {
      const disp = k.replace(/^R(Shift|Ctrl|Alt)$/, '$1');
      const key = k.toUpperCase().replace(/^R/, '');
      const matches = all.filter((b) => b.base === key && (layer ? b.mods === layer : true));
      const cls = `kb-key${KB_WIDE[k] ? ` ${KB_WIDE[k]}` : ''}${matches.length ? ' bound' : ''}`;
      const tip = matches.length ? ` title="${escapeAttr(matches.map((b) => `${(b.mods ? `${b.mods}+` : '')}${b.base} — ${b.label}`).join('\n'))}"` : '';
      // When a modifier layer is held, show the command NAME on the key (DaVinci); otherwise a dot.
      const inner = matches.length ? (layer ? `<span class="kb-act">${escapeHtml(matches[0].label)}</span>` : '<span class="kb-dot"></span>') : '';
      return `<div class="${cls}"${tip}><span class="kb-cap">${escapeHtml(disp)}</span>${inner}</div>`;
    }).join('')}</div>`).join('');
    if (hint) hint.textContent = layer ? `Showing the ${layer} layer — keys with a command are lit.` : 'Hold Ctrl / Shift / Alt to preview that layer (like DaVinci).';
  }
  // Track held modifiers (when NOT capturing) to preview each modifier layer.
  function onMods(e) {
    if (capturingId) return;
    const p = []; if (e.ctrlKey || e.metaKey) p.push('Ctrl'); if (e.altKey) p.push('Alt'); if (e.shiftKey) p.push('Shift');
    const m = p.sort().join('+');
    if (m !== heldMods) { heldMods = m; renderBoard(); }
  }
  document.addEventListener('keydown', onMods, true);
  document.addEventListener('keyup', onMods, true);
  function chip(combo) { return combo ? combo.split('+').map((p) => `<kbd class="ksc-kbd">${escapeHtml(p)}</kbd>`).join('<span class="ksc-plus">+</span>') : '<span class="muted small">—</span>'; }
  function renderList() {
    const rows = HOTKEY_ACTIONS.map((a) => `<div class="ksc-row" data-id="${a.id}">
        <div class="ksc-row-tx"><span class="ksc-row-label">${escapeHtml(a.label)}</span><span class="ksc-row-desc muted small">${escapeHtml(a.desc || '')}</span></div>
        <button type="button" class="ksc-bind${capturingId === a.id ? ' capturing' : ''}" data-bind="${a.id}">${capturingId === a.id ? 'Press keys…' : chip(pending[a.id])}</button>
        ${pending[a.id] ? `<button type="button" class="ksc-clear" data-clear="${a.id}" title="Unbind">✕</button>` : '<span class="ksc-clear-sp"></span>'}
      </div>`).join('');
    const fixedRows = KB_FIXED.map((f) => `<div class="ksc-row ksc-fixed"><div class="ksc-row-tx"><span class="ksc-row-label">${escapeHtml(f.label)}</span><span class="ksc-row-desc muted small">Built-in</span></div><span class="ksc-bind-fixed">${chip(f.combo)}</span><span class="ksc-clear-sp"></span></div>`).join('');
    list.innerHTML = `<div class="ksc-sec">Editable</div>${rows}<div class="ksc-sec">Built-in</div>${fixedRows}`;
    list.querySelectorAll('[data-bind]').forEach((b) => b.addEventListener('click', () => { capturingId = capturingId === b.dataset.bind ? null : b.dataset.bind; render(); }));
    list.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => { delete pending[b.dataset.clear]; render(); }));
  }
  function onCapture(e) {
    if (!capturingId) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); capturingId = null; render(); return; }
    const combo = eventToHotkey(e);
    if (!combo) return;   // modifier-only, keep waiting
    e.preventDefault(); e.stopPropagation();
    // clear any other action holding this combo (no duplicates)
    for (const id of Object.keys(pending)) { if (id !== capturingId && pending[id] === combo) delete pending[id]; }
    pending[capturingId] = combo;
    capturingId = null;
    render();
  }
  function render() { renderBoard(); renderList(); }
  document.addEventListener('keydown', onCapture, true);
  render();
}

// ---------------------------------------------------------------------------
// Settings hub — one place that links every settings surface.
// ---------------------------------------------------------------------------
function showSettingsHub() {
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  const cards = [
    { ic: '⚙️', title: 'Preferences', sub: 'Drive, intake folder, copy behaviour, text shortcuts', go: showPreferences },
    { ic: '✨', title: 'AI', sub: 'Models, analysis, instructions, memory, faces', go: showAiSettings },
    { ic: '⌨️', title: 'Keyboard shortcuts', sub: 'Rebind keys, DaVinci-style', go: showKeyboardShortcuts },
    { ic: '🗂️', title: 'Organizing fields', sub: 'The metadata fields used to file footage', go: showOrganizeFields },
    { ic: '📂', title: 'Filing rules', sub: 'Where footage goes by subject / descriptor', go: () => showRoutingRules() },
    { ic: '🫥', title: 'People & faces', sub: 'Manage recognized people', go: showPeopleManager },
    { ic: '🧭', title: 'Setup wizard', sub: 'Re-run guided onboarding (folders, AI, faces)', go: () => showSetupWizard() }
  ];
  ov.innerHTML = `<div class="modal-card settings-hub">
    <div class="pd-hd"><span class="pd-hd-icon keep-emoji">⚙️</span><div class="pd-hd-tx"><h3>Settings</h3><p class="muted small pd-hd-sub">Everything you can tune, in one place.</p></div></div>
    <div class="sh-grid">${cards.map((c, i) => `<button type="button" class="sh-card keep-emoji" data-i="${i}"><span class="sh-ic">${c.ic}</span><span class="sh-tx"><span class="sh-title">${escapeHtml(c.title)}</span><span class="sh-sub muted small">${escapeHtml(c.sub)}</span></span></button>`).join('')}</div>
    <div class="modal-actions"><button type="button" class="btn sh-close">Close</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('.sh-close').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelectorAll('.sh-card').forEach((b) => b.addEventListener('click', () => { close(); cards[Number(b.dataset.i)].go(); }));
}

// ---------------------------------------------------------------------------
// First-run setup wizard (issue #1) — guided onboarding that points the core
// folders (intake, Projects root, optional NAS) and gets the optional local AI +
// face recognition ready, so a brand-new user never has to discover Edit →
// Settings cold. Auto-shows ONCE on a genuine first launch (main reports
// cfg.firstRun); re-runnable anytime from Help → "Setup wizard…", the Settings
// hub, and the command palette. Nothing is persisted until Finish — except model
// downloads, which are global to Ollama anyway.
// ---------------------------------------------------------------------------
function showSetupWizard(opts = {}) {
  const firstRun = !!opts.firstRun;
  const wz = {
    intake: (cfg && cfg.intakeFolder) || state.intakeFolder || '',
    projects: (cfg && cfg.projectsRoot) || '',
    nas: { enabled: !!(nasBackup && nasBackup.enabled), path: (nasBackup && nasBackup.path) || '' },
    ai: { enabled: !!(aiCfg && aiCfg.enabled), endpoint: (aiCfg && aiCfg.endpoint) || 'http://localhost:11434', model: (aiCfg && aiCfg.model) || '', touched: false },
    face: null   // {ok,error} once checked
  };
  const STEPS = ['welcome', 'intake', 'projects', 'nas', 'ai', 'faces', 'done'];
  let step = 0;

  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  const card = document.createElement('div'); card.className = 'modal-card setup-wizard';
  ov.appendChild(card); document.body.appendChild(ov);

  function close() { document.removeEventListener('keydown', onKey, true); ov.remove(); }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); if (firstRun) skip(); else close(); } }
  document.addEventListener('keydown', onKey, true);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov && !firstRun) close(); });

  function markOnboarded() {
    try { uiPrefs.onboarded = true; window.api.setUiPref('onboarded', true); } catch { /* ignore */ }
    try { localStorage.setItem('tourSeen', '1'); } catch { /* ignore */ }
  }
  function skip() {
    markOnboarded(); close();
    if (firstRun) showToast('You can finish setup anytime: Help → “Setup wizard…”.', 4200);
  }
  async function finish() {
    const wantTour = !!(card.querySelector('#wizTour') && card.querySelector('#wizTour').checked);
    const btn = card.querySelector('.wiz-finish'); if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      if (wz.intake) { await window.api.setIntake(wz.intake); state.intakeFolder = wz.intake; if (cfg) cfg.intakeFolder = wz.intake; const el = $('intakePathLine'); if (el) el.textContent = wz.intake; }
      if (wz.projects) { await window.api.setProjectsRoot(wz.projects); if (cfg) cfg.projectsRoot = wz.projects; }
      // Merge the FULL current aiCfg so a re-run never wipes other AI settings
      // (frames, prompt, memories, faces…) — prefs:set rebuilds ai from the patch.
      nasBackup = { enabled: !!wz.nas.enabled, path: wz.nas.path || '' };
      aiCfg = { ...aiCfg, enabled: !!wz.ai.enabled, endpoint: wz.ai.endpoint, model: wz.ai.model };
      await window.api.setPrefs({ nasBackup, ai: aiCfg });
      if (cfg) { cfg.nasBackup = { ...nasBackup }; cfg.ai = { ...(cfg.ai || {}), enabled: aiCfg.enabled, endpoint: aiCfg.endpoint, model: aiCfg.model }; }
      applyAiPref();
      markOnboarded();
    } catch { showToast('Could not save some settings — adjust them in Settings.', 4200); }
    close();
    showToast('Setup complete ✓', 2400);
    if (wantTour) setTimeout(() => startTour(), 350);
  }

  function bodyFor(k) {
    if (k === 'welcome') {
      return `<p class="wiz-lead">This quick setup points the app at your folders and gets the optional local AI + face recognition ready. It takes about a minute — you can change anything later in <b>Settings</b>.</p>
        <ul class="wiz-list keep-emoji">
          <li>📥 <b>Intake folder</b> — where renamed clips are copied</li>
          <li>🗂️ <b>Projects root</b> — where footage gets filed</li>
          <li>💾 <b>NAS backup</b> — an optional second copy</li>
          <li>✨ <b>Local AI</b> &amp; 🫥 <b>face recognition</b> — optional, 100% offline</li>
        </ul>`;
    }
    if (k === 'intake') {
      return `<label class="pref-label">Intake folder</label>
        <p class="muted small wiz-hint">Renamed clips are verified-copied here before the card is cleared. A sensible default under your Videos folder is already set.</p>
        <div class="pref-row"><input class="pref-path" id="wizIntake" readonly value="${escapeHtml(wz.intake)}"><button type="button" class="btn wiz-pick" data-tgt="intake">Change…</button></div>`;
    }
    if (k === 'projects') {
      return `<label class="pref-label">Projects root</label>
        <p class="muted small wiz-hint">The tree your footage gets organised into on the <b>Organize &amp; back up</b> screen.</p>
        <div class="pref-row"><input class="pref-path" id="wizProjects" readonly value="${escapeHtml(wz.projects)}"><button type="button" class="btn wiz-pick" data-tgt="projects">Change…</button></div>`;
    }
    if (k === 'nas') {
      return `<label class="wiz-check"><input type="checkbox" id="wizNasOn" ${wz.nas.enabled ? 'checked' : ''}> Keep a second copy on a NAS or external drive</label>
        <p class="muted small wiz-hint">During copy, each clip is mirrored (with verify) to this location too. Optional.</p>
        <div class="pref-row${wz.nas.enabled ? '' : ' wiz-hide'}" id="wizNasRow"><input class="pref-path" id="wizNas" readonly value="${escapeHtml(wz.nas.path)}" placeholder="Choose a backup folder…"><button type="button" class="btn wiz-pick" data-tgt="nas">Change…</button></div>`;
    }
    if (k === 'ai') {
      return `<div class="ai-status" id="wizAiStatus">Checking for Ollama…</div>
        <div id="wizAiPick" class="wiz-hide">
          <label class="pref-label" style="margin-top:12px">Vision model</label>
          <select id="wizAiModel" class="wiz-select"></select>
          <label class="wiz-check" style="margin-top:11px"><input type="checkbox" id="wizAiOn"> Enable AI naming &amp; descriptions</label>
        </div>
        <div class="wiz-foot-row"><button type="button" class="btn" id="wizAiBrowse">Browse &amp; download models…</button><button type="button" class="btn subtle" id="wizAiRecheck">Re-check</button></div>
        <p class="muted small wiz-hint">100% offline — frames are sent only to your local Ollama, never the cloud. Skip this if you don’t want AI; you can enable it later.</p>`;
    }
    if (k === 'faces') {
      return `<div class="ai-status" id="wizFaceStatus">Checking face recognition…</div>
        <p class="muted small wiz-hint">Face recognition is bundled and runs fully offline — we just verify the engine and models load. Recognised faces are always <b>suggestions you confirm</b>, never auto-applied.</p>
        <button type="button" class="btn subtle" id="wizFaceRetry">Re-check</button>`;
    }
    // done
    return `<p class="wiz-lead">You’re all set 🎉 Here’s what we configured:</p>
      <ul class="wiz-summary keep-emoji">
        <li>📥 Intake — <code>${escapeHtml(wz.intake || '(default)')}</code></li>
        <li>🗂️ Projects — <code>${escapeHtml(wz.projects || '(default)')}</code></li>
        <li>💾 NAS backup — ${wz.nas.enabled ? `<code>${escapeHtml(wz.nas.path || '(set a path in Settings)')}</code>` : 'off'}</li>
        <li>✨ AI — ${wz.ai.enabled ? `on · <code>${escapeHtml(wz.ai.model || '(no model)')}</code>` : 'off'}</li>
        <li>🫥 Faces — ${wz.face ? (wz.face.ok ? 'ready ✓' : 'needs attention') : 'not checked'}</li>
      </ul>
      <label class="wiz-check" style="margin-top:14px"><input type="checkbox" id="wizTour" checked> Show me a quick tour of the app</label>`;
  }

  function footerFor(k) {
    const isLast = k === 'done';
    const back = step > 0 ? `<button type="button" class="btn wiz-back">Back</button>` : '';
    const lead = (firstRun && !isLast) ? `<button type="button" class="btn subtle wiz-skip">Skip setup</button>`
      : (!firstRun ? `<button type="button" class="btn subtle wiz-skip">Cancel</button>` : '');
    const nextLabel = k === 'welcome' ? 'Get started' : (isLast ? 'Finish' : 'Next');
    const nextCls = isLast ? 'btn primary wiz-finish' : 'btn primary wiz-next';
    return `${lead ? `<span class="wiz-lead-slot">${lead}</span>` : ''}${back}<button type="button" class="${nextCls}">${nextLabel}</button>`;
  }

  const HEADERS = {
    welcome: ['👋', 'Welcome to USB / SD Auto-Action', 'Let’s get you set up.'],
    intake: ['📥', 'Intake folder', 'Where renamed clips land.'],
    projects: ['🗂️', 'Projects root', 'Where footage gets filed.'],
    nas: ['💾', 'NAS backup', 'An optional second copy.'],
    ai: ['✨', 'Local AI (optional)', 'Offline naming via Ollama.'],
    faces: ['🫥', 'Face recognition', 'Bundled, offline, opt-in.'],
    done: ['✅', 'All set', 'Review and finish.']
  };

  async function refreshAiStep() {
    const statusEl = card.querySelector('#wizAiStatus'); if (!statusEl) return;
    const pick = card.querySelector('#wizAiPick');
    statusEl.textContent = 'Checking for Ollama…'; statusEl.className = 'ai-status';
    let s = null; try { s = await window.api.getAiStatus(); } catch { s = null; }
    if (!card.querySelector('#wizAiStatus')) return;   // step changed while awaiting
    if (!s || !s.running) {
      statusEl.innerHTML = '⚠ Ollama isn’t running. Install it from <code>ollama.com</code> (it runs in the background), then click <b>Re-check</b>. AI is optional — you can skip and set it up later.';
      statusEl.classList.add('warn'); if (pick) pick.classList.add('wiz-hide'); return;
    }
    const vis = (s.vision && s.vision.length) ? s.vision : [];
    if (!vis.length) {
      statusEl.innerHTML = '✓ Ollama is running, but no <b>vision</b> model is installed yet. Click “Browse &amp; download models” and grab one (e.g. <code>qwen2.5vl</code>), then Re-check.';
      statusEl.classList.add('ok'); if (pick) pick.classList.add('wiz-hide'); return;
    }
    statusEl.innerHTML = `✓ Ollama running · ${vis.length} vision model${vis.length !== 1 ? 's' : ''} ready`;
    statusEl.classList.add('ok');
    if (pick) pick.classList.remove('wiz-hide');
    const sel = card.querySelector('#wizAiModel');
    if (sel) {
      sel.innerHTML = vis.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
      if (!wz.ai.model || !vis.includes(wz.ai.model)) wz.ai.model = vis[0];
      sel.value = wz.ai.model;
      sel.onchange = () => { wz.ai.model = sel.value; };
    }
    const on = card.querySelector('#wizAiOn');
    if (on) {
      // A vision model is available → default to enabled, unless the user already
      // made a choice on this step (so toggling, leaving, returning is sticky).
      if (!wz.ai.touched) wz.ai.enabled = true;
      on.checked = wz.ai.enabled;
      on.onchange = () => { wz.ai.enabled = on.checked; wz.ai.touched = true; };
    }
  }
  async function refreshFaceStep() {
    const el = card.querySelector('#wizFaceStatus'); if (!el) return;
    el.textContent = 'Checking face recognition…'; el.className = 'ai-status';
    let r = null; try { r = await ensureFaceModels(); } catch (e) { r = { ok: false, error: (e && e.message) || 'unknown' }; }
    wz.face = r;
    const cur = card.querySelector('#wizFaceStatus'); if (!cur) return;
    if (r && r.ok) { cur.innerHTML = '✓ Face recognition is ready — the engine and bundled models loaded.'; cur.classList.add('ok'); }
    else { cur.innerHTML = `⚠ Face recognition couldn’t start: ${escapeHtml((r && r.error) || 'unknown')} You can still use everything else; try again later.`; cur.classList.add('warn'); }
  }

  function wire() {
    const k = STEPS[step];
    const back = card.querySelector('.wiz-back'); if (back) back.onclick = () => { step = Math.max(0, step - 1); render(); };
    const next = card.querySelector('.wiz-next'); if (next) next.onclick = () => { step = Math.min(STEPS.length - 1, step + 1); render(); };
    const fin = card.querySelector('.wiz-finish'); if (fin) fin.onclick = finish;
    const sk = card.querySelector('.wiz-skip'); if (sk) sk.onclick = () => { if (firstRun) skip(); else close(); };
    if (k === 'intake' || k === 'projects' || k === 'nas') {
      card.querySelectorAll('.wiz-pick').forEach((b) => { b.onclick = async () => {
        const tgt = b.dataset.tgt;
        const cur = tgt === 'intake' ? wz.intake : tgt === 'projects' ? wz.projects : wz.nas.path;
        const titles = { intake: 'Choose your intake folder', projects: 'Choose your Projects root', nas: 'Choose a NAS / backup folder' };
        const picked = await window.api.pickFolder({ title: titles[tgt], defaultPath: cur || undefined });
        if (!picked) return;
        if (tgt === 'intake') { wz.intake = picked; const el = card.querySelector('#wizIntake'); if (el) el.value = picked; }
        else if (tgt === 'projects') { wz.projects = picked; const el = card.querySelector('#wizProjects'); if (el) el.value = picked; }
        else { wz.nas.path = picked; const el = card.querySelector('#wizNas'); if (el) el.value = picked; }
      }; });
      const nasOn = card.querySelector('#wizNasOn');
      if (nasOn) nasOn.onchange = () => { wz.nas.enabled = nasOn.checked; const row = card.querySelector('#wizNasRow'); if (row) row.classList.toggle('wiz-hide', !nasOn.checked); };
    }
    if (k === 'ai') {
      const browse = card.querySelector('#wizAiBrowse'); if (browse) browse.onclick = () => { try { showModelStore(); } catch { /* ignore */ } };
      const recheck = card.querySelector('#wizAiRecheck'); if (recheck) recheck.onclick = () => refreshAiStep();
      refreshAiStep();
    }
    if (k === 'faces') {
      const retry = card.querySelector('#wizFaceRetry'); if (retry) retry.onclick = () => refreshFaceStep();
      refreshFaceStep();
    }
  }

  function render() {
    const k = STEPS[step];
    const [icon, title, sub] = HEADERS[k];
    card.innerHTML = `<div class="pd-hd"><span class="pd-hd-icon keep-emoji">${icon}</span><div class="pd-hd-tx"><h3>${escapeHtml(title)}</h3><p class="muted small pd-hd-sub">${escapeHtml(sub)}</p></div></div>
      <div class="wiz-dots">${STEPS.map((_s, i) => `<span class="wiz-dot${i === step ? ' on' : ''}${i < step ? ' done' : ''}"></span>`).join('')}</div>
      <div class="wiz-body">${bodyFor(k)}</div>
      <div class="modal-actions wiz-foot">${footerFor(k)}</div>`;
    wire();
  }
  render();
}

// On a genuine first launch (no saved config), walk the user through setup.
// Otherwise fall back to the existing one-time spotlight tour. The wizard's final
// step offers the tour, so the two never stack.
function maybeFirstRunSetup() {
  try {
    const onboarded = !!(uiPrefs && uiPrefs.onboarded);
    if (cfg && cfg.firstRun && !onboarded) { setTimeout(() => showSetupWizard({ firstRun: true }), 700); return; }
  } catch { /* ignore */ }
  maybeAutoTour();
}

// ---------------------------------------------------------------------------
// Guided tour — a spotlight walkthrough that highlights real UI, dims the rest,
// and explains each piece. Steps whose target isn't visible are skipped, so it
// works on any screen. Esc / arrows / buttons navigate.
// ---------------------------------------------------------------------------
// A full interactive walkthrough. Steps can NAVIGATE (`before`), require clips
// (`needsClips`), or skip if their target isn't there (`optional`).
const TOUR_STEPS = [
  { center: true, illo: ILLO_CONNECT, title: 'Welcome 👋', body: 'A quick tour of the footage-to-filed workflow. Use Next / Back, or press Esc to leave anytime.' },
  { sel: '#menubar', title: 'Menus & shortcuts', body: 'File · Edit · View · Help. Right-click almost anything for a context menu, and press Ctrl+K anywhere for the command palette.', side: 'bottom' },
  { sel: '#driveBanner', title: 'Your card', body: 'Insert an SD/USB card and it appears here. “Choose drive…” (top-right) picks one manually.', side: 'bottom', optional: true },
  { sel: '#actionList', title: 'Start here', body: 'Compress + rename + delete a card — or jump straight to organizing footage you already copied.', side: 'right', optional: true },
  { before: () => { if ((state.scannedFiles || []).length) goToRename(); }, needsClips: true, sel: '#clipFilterBar', title: 'Find clips fast', body: 'Filter the batch by name, subject or person — handy when a card has dozens of clips.', side: 'bottom', optional: true },
  { needsClips: true, sel: '#batchBar', title: 'Name in batches', body: 'Tick clips from the same shoot, set ONE date / subject / description here, and Apply to all of them at once (Ctrl+B opens a richer batch dialog).', side: 'bottom' },
  { needsClips: true, sel: '.rename-card[data-i="0"] .f-subject', title: 'Subject — what it is', body: '1-3 words for the main thing: “lawn-mowing”, “calisthenics”. lowercase, hyphens. Reused subjects autocomplete.', side: 'top' },
  { needsClips: true, sel: '.rename-card[data-i="0"] .f-desc', title: 'Description — what’s happening', body: 'A few keywords for the action + setting: “mowing-front-lawn”. This is where the AI shines.', side: 'top' },
  { needsClips: true, sel: '.rename-card[data-i="0"] .f-location', title: 'Location (optional)', body: 'A remembered place/client — autocompletes, and gets written into the metadata. Hidden by default (View → Location field) and settable on many clips at once with Ctrl+L.', side: 'top', optional: true },
  { needsClips: true, sel: '.rename-card[data-i="0"] .final-pill', title: 'The resulting filename', body: 'Live preview of date_subject_description_v#. Versions auto-number when several clips share a name.', side: 'top', optional: true },
  { needsClips: true, sel: '.rename-card[data-i="0"] .clip-people', title: 'Who’s in it', body: 'Faces you scan + name show up here and get woven into the AI’s descriptions. Right-click a clip → People to add one.', side: 'top', optional: true },
  { center: true, illo: ILLO_AI, title: 'Let the AI name them', body: 'Tick clips → Edit → AI → Analyze. It watches the frames, uses who’s in each clip + the shot type, and names them automatically.' },
  { center: true, illo: ILLO_DOWNLOAD, title: 'Downloading a model', body: 'The AI runs offline via Ollama. In AI settings → “Browse models”, download a vision model (e.g. qwen2.5vl). If you Analyze with no model, the app explains why and opens the store for you.' },
  { center: true, illo: ILLO_FACES, title: 'Scan faces (optional but powerful)', body: 'Edit → AI → People & faces → Scan. Name each new face once; it auto-tags them everywhere after, and the AI uses the names in descriptions.' },
  { sel: '#aiHazard', title: 'Confirm questions', body: 'When the AI wants to confirm a new name or remember a rule, it flags it here — a quick review keeps it learning your style.', side: 'left', optional: true },
  { before: () => goHome(), sel: '#organizeBtn', title: 'Organize, embed & export', body: 'When names look good, this files clips into your Projects folder, embeds rich metadata, writes a Resolve CSV, and lets you pick the output location.', side: 'right', optional: true },
  { center: true, illo: ILLO_FILES, title: 'That’s the flow ✓', body: 'Insert → batch-name → scan faces → Analyze → Improve → Organize. Replay anytime: Help → “How this app works”, or Ctrl+K → tour.' }
];
let tourActive = false;
function startTour(steps) {
  if (tourActive) return;
  const hasClips = (state.scannedFiles || []).length > 0;
  const list = (steps || TOUR_STEPS).filter((s) => !(s.needsClips && !hasClips));
  if (!list.length) { showToast('Nothing to tour right now'); return; }
  tourActive = true;
  let i = 0;
  const overlay = document.createElement('div'); overlay.className = 'tour-overlay';
  const spot = document.createElement('div'); spot.className = 'tour-spot';
  const tip = document.createElement('div'); tip.className = 'tour-tip';
  overlay.appendChild(spot);
  document.body.appendChild(overlay); document.body.appendChild(tip);
  function cleanup() { tourActive = false; overlay.remove(); tip.remove(); window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); document.removeEventListener('keydown', onKey, true); try { localStorage.setItem('tourSeen', '1'); } catch { /* ignore */ } }
  function next() { if (i < list.length - 1) { i += 1; place(); } else cleanup(); }
  function prev() { if (i > 0) { i -= 1; place(); } }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); cleanup(); } else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); } else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); } }
  function reposition() {
    const s = list[i];
    const el = s.center ? null : document.querySelector(s.sel);
    const visible = el && el.offsetParent !== null;
    if (visible) {
      const r = el.getBoundingClientRect(); const pad = 8;
      spot.style.display = 'block';
      spot.style.left = `${r.left - pad}px`; spot.style.top = `${r.top - pad}px`;
      spot.style.width = `${r.width + pad * 2}px`; spot.style.height = `${r.height + pad * 2}px`;
    } else { spot.style.display = 'none'; }
    const tr = tip.getBoundingClientRect();
    let left; let top;
    if (visible) {
      const r = el.getBoundingClientRect(); const side = s.side || 'bottom';
      if (side === 'bottom') { top = r.bottom + 14; left = r.left; }
      else if (side === 'top') { top = r.top - tr.height - 14; left = r.left; }
      else if (side === 'right') { left = r.right + 14; top = r.top; }
      else { left = r.left - tr.width - 14; top = r.top; }
    } else { left = (window.innerWidth - tr.width) / 2; top = (window.innerHeight - tr.height) / 2; }
    left = Math.max(12, Math.min(left, window.innerWidth - tr.width - 12));
    top = Math.max(12, Math.min(top, window.innerHeight - tr.height - 12));
    tip.style.left = `${left}px`; tip.style.top = `${top}px`;
  }
  function place() {
    const s = list[i];
    if (typeof s.before === 'function') { try { s.before(); } catch { /* ignore */ } }
    tip.innerHTML = `<div class="tour-step">${i + 1} / ${list.length}</div>${s.illo ? `<div class="illo tour-illo">${s.illo}</div>` : ''}<h3>${escapeHtml(s.title)}</h3><p>${escapeHtml(s.body)}</p><div class="tour-actions"><button type="button" class="btn subtle tour-skip">Skip tour</button><span class="tour-nav"><button type="button" class="btn tour-prev"${i === 0 ? ' disabled' : ''}>Back</button><button type="button" class="btn primary tour-next">${i === list.length - 1 ? 'Done' : 'Next'}</button></span></div>`;
    tip.classList.toggle('tour-centered', !!s.center);
    tip.querySelector('.tour-skip').onclick = cleanup;
    const pv = tip.querySelector('.tour-prev'); if (pv && !pv.disabled) pv.onclick = prev;
    tip.querySelector('.tour-next').onclick = next;
    // After any navigation settles, scroll the target into view and place the spotlight.
    setTimeout(() => {
      const el = s.center ? null : document.querySelector(s.sel);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(reposition, el ? 180 : 0);
    }, s.before ? 320 : 0);
  }
  window.addEventListener('resize', reposition); window.addEventListener('scroll', reposition, true);
  document.addEventListener('keydown', onKey, true);
  place();
}
// Auto-show the tour once, on first ever launch (after the UI settles).
function maybeAutoTour() { try { if (!localStorage.getItem('tourSeen')) setTimeout(() => startTour(), 1200); } catch { /* ignore */ } }

// Workflow guide — a quick reference for the end-to-end flow, to come back to.
const WORKFLOW_STEPS = [
  { n: '1', t: 'Insert your card', d: 'The drive shows up at the top. Open it to load the footage.' },
  { n: '2', t: 'Batch-name the shoot', d: 'Tick clips from the same shoot, give them one subject + a quick "what you\'re doing" note (Ctrl+B), Apply.' },
  { n: '3', t: 'Scan faces', d: 'Edit → AI → People & faces → Scan. Name each new face once; it auto-tags them everywhere after.' },
  { n: '4', t: 'Analyze with AI', d: 'Tick clips → Edit → AI → Analyze. It watches the frames, uses who\'s in each clip + the shot type, and names them.' },
  { n: '5', t: 'Improve & confirm', d: 'AI → Improve sharpens descriptions using everything; the ⚠ panel surfaces anything to confirm.' },
  { n: '6', t: 'Organize & back up', d: 'Files clips into your Projects folder, embeds metadata, writes a Resolve CSV.' }
];
function showWorkflowGuide() {
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card wf-guide">
    <div class="wf-head"><span class="illo">${ILLO_FILES}</span><h3>How this app works</h3><p class="muted small">The footage-to-filed workflow, start to finish.</p></div>
    <div class="wf-steps">${WORKFLOW_STEPS.map((s) => `<div class="wf-step"><span class="wf-num">${s.n}</span><div class="wf-tx"><span class="wf-t">${escapeHtml(s.t)}</span><span class="wf-d muted small">${escapeHtml(s.d)}</span></div></div>`).join('')}</div>
    <div class="modal-actions"><button type="button" class="btn primary wf-tour">Take the interactive tour</button><button type="button" class="btn wf-close">Close</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('.wf-close').addEventListener('click', close);
  ov.querySelector('.wf-tour').addEventListener('click', () => { close(); startTour(); });
}

// Diagnostics panel — gathers what the app actually sees + a live restore check,
// shown in a copyable textarea so it can be pasted back for debugging.
// Session activity/error log — captures the failures that used to be swallowed
// silently (AI, faces, copy verify, NAS) so they're visible + reportable.
const sessionLog = [];
function logIssue(area, msg) {
  try {
    sessionLog.push({ ts: Date.now(), area: String(area || ''), msg: String(msg == null ? '' : msg).slice(0, 400) });
    if (sessionLog.length > 400) sessionLog.shift();
    const dot = document.getElementById('logDot'); if (dot) dot.classList.remove('hidden');
  } catch { /* never throw from logging */ }
}
function showActivityLog() {
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  const rows = sessionLog.slice().reverse().map((e) => {
    const t = new Date(e.ts); const hh = String(t.getHours()).padStart(2, '0'); const mm = String(t.getMinutes()).padStart(2, '0'); const ss = String(t.getSeconds()).padStart(2, '0');
    return `<div class="alog-row"><span class="alog-time">${hh}:${mm}:${ss}</span><span class="alog-area">${escapeHtml(e.area)}</span><span class="alog-msg">${escapeHtml(e.msg)}</span></div>`;
  }).join('');
  ov.innerHTML = `<div class="modal-card modal-form" style="width:min(640px,94vw);max-height:84vh;display:flex;flex-direction:column">
    <div class="ai-hd"><span class="ai-hd-icon">📋</span><div class="ai-hd-text"><h3>Activity log</h3><p class="muted small">Anything that didn't go to plan this session — AI, faces, copies, backups.</p></div></div>
    <div class="alog-list">${rows || '<div class="muted small" style="padding:24px;text-align:center">No issues this session ✓</div>'}</div>
    <div class="modal-actions"><button type="button" class="btn alog-copy">Copy</button><button type="button" class="btn primary alog-close">Close</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('.alog-close').addEventListener('click', close);
  ov.querySelector('.alog-copy').addEventListener('click', () => { try { window.api.clipboardWrite(sessionLog.map((e) => `${new Date(e.ts).toISOString()} [${e.area}] ${e.msg}`).join('\n')); showToast('Activity log copied'); } catch { /* ignore */ } });
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  const dot = document.getElementById('logDot'); if (dot) dot.classList.add('hidden');
}
async function showDiagnostics() {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card modal-form" style="max-width:680px;width:92%">
    <h3>Diagnostics</h3>
    <p class="muted small">Copy this and send it over.</p>
    <textarea class="diag-text" readonly style="width:100%;height:340px;font-family:Consolas,monospace;font-size:12px;white-space:pre;overflow:auto"></textarea>
    <div class="modal-actions">
      <button type="button" class="btn primary diag-copy">Copy to clipboard</button>
      <button type="button" class="btn diag-close">Close</button>
    </div></div>`;
  document.body.appendChild(ov);
  const ta = ov.querySelector('.diag-text');
  ta.value = 'Gathering…';
  const close = () => ov.remove();
  ov.querySelector('.diag-close').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });

  const report = {};
  try { report.main = await window.api.debugInfo(); } catch (e) { report.mainError = String(e); }
  // Renderer-side live view of the current flow + a fresh restore check.
  report.renderer = {
    drive: state.drive ? state.drive.mountpoint : null,
    scannedDrive: state.scannedDrive || null,
    scannedFiles: state.scannedFiles.length,
    subjectsCache: subjectsCache.length,
    descriptionsCache: descriptionsCache.length
  };
  try {
    const drafts = await window.api.getDrafts();
    const keys = state.scannedFiles.map(clipKey);
    const matched = keys.filter((k) => { const d = drafts[k]; return d && (d.subject || d.description || d.date); });
    report.restoreCheck = {
      draftsGetKeys: Object.keys(drafts || {}),
      scannedKey0: keys[0] || null,
      matchedCount: matched.length,
      sampleScannedKeys: keys.slice(0, 3)
    };
  } catch (e) { report.restoreCheckError = String(e); }
  report.activityLog = sessionLog.slice(-60).map((e) => `${new Date(e.ts).toISOString()} [${e.area}] ${e.msg}`);

  ta.value = JSON.stringify(report, null, 2);
  ta.focus(); ta.select();
  ov.querySelector('.diag-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(ta.value); }
    catch { ta.focus(); ta.select(); document.execCommand('copy'); }
    const b = ov.querySelector('.diag-copy'); b.textContent = 'Copied ✓';
    setTimeout(() => { b.textContent = 'Copy to clipboard'; }, 1500);
  });
}

function showAbout() {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card">
    <img src="assets/tray.png" class="modal-icon" alt="" />
    <h3>USB / SD Auto-Action</h3>
    <p class="muted small">Version 0.1.0 · Fluent</p>
    <p class="muted small">Auto-import, rename and clear your camera cards.</p>
    <button type="button" class="btn primary modal-ok">OK</button></div>`;
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) ov.remove(); });
  ov.querySelector('.modal-ok').addEventListener('click', () => ov.remove());
  document.body.appendChild(ov);
}

// (The standalone "Organizing & folders…" dialog was removed — its destination,
// folder-structure and NAS controls now live inline on the Organize & back up
// screen. The per-clip metadata row toggle stays in the View menu.)

// Reserved ids a custom field can't use (they'd collide with built-in clip keys).
const RESERVED_FIELD_IDS = new Set(['date', 'subject', 'description', 'version', 'ts', 'keywords', 'selected', 'name', 'size', 'ext', 'sourcepath', 'derived', 'matchtype', 'meta', 'posterurl', 'datelocked', 'origbase']);

// Manage the custom organizing fields (the taxonomy): add / rename / remove /
// reorder. These are the metadata columns shown while naming and the folders
// Finalize can file clips into (e.g. Category › Client › Project).
function showOrganizeFields() {
  let fields = organizeFields.map((f) => ({ id: f.id, label: f.label }));
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card modal-form" style="max-width:520px">
    <h3>Organizing fields</h3>
    <p class="muted small">The metadata you fill while naming, and the folders Finalize can file clips into. Order here is just the list; choose which become folders (and their order) on the Organize screen.</p>
    <div class="of-list"></div>
    <button type="button" class="btn of-add" style="margin-top:10px">＋ Add field</button>
    <div class="modal-actions">
      <button type="button" class="btn primary of-save">Save</button>
      <button type="button" class="btn of-cancel">Cancel</button>
    </div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('.of-cancel').addEventListener('click', close);
  const listEl = ov.querySelector('.of-list');
  function render() {
    listEl.innerHTML = '';
    if (!fields.length) {
      const p = document.createElement('p'); p.className = 'muted small'; p.textContent = 'No fields yet — add one.';
      listEl.appendChild(p);
    }
    fields.forEach((f, i) => {
      const row = document.createElement('div'); row.className = 'of-row';
      row.innerHTML = `
        <input type="text" class="of-label" value="${escapeAttr(f.label)}" placeholder="Field name (e.g. Client)" />
        <button type="button" class="org-up" ${i > 0 ? '' : 'disabled'} title="Move up">▲</button>
        <button type="button" class="org-down" ${i < fields.length - 1 ? '' : 'disabled'} title="Move down">▼</button>
        <button type="button" class="hk-reset of-del" title="Remove field">✕</button>`;
      row.querySelector('.of-label').addEventListener('input', (e) => { f.label = e.target.value; });
      row.querySelector('.org-up').addEventListener('click', () => { if (i > 0) { [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]]; render(); } });
      row.querySelector('.org-down').addEventListener('click', () => { if (i < fields.length - 1) { [fields[i + 1], fields[i]] = [fields[i], fields[i + 1]]; render(); } });
      row.querySelector('.of-del').addEventListener('click', () => { fields.splice(i, 1); render(); });
      listEl.appendChild(row);
    });
  }
  render();
  ov.querySelector('.of-add').addEventListener('click', () => { fields.push({ id: '', label: '' }); render(); });
  ov.querySelector('.of-save').addEventListener('click', async () => {
    const usedIds = new Set();
    const out = [];
    for (const f of fields) {
      const label = (f.label || '').trim();
      if (!label) continue;
      // Keep an existing field's id stable; derive a new id from its label.
      let id = f.id || slug(label);
      if (!id) continue;
      if (RESERVED_FIELD_IDS.has(id)) id = `${id}-field`;
      let base = id; let n = 2;
      while (usedIds.has(id)) { id = `${base}-${n}`; n += 1; }
      usedIds.add(id);
      out.push({ id, label });
    }
    if (!out.length) { showToast('Add at least one field'); return; }
    organizeFields = await window.api.setFields(out);
    await refreshFields();
    buildCommandBarFields();
    // Rebuild the rename rows so added/removed fields appear (values preserved).
    if (state.scannedFiles.length && !$('step1').classList.contains('hidden')) buildRenameStep();
    close();
  });
}

// Local AI (Ollama) settings — fully offline metadata suggestions.
// ---------------------------------------------------------------------------
// Destination map — a clickable mock file-explorer showing where every clip will
// be filed in your real Projects tree. Base placement comes from the filename/
// metadata; "Suggest with AI" reads the real tree + clip content to refine it;
// you can move clips and create folders, then Apply files them (editable mode).
// ---------------------------------------------------------------------------
// Record successfully-filed clips into the persistent project ledger, then (if AI
// is on) refresh the AI summary for each touched project in the background.
async function recordToLedger(clips, placement, results) {
  const okFrom = new Set((results || []).filter((x) => x && x.ok).map((x) => x.from));
  const entries = [];
  for (const c of clips || []) {
    const rel = placement[c.key];
    if (!rel) continue;
    if (okFrom.size && !okFrom.has(c.sourcePath)) continue;   // only clips that actually filed
    const ref = c._ref || {};
    const meta = ref.meta || ref;
    entries.push({
      rel, name: c.name, date: c.date || meta.date || '',
      subject: c.subject || meta.subject || '', description: c.description || meta.description || '',
      location: c.location || meta.location || '',
      people: Array.isArray(meta.people) ? meta.people : (Array.isArray(ref.people) ? ref.people : []),
      observation: (ref.observation || meta.observation || '')
    });
  }
  if (!entries.length) return;
  let touched = [];
  try { const r = await window.api.ledgerRecord({ entries }); touched = (r && r.projects) || []; } catch { return; }
  if (!touched.length || !aiReady()) return;
  // Summaries are a single text call each; run them serially in the background.
  (async () => {
    let n = 0;
    for (const rel of touched) {
      try { const s = await window.api.ledgerSummarize(rel); if (s && s.ok) n += 1; } catch { /* ignore */ }
    }
    if (n) showToast(`🗂️ Updated ${n} project ${n === 1 ? 'summary' : 'summaries'}`, 3500);
  })();
}

// Undo the last Organize — move the filed clips back out of the Projects tree.
async function undoLastOrganize() {
  let info; try { info = await window.api.organizeUndoInfo(); } catch { info = null; }
  if (!info || !info.ok) { showToast('Nothing to undo — no recent organize on record'); return; }
  const ok = await confirmDialog('Undo last organize?', `Move the ${info.count} filed clip${info.count !== 1 ? 's' : ''} back out of your Projects tree to where they came from?`, 'Undo', 'Cancel');
  if (!ok) return;
  showToast('Undoing…', 2000);
  let r; try { r = await window.api.organizeUndo(); } catch (e) { r = { ok: false, error: e.message }; }
  if (r && r.ok) showToast(`Moved ${r.undone} clip${r.undone !== 1 ? 's' : ''} back${r.failed ? ` · ${r.failed} couldn’t be moved (already gone/renamed)` : ''} ✓`, 5500);
  else showToast(r && r.error ? r.error : 'Undo failed', 5000);
}

// A quick feedback box for the destination map's iterative "Refine…" — the user
// says what's wrong in plain English and the AI re-plans. Enter (or Ctrl+Enter) runs.
function showRefinePrompt(cb) {
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card modal-form" style="width:min(520px,93vw)">
    <div class="ai-hd"><span class="ai-hd-icon keep-emoji">↻</span><div class="ai-hd-text"><h3>Refine the plan</h3><p class="muted small">Tell the AI what's wrong and it re-plans — repeat until it's right. e.g. “the josiah vlog clips aren't calisthenics — file them under Personal”, “keep each day as Day N, not dates”, “these belong with the lawn footage”.</p></div></div>
    <textarea class="ai-textarea rfp-text" rows="3" placeholder="What should change?"></textarea>
    <div class="modal-actions"><button type="button" class="btn primary rfp-go">Re-plan</button><button type="button" class="btn rfp-cancel">Cancel</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  const ta = ov.querySelector('.rfp-text');
  setTimeout(() => ta.focus(), 30);
  const go = () => { const v = ta.value.trim(); close(); if (v) cb(v); };
  ov.querySelector('.rfp-go').addEventListener('click', go);
  ov.querySelector('.rfp-cancel').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
  });
}

async function showDestinationMap(rawClips, opts = {}) {
  const editable = !!opts.editable;
  const onEditMeta = typeof opts.onEditMeta === 'function' ? opts.onEditMeta : null;
  const clips = (rawClips || []).filter((c) => c && c.sourcePath).map((c, i) => ({
    key: c.sourcePath || ('c' + i), name: c.name || '', sourcePath: c.sourcePath || '',
    subject: c.subject || '', description: c.description || '', location: c.location || '', date: c.date || '',
    // A project the user accepted from the same-shoot prompt at analyze time → file here.
    _ledgerRel: c._ledgerRel || (c._ref && c._ref._ledgerRel) || '',
    _ref: c._ref || null
  }));
  if (!clips.length) { showToast('No clips to map'); return; }
  const clipByKey = {}; for (const c of clips) clipByKey[c.key] = c;
  const placement = {};   // clip.key -> relative folder path ('/' separators)
  const autoKeys = new Set(clips.map((c) => c.key));   // keys still auto-placed (recomputed from rules + tree)
  const selected = new Set();   // multi-select for bulk move / drag
  const recentlyPlaced = new Set();   // keys to flash after an AI placement
  // WHY each clip landed where it did + how sure we are — powers the plan view's
  // confidence badges and the "Needs you" vs "Confident" split. {reason, conf 0-1, kind}.
  const placeMeta = {};
  const setMeta = (key, reason, conf, kind) => { placeMeta[key] = { reason, conf, kind }; };
  let ledgerCache = [];   // remembered projects (window.api.ledgerGet) for deterministic pre-match + quick chips
  let viewMode = 'plan';  // 'plan' (grouped destinations) | 'tree' (folder tree)
  let autoPlanned = false; // guard so the on-open AI pass runs at most once

  // Which top-level category a path belongs to (drives the colour coding + legend).
  const categoryKey = (rel) => { const s = String(rel || '').toLowerCase(); if (/client/.test(s)) return 'client'; if (/personal/.test(s)) return 'personal'; if (/social/.test(s)) return 'social'; return 'other'; };
  const isDateName = (name) => /^\d{4}-\d{2}-\d{2}$/.test(String(name || ''));

  // --- Placement engine: standing rules → category-constrained default → straggler
  // catch-all. Keeps EVERY clip under one of the real top-level categories.
  const matchHay = (c) => `${c.subject || ''} ${c.location || ''} ${c.description || ''}`.toLowerCase();
  const clipYear = (c) => { const m = /(\d{4})/.exec(c.date || ''); return m ? m[1] : String(new Date().getFullYear()); };
  // Match rules to a clip. A real PROJECT route wins over a DESCRIPTOR (vlog,
  // timelapse…) — the descriptor only decides grouping when there's no project.
  function rulesFor(c) {
    const h = matchHay(c); let route = null; let desc = null;
    for (const r of routesCache) {
      if (!(r.match || []).some((k) => k && h.includes(k))) continue;
      if (r.kind === 'descriptor') { if (!desc) desc = r; } else if (!route) route = r;
    }
    return { route, desc };
  }
  function routeFor(c) { const { route, desc } = rulesFor(c); return route || desc || null; }
  function treeCategories() { const cats = []; for (const fp of folderPaths) { const p = fp.split('/'); if (p.length === 2 && /^\d{4}$/.test(p[0]) && /^\d{4}\s*-\s*\S/.test(p[1])) cats.push(fp); } return cats; }
  function pickCategory(c) {
    const cats = treeCategories(); const y = clipYear(c);
    const want = (re) => cats.find((p) => p.startsWith(y + '/') && re.test(p)) || cats.find((p) => re.test(p));
    const h = matchHay(c);
    if (/(client|\bad\b|ugc|founder|manbelt|brand|sponsor|lawn|mow)/.test(h)) { const x = want(/client/i); if (x) return x; }
    if (/(calisthenic|calisthetic|gym|workout|fitness|vlog|social|reel|tiktok|short)/.test(h)) { const x = want(/social/i); if (x) return x; }
    return want(/personal/i) || `${y}/${y} - Personal`;
  }
  // Category for a descriptor clip — its rule may pin one (client/personal/social), else guess.
  function descCategory(desc, c) {
    const key = String((desc && desc.category) || '').toLowerCase();
    if (key) { const y = clipYear(c); const cats = treeCategories(); const re = new RegExp(key, 'i'); return cats.find((p) => p.startsWith(y + '/') && re.test(p)) || cats.find((p) => re.test(p)) || `${y}/${y} - ${key.charAt(0).toUpperCase()}${key.slice(1)}`; }
    return pickCategory(c);
  }
  // The most common NON-descriptor placement for a given date — i.e. "the project
  // shot that day", used so a timelapse files alongside its day's footage.
  function dominantByDate() {
    const byDate = {};
    for (const c of clips) {
      const { route, desc } = rulesFor(c);
      if (desc && !route) continue;   // skip descriptor-only clips
      const d = c.date || ''; const pl = placement[c.key]; if (!d || !pl) continue;
      (byDate[d] = byDate[d] || {}); byDate[d][pl] = (byDate[d][pl] || 0) + 1;
    }
    const dom = {};
    for (const d of Object.keys(byDate)) { let best = ''; let n = -1; for (const [pl, cnt] of Object.entries(byDate[d])) if (cnt > n) { n = cnt; best = pl; } dom[d] = best; }
    return dom;
  }
  // Strip a trailing date segment from a PROJECT path so day folders are created
  // under the real project (and inferSchema sees the existing "Day N" siblings),
  // never under a date wrapper — this is what prevents the .../2026-11-29/2024-12-03
  // double-nesting and keeps the existing day-folder convention.
  function projectBase(rel) { return String(rel || '').replace(/\/\d{4}-\d{2}-\d{2}$/, ''); }
  // For MULTI-day groups: drop a trailing single-day leaf (a date, or a "Day 6" /
  // "Shoot 03" / "Session_4" style token) so the per-day split happens under the real
  // project and inferSchema can read its existing siblings to continue the pattern.
  function stripDayLeaf(rel) { return String(rel || '').replace(/\/(?:\d{4}-\d{2}-\d{2}|[A-Za-z]{1,12}[ _-]?\d{1,3})$/, ''); }
  // The carried AI analysis (observation + recognized people) for a clip, from the
  // clip, its _ref, or the matched finalize meta — fed to the AI placement so it
  // groups by what the footage ACTUALLY is, not just the generic label.
  const dmapObs = (c) => { const r = (c && c._ref) || {}; const m = r.meta || {}; return String(r.observation || m.observation || c.observation || '').slice(0, 220); };
  const dmapPeople = (c) => { const r = (c && c._ref) || {}; const m = r.meta || {}; const p = (Array.isArray(r.people) && r.people.length ? r.people : (Array.isArray(m.people) ? m.people : (Array.isArray(c.people) ? c.people : []))); return p.filter(Boolean); };
  function deriveFolder(c) {   // single-clip auto placement (route → category default)
    if (c._ledgerRel) { const b = projectBase(c._ledgerRel); return b && c.date ? `${b}/${c.date}` : (b || c._ledgerRel); }
    const { route } = rulesFor(c);
    if (route) return route.byDay && c.date ? `${route.dest}/${c.date}` : route.dest;
    const subj = slug(c.subject || c.location || '');
    return subj ? `${pickCategory(c)}/${subj}` : `${pickCategory(c)}/_Unsorted`;
  }
  // Deterministic ledger match: score a clip against every remembered project by
  // shared people / subject / location tokens (people weighted highest, mirroring
  // main's ledger:matchDates + suggestLedgerMemory). Returns the best project when
  // it clears a confidence bar, so obvious repeats file themselves — no AI needed.
  const _tok = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2);
  function ledgerMatch(c) {
    if (!ledgerCache.length) return null;
    const subjT = new Set([...(_tok(c.subject)), ...(_tok(c.description))]);
    const locT = new Set(_tok(c.location));
    const pplT = new Set((dmapPeople(c) || []).map((p) => String(p).toLowerCase().trim()).filter(Boolean));
    let best = null;
    for (const m of ledgerCache) {
      if (!m || !m.rel) continue;
      let s = 0;
      (m.people || []).forEach((p) => { if (pplT.has(String(p).toLowerCase().trim())) s += 3; });
      (m.subjects || []).forEach((x) => { if (_tok(x).some((t) => subjT.has(t))) s += 2; });
      (m.keywords || []).forEach((k) => { if (_tok(k).some((t) => subjT.has(t) || locT.has(t))) s += 1.5; });
      (m.locations || []).forEach((l) => { if (_tok(l).some((t) => locT.has(t))) s += 2; });
      if (!best || s > best.s) best = { rel: m.rel, name: m.name || m.rel.split('/').pop(), s };
    }
    // Need a real signal: a person match, or two content matches. One stray token isn't enough.
    return best && best.s >= 3 ? best : null;
  }
  // Immediate child folder names that already exist under a relative path.
  function childrenOf(parentRel) {
    const pre = parentRel + '/'; const set = new Set();
    for (const fp of folderPaths) { if (fp.startsWith(pre)) { const seg = fp.slice(pre.length).split('/')[0]; if (seg) set.add(seg); } }
    return [...set];
  }
  // Learn the GENERIC naming scheme from existing sibling folders: a prefix + an
  // incrementing number + an optional separator/description. Handles "Day 1",
  // "01 - desc", "Shoot 03", "Job #2", etc. Falls back to the date when there's no
  // numbered sequence (pure dates or free-text names).
  function inferSchema(children) {
    const seq = [];
    for (const n0 of children) {
      const n = String(n0).trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(n)) continue;   // a date, not a sequence
      const m = /^(\D*?)(\d{1,3})(\D.*)?$/.exec(n);
      if (!m) continue;
      const rest = m[3] || ''; const sm = /^([\s\-_.:#]+)(\S.*)$/.exec(rest);
      seq.push({ prefix: m[1] || '', num: +m[2], padWidth: m[2].length, sep: sm ? sm[1] : '', hasDesc: !!sm });
    }
    if (!seq.length) return { kind: 'date' };
    const byPrefix = {};
    for (const s of seq) (byPrefix[s.prefix] = byPrefix[s.prefix] || []).push(s);
    const prefix = Object.keys(byPrefix).sort((a, b) => byPrefix[b].length - byPrefix[a].length)[0];
    const g = byPrefix[prefix];
    return {
      kind: 'seq', prefix,
      padWidth: Math.max(...g.map((s) => s.padWidth)),
      max: Math.max(...g.map((s) => s.num)),
      hasDesc: g.filter((s) => s.hasDesc).length >= g.length / 2,
      sep: (g.find((s) => s.hasDesc) || {}).sep || ' - '
    };
  }
  // For a by-day destination, name each day's folder by continuing the existing
  // scheme (inferSchema) — whatever it is — else fall back to the date.
  function dayFolderMap(byDayClips) {
    const datesByDest = {}; const sampleByKey = {};
    for (const { dest, c } of byDayClips) { if (!c.date) continue; (datesByDest[dest] = datesByDest[dest] || new Set()).add(c.date); const k = `${dest}__${c.date}`; if (!sampleByKey[k]) sampleByKey[k] = c; }
    const out = {};
    for (const dest of Object.keys(datesByDest)) {
      const schema = inferSchema(childrenOf(dest));
      [...datesByDest[dest]].sort().forEach((d, i) => {
        let name = d;
        if (schema.kind === 'seq') {
          const num = String(schema.max + i + 1).padStart(schema.padWidth, '0');
          if (schema.hasDesc) { const c = sampleByKey[`${dest}__${d}`]; const desc = slug((c && (c.description || c.location || c.subject)) || '') || d; name = `${schema.prefix}${num}${schema.sep}${desc}`; }
          else name = `${schema.prefix}${num}`;
        }
        out[`${dest}__${d}`] = name;
      });
    }
    return out;
  }
  // Place a wizard group's clips: if they span MULTIPLE days, split into per-day
  // folders under the chosen project (continuing its scheme + inner layout) so a
  // recurring subject like lawn-mowing doesn't collapse into one folder. Single-day
  // groups stay in the one folder. Returns [{key, dest}].
  function placeGroupClips(g) {
    const dates = [...new Set(g.clips.map((c) => c.date).filter(Boolean))];
    // Single day → respect the AI's chosen folder (just guard against a date wrapper).
    if (dates.length <= 1) { const dest = projectBase(g.dest); return g.clips.map((c) => ({ key: c.key, dest })); }
    // Multi-day → split per day under the real project, continuing its discovered scheme.
    const dest = stripDayLeaf(projectBase(g.dest));
    const dmap = dayFolderMap(g.clips.map((c) => ({ dest, c })));
    const inner = dayInner[dest] || '';
    return g.clips.map((c) => {
      const dn = c.date ? (dmap[`${dest}__${c.date}`] || c.date) : '';
      return { key: c.key, dest: dn ? `${dest}/${dn}${inner ? `/${inner}` : ''}` : dest };
    });
  }
  // Recompute folders for every clip STILL on auto. Routes → their folder; lone
  // subjects → "<category>/_Unsorted"; DESCRIPTORS (vlog = each day its own project,
  // timelapse = joins the day's project) resolved in a 2nd pass.
  function recomputeAuto() {
    const autoClips = clips.filter((c) => autoKeys.has(c.key));
    const info = new Map(); for (const c of autoClips) info.set(c.key, rulesFor(c));
    const groupCount = {};
    for (const c of autoClips) { const { route, desc } = info.get(c.key); if (!route && !desc) { const s = slug(c.subject || c.location || '') || ''; if (s) groupCount[s] = (groupCount[s] || 0) + 1; } }
    // Per-day folder names for by-day routes AND ledger-routed clips, following the
    // existing convention (Day N…). Ledger clips use their project base (date stripped).
    const byDayClips = [];
    for (const c of autoClips) {
      if (c._ledgerRel && c.date) { byDayClips.push({ dest: projectBase(c._ledgerRel), c }); continue; }
      const { route } = info.get(c.key); if (route && route.byDay && c.date) byDayClips.push({ dest: route.dest, c });
    }
    const dmap = dayFolderMap(byDayClips);
    // PASS 1 — routes + plain subjects (descriptors deferred). Each placement also
    // records WHY + a confidence, which drives the plan view's badges/sections.
    for (const c of autoClips) {
      // Same-shoot suggestion accepted at analyze time → file into a continued day
      // folder under the project (no date wrapper, no double-nesting).
      if (c._ledgerRel) {
        const base = projectBase(c._ledgerRel);
        if (c.date) { const dn = dmap[`${base}__${c.date}`] || c.date; const inner = dayInner[base] || ''; placement[c.key] = `${base}/${dn}${inner ? `/${inner}` : ''}`; }
        else placement[c.key] = base;
        setMeta(c.key, 'the shoot you confirmed', 0.95, 'ledger');
        continue;
      }
      const { route, desc } = info.get(c.key);
      if (route) {
        if (route.byDay && c.date) { const dayName = dmap[`${route.dest}__${c.date}`] || c.date; const inner = dayInner[route.dest] || ''; placement[c.key] = `${route.dest}/${dayName}${inner ? `/${inner}` : ''}`; }
        else placement[c.key] = route.dest;
        setMeta(c.key, `rule: ${route.name || (route.match || [])[0] || 'filing rule'}`, 0.9, 'rule');
        continue;
      }
      if (desc) continue;
      // No rule → try the deterministic ledger match (a project you've filed
      // matching footage into before). Strong matches file straight in.
      const lm = ledgerMatch(c);
      if (lm) {
        const base = projectBase(lm.rel);
        if (c.date) { const dn = (dayFolderMap([{ dest: base, c }])[`${base}__${c.date}`]) || c.date; const inner = dayInner[base] || ''; placement[c.key] = `${base}/${dn}${inner ? `/${inner}` : ''}`; }
        else placement[c.key] = base;
        setMeta(c.key, `matches your “${lm.name}”`, lm.s >= 5 ? 0.85 : 0.7, 'ledger');
        continue;
      }
      const subj = slug(c.subject || c.location || '');
      if (!subj || groupCount[subj] <= 1) { placement[c.key] = `${pickCategory(c)}/_Unsorted`; setMeta(c.key, subj ? 'only clip with this subject' : 'no subject yet', 0.12, 'unsorted'); }
      else { placement[c.key] = `${pickCategory(c)}/${subj}`; setMeta(c.key, `grouped by subject (${groupCount[subj]})`, 0.5, 'subject'); }
    }
    // PASS 2 — descriptor clips, now that the day's real projects are known.
    const descAuto = autoClips.filter((c) => { const { route, desc } = info.get(c.key); return !route && desc; });
    if (descAuto.length) {
      const dom = dominantByDate();
      for (const c of descAuto) {
        const { desc } = info.get(c.key);
        if (desc.joinProject && c.date && dom[c.date]) { placement[c.key] = dom[c.date]; setMeta(c.key, `${desc.name || 'descriptor'} → joins the day’s project`, 0.6, 'subject'); }     // join the project shot that day
        else { placement[c.key] = c.date ? `${descCategory(desc, c)}/${c.date}` : `${descCategory(desc, c)}/_Unsorted`; setMeta(c.key, `${desc.name || 'descriptor'} → own project per day`, c.date ? 0.55 : 0.15, c.date ? 'subject' : 'unsorted'); }   // each day its own project
      }
    }
  }

  const host = opts.host || null;   // when set, render INLINE into this element instead of a modal
  const intro = `Each clip grouped by where it'll be filed, with how sure the AI is. Fix the “Needs you” few, then file. Switch to Folders for the full tree.`;
  const cardInner = `
    ${host ? '' : `<div class="ai-hd"><span class="ai-hd-icon keep-emoji">🗂️</span><div class="ai-hd-text"><h3>Organize &amp; file</h3><p class="muted small">${intro}</p></div></div>`}
    ${host ? `<p class="muted small dmap-introline">${intro}</p>` : ''}
    <div class="dmap-bar">
      <span class="dmap-viewtoggle"><button type="button" class="dmap-vt on" data-view="plan">Plan</button><button type="button" class="dmap-vt" data-view="tree">Folders</button></span>
      <span class="dmap-root muted small" title="Projects folder"></span><button type="button" class="btn subtle dmap-root-btn">Change…</button>
      <span class="dmap-spacer"></span>
      <button type="button" class="btn primary dmap-ai" title="Let the local AI plan where every clip goes (it analyzes anything it hasn't seen first)">✨ Suggest with AI</button>
      <button type="button" class="btn subtle dmap-more" title="More tools">More ▾</button>
      <span class="dmap-moretools hidden">
        <button type="button" class="btn subtle dmap-refine" title="Tell the AI what to change and it re-plans">↻ Refine…</button>
        <button type="button" class="btn subtle dmap-sortme" title="Go clip-by-clip and tell it where each goes — it learns a rule">🎬 Sort with me</button>
        <button type="button" class="btn subtle dmap-rules" title="Manage standing filing rules">Filing rules…</button>
      </span>
      <span class="dmap-status muted small"></span>
    </div>
    <div class="dmap-legend hidden">
      <span class="dmap-leg dmap-cat-client"><span class="dmap-dot"></span>Client Work</span>
      <span class="dmap-leg dmap-cat-personal"><span class="dmap-dot"></span>Personal</span>
      <span class="dmap-leg dmap-cat-social"><span class="dmap-dot"></span>Social Media</span>
      <span class="dmap-leg dmap-leg-new"><span class="dmap-dot"></span>new folder</span>
    </div>
    <div class="dmap-ai-activity hidden"><span class="dmap-spinner"></span><span class="dmap-ai-msg"></span><span class="dmap-ai-prog"></span></div>
    <div class="dmap-selbar hidden"><span class="dmap-selcount"></span><button type="button" class="btn subtle dmap-sel-move">Move selected…</button><button type="button" class="btn subtle dmap-sel-edit">Edit subject…</button><button type="button" class="btn subtle dmap-sel-clear">Clear</button></div>
    <div class="dmap-tree"></div>
    <div class="modal-actions">
      ${editable ? '<button type="button" class="btn primary dmap-apply">Apply — file clips</button>' : ''}
      ${host ? '' : `<button type="button" class="btn dmap-close">${editable ? 'Cancel' : 'Close'}</button>`}
    </div>`;
  let ov = null; let card;
  if (host) {
    host.innerHTML = '';
    card = document.createElement('div'); card.className = 'modal-card dmap dmap-embed'; card.innerHTML = cardInner;
    host.appendChild(card);
  } else {
    ov = document.createElement('div'); ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal-card dmap">${cardInner}</div>`;
    document.body.appendChild(ov);
    card = ov.querySelector('.modal-card');
  }
  const q = (s) => card.querySelector(s);
  const close = () => { if (ov) ov.remove(); else if (host) host.innerHTML = ''; };
  const closeBtn = q('.dmap-close'); if (closeBtn) closeBtn.addEventListener('click', close);
  if (ov) ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  q('.dmap-sel-clear').addEventListener('click', () => { selected.clear(); renderTree(); });
  q('.dmap-sel-move').addEventListener('click', () => { if (!selected.size) return; const keys = [...selected]; pickFolder(placement[keys[0]], (rel) => moveKeys(keys, rel)); });
  q('.dmap-sel-edit').addEventListener('click', () => { if (!selected.size) return; editClipMeta([...selected].map((k) => clipByKey[k]).filter(Boolean)); });

  let root = ''; let folderPaths = []; let dragKeys = []; let dayInner = {};   // route.dest → common inner subfolder path inside its day folders
  const flatten = (nodes, base, acc) => { for (const n of nodes) { const rel = (base ? base + '/' : '') + n.name; acc.push(rel); flatten(n.children, rel, acc); } return acc; };
  async function loadTree() {
    root = await window.api.getProjectsRoot();
    q('.dmap-root').textContent = root || '(set a folder)';
    const r = await window.api.getProjectsTree(root);
    if (r && r.ok) { root = r.root; folderPaths = flatten(r.tree, '', []); q('.dmap-root').textContent = root; q('.dmap-status').textContent = `${folderPaths.length} folders`; }
    else { folderPaths = []; q('.dmap-status').textContent = r ? r.error : 'Could not read folder'; }
    // Discover the common subfolder layout inside each by-day route's folders, so
    // new day folders mirror it (e.g. .../Day 7/Footage) and clips land where the
    // others keep theirs. Done once per load before placement.
    dayInner = {};
    const byDayDests = [...new Set(routesCache.filter((r2) => r2.byDay && r2.kind !== 'descriptor' && r2.dest).map((r2) => r2.dest))].filter((d) => folderPaths.includes(d));
    for (const dest of byDayDests) {
      try { const il = await window.api.projectsInnerLayout(dest); if (il && il.ok && il.inner) dayInner[dest] = il.inner; } catch { /* ignore */ }
    }
    try { ledgerCache = (await window.api.ledgerGet()) || []; } catch { ledgerCache = []; }
    recomputeAuto();
    render();
    maybeAutoPlan();
  }
  const countClips = (node) => { let n = node.clips.length; for (const ch of node.children.values()) n += countClips(ch); return n; };
  function buildMerged() {
    const rootNode = { name: '', rel: '', children: new Map(), clips: [], exists: true };
    const ensure = (rel, exists) => {
      let node = rootNode; let cur = '';
      for (const p of String(rel).split('/').filter(Boolean)) {
        cur = cur ? cur + '/' + p : p;
        if (!node.children.has(p)) node.children.set(p, { name: p, rel: cur, children: new Map(), clips: [], exists: false });
        node = node.children.get(p); if (exists) node.exists = true;
      }
      return node;
    };
    for (const rel of folderPaths) ensure(rel, true);
    for (const c of clips) ensure(placement[c.key] || 'misc', false).clips.push(c);
    return rootNode;
  }
  // Dispatcher: every re-render goes through here so all existing callers honour the
  // current view. renderTree() is kept as the alias the rest of the code calls.
  function render() { if (viewMode === 'tree') renderTreeView(); else renderPlan(); }
  function renderTree() { render(); }
  function renderTreeView() {
    const el = q('.dmap-tree'); el.innerHTML = '';
    const merged = buildMerged();
    const renderNode = (node, container, depth) => {
      const kids = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const ch of kids) {
        const total = countClips(ch);
        const dated = isDateName(ch.name);
        const row = document.createElement('div'); row.className = `dmap-folder dmap-cat-${categoryKey(ch.rel)}${dated ? ' dmap-dated' : ''}`; row.dataset.rel = ch.rel;
        row.style.paddingLeft = `${depth * 16}px`;
        const renameBtn = ch.exists ? '' : '<button type="button" class="dmap-frename" title="Rename this new folder">✎</button>';
        const icon = dmapFolderIcon(dated, depth);
        // Only auto-expand branches that actually receive clips this run — existing
        // empty scaffolding folders start collapsed so the tree shows the work, not
        // all 65 folders at once. (Click the caret to expand any folder manually.)
        const startOpen = total > 0;
        row.innerHTML = `<span class="dmap-caret">${startOpen ? '▾' : '▸'}</span><span class="dmap-ficon keep-emoji">${icon}</span><span class="dmap-fname">${escapeHtml(ch.name)}</span>${ch.exists ? '' : '<span class="dmap-badge new">new</span>'}${renameBtn}${total ? `<span class="dmap-count">${total}</span>` : ''}`;
        const wrap = document.createElement('div'); wrap.className = 'dmap-children' + (startOpen ? ' open' : '');
        row.querySelector('.dmap-caret').addEventListener('click', () => { const open = wrap.classList.toggle('open'); row.querySelector('.dmap-caret').textContent = open ? '▾' : '▸'; });
        if (!ch.exists) row.querySelector('.dmap-frename').addEventListener('click', (e) => { e.stopPropagation(); renameNewFolder(ch.rel); });
        // Drop target: dropping the dragged clip(s) files them into this folder.
        row.addEventListener('dragover', (e) => { if (dragKeys.length) { e.preventDefault(); row.classList.add('drop'); } });
        row.addEventListener('dragleave', () => row.classList.remove('drop'));
        row.addEventListener('drop', (e) => { e.preventDefault(); row.classList.remove('drop'); if (dragKeys.length) moveKeys(dragKeys.slice(), ch.rel); });
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault(); e.stopPropagation();
          const items = [];
          if (selected.size) items.push({ label: `Move ${selected.size} selected clip${selected.size !== 1 ? 's' : ''} here`, action: () => moveKeys([...selected], ch.rel) });
          if (!ch.exists) items.push({ label: 'Rename folder…', action: () => renameNewFolder(ch.rel) });
          const open = wrap.classList.contains('open');
          items.push({ label: open ? 'Collapse' : 'Expand', action: () => { const o = wrap.classList.toggle('open'); row.querySelector('.dmap-caret').textContent = o ? '▾' : '▸'; } });
          showContextMenu(e.clientX, e.clientY, items);
        });
        container.appendChild(row); container.appendChild(wrap);
        renderNode(ch, wrap, depth + 1);
        for (const c of ch.clips) wrap.appendChild(clipRow(c, depth + 1));
      }
    };
    renderNode(merged, el, 0);
    if (!el.children.length) el.innerHTML = '<p class="muted small">No placements yet.</p>';
    updateSelBar();
  }

  // ---- PLAN VIEW: clips grouped by their destination PROJECT, each as one card
  // with a confidence badge + the reason it landed there. Low-confidence / unsorted
  // groups float to a "Needs you" section so you fix the few that matter, fast. ----
  const confClass = (c) => (c >= 0.75 ? 'hi' : c >= 0.45 ? 'mid' : 'lo');
  function planGroups() {
    const groups = new Map();
    for (const c of clips) {
      const full = placement[c.key] || `${pickCategory(c)}/_Unsorted`;
      const gkey = /\/_Unsorted$/i.test(full) ? full : (stripDayLeaf(projectBase(full)) || full);
      if (!groups.has(gkey)) groups.set(gkey, { gkey, keys: [] });
      groups.get(gkey).keys.push(c.key);
    }
    const arr = [...groups.values()].map((g) => {
      const metas = g.keys.map((k) => placeMeta[k] || { conf: 0.3, reason: '', kind: 'subject' });
      const conf = Math.min(...metas.map((m) => (m.conf == null ? 0.3 : m.conf)));
      const counts = {}; metas.forEach((m) => { const r = m.reason || ''; counts[r] = (counts[r] || 0) + 1; });
      const reason = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || '';
      const unsorted = /\/_Unsorted$/i.test(g.gkey);
      const kind = metas.find((m) => m.kind === 'ledger') ? 'ledger' : metas.find((m) => m.kind === 'rule') ? 'rule' : metas.find((m) => m.kind === 'manual') ? 'manual' : ((metas[0] && metas[0].kind) || 'subject');
      return { ...g, conf, reason, unsorted, needs: unsorted || conf < 0.45, kind, count: g.keys.length, exists: folderPaths.includes(g.gkey), cat: categoryKey(g.gkey) };
    });
    arr.sort((a, b) => (a.needs !== b.needs) ? (a.needs ? -1 : 1) : (a.needs ? a.conf - b.conf : a.gkey.localeCompare(b.gkey, undefined, { numeric: true })));
    return arr;
  }
  // Candidate destinations offered as one-tap chips on a "Needs you" group: the
  // best ledger matches for the group's clips, then the top-level categories.
  function planChips(g) {
    const rep = clipByKey[g.keys[0]]; const out = []; const seen = new Set();
    const lm = ledgerMatch(rep); if (lm) { const b = projectBase(lm.rel); out.push({ dest: b, label: lm.name }); seen.add(b); }
    for (const cat of treeCategories()) { if (seen.has(cat)) continue; seen.add(cat); out.push({ dest: cat, label: cat.split('/').pop() }); }
    return out.slice(0, 4);
  }
  async function learnRouteFromGroup(keys, dest) {
    const subjs = keys.map((k) => clipByKey[k]).filter(Boolean).map((c) => slug(c.subject || c.location || '')).filter(Boolean);
    const kw = [...new Set(subjs.flatMap((s) => s.split('-')).filter((w) => w.length > 2))].slice(0, 6);
    if (!kw.length) return false;
    const base = projectBase(dest);
    const existing = routesCache.find((r) => r.kind !== 'descriptor' && (r.match || []).some((m) => kw.includes(String(m).toLowerCase())));
    if (existing) existing.dest = base; else routesCache.push({ name: (clipByKey[keys[0]] && clipByKey[keys[0]].subject) || base.split('/').pop(), kind: 'route', match: kw, dest: base, byDay: false });
    try { routesCache = (await window.api.saveRoutes(routesCache)) || routesCache; } catch { /* non-fatal */ }
    return true;
  }
  async function planChange(g, dest, remember) {
    const clean = String(dest || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
    if (!clean) return;
    moveKeys(g.keys.slice(), clean);
    if (remember && await learnRouteFromGroup(g.keys, clean)) showToast('Got it — I’ll auto-file these next time ✓', 3800);
  }
  const expandedGroups = new Set();   // gkeys whose clip list is shown
  function renderPlan() {
    const el = q('.dmap-tree'); el.innerHTML = '';
    const groups = planGroups();
    if (!groups.length) { el.innerHTML = '<p class="muted small">No clips to file.</p>'; updateSelBar(); return; }
    const needs = groups.filter((g) => g.needs); const sure = groups.filter((g) => !g.needs);
    const total = clips.length; const sureN = sure.reduce((n, g) => n + g.count, 0);
    const section = (title, sub, list) => {
      if (!list.length) return;
      const h = document.createElement('div'); h.className = 'dmap-sec'; h.innerHTML = `<span class="dmap-sec-t">${escapeHtml(title)}</span><span class="muted small">${escapeHtml(sub)}</span>`;
      el.appendChild(h);
      for (const g of list) el.appendChild(groupCard(g));
    };
    section('Needs you', needs.length ? `${needs.reduce((n, g) => n + g.count, 0)} clip${needs.length ? 's' : ''} the AI is unsure about` : '', needs);
    section('Confident', sureN ? `${sureN} clip${sureN !== 1 ? 's' : ''} ready to file` : '', sure);
    updateSelBar();
    q('.dmap-status').textContent = `${total} clip${total !== 1 ? 's' : ''} · ${groups.length} folder${groups.length !== 1 ? 's' : ''}`;
  }
  function groupCard(g) {
    const card = document.createElement('div');
    card.className = `dplan-group dmap-cat-${g.cat}${g.needs ? ' needs' : ''}`;
    const name = g.gkey.split('/').pop(); const parent = g.gkey.split('/').slice(0, -1).join('/');
    const pct = Math.round(g.conf * 100);
    const flash = g.keys.some((k) => recentlyPlaced.has(k)) ? ' just-placed' : '';
    card.className += flash;
    card.innerHTML = `
      <div class="dplan-hd">
        <span class="dplan-caret">${expandedGroups.has(g.gkey) ? '▾' : '▸'}</span>
        <span class="dplan-ficon keep-emoji">${g.exists ? '📁' : '✨'}</span>
        <span class="dplan-name">${escapeHtml(name)}</span>
        ${g.exists ? '' : '<span class="dmap-badge new">new</span>'}
        <span class="dplan-count">${g.count}</span>
        <span class="dplan-conf conf-${confClass(g.conf)}" title="How confident the placement is">${pct}%</span>
      </div>
      <div class="dplan-meta">
        <span class="dplan-path muted small">${escapeHtml(parent || '(Projects root)')}</span>
        ${g.reason ? `<span class="dplan-why">${escapeHtml(g.reason)}</span>` : ''}
      </div>
      <div class="dplan-acts">
        ${g.needs ? planChips(g).map((ch) => `<button type="button" class="btn subtle dplan-chip" data-dest="${escapeHtml(ch.dest)}">${escapeHtml(ch.label)}</button>`).join('') : ''}
        <button type="button" class="btn subtle dplan-change">Change…</button>
        ${g.needs ? '<label class="dplan-remember" title="Save this as a filing rule so it happens automatically next time"><input type="checkbox" class="dplan-rem"> remember</label>' : ''}
      </div>
      <div class="dplan-clips${expandedGroups.has(g.gkey) ? ' open' : ''}"></div>`;
    const remEl = () => card.querySelector('.dplan-rem');
    const hd = card.querySelector('.dplan-hd');
    hd.addEventListener('click', () => {
      if (expandedGroups.has(g.gkey)) expandedGroups.delete(g.gkey); else expandedGroups.add(g.gkey);
      renderPlan();
    });
    card.querySelector('.dplan-change').addEventListener('click', () => pickFolder(g.gkey, (rel) => planChange(g, rel, !!(remEl() && remEl().checked))));
    card.querySelectorAll('.dplan-chip').forEach((b) => b.addEventListener('click', () => planChange(g, b.dataset.dest, !!(remEl() && remEl().checked))));
    if (expandedGroups.has(g.gkey)) { const cw = card.querySelector('.dplan-clips'); for (const k of g.keys) { const c = clipByKey[k]; if (c) cw.appendChild(clipRow(c, 1)); } }
    return card;
  }
  // Auto-run a placement pass on open when there's real ambiguity and AI is ready —
  // so the screen shows a finished plan instead of a pile of _Unsorted. Runs once.
  async function maybeAutoPlan() {
    if (autoPlanned) return; autoPlanned = true;
    if (!editable || typeof aiReady !== 'function' || !aiReady()) return;
    const unrouted = clips.filter((c) => autoKeys.has(c.key) && ((placeMeta[c.key] || {}).conf == null || (placeMeta[c.key] || {}).conf < 0.45));
    if (unrouted.length < Math.max(2, Math.ceil(clips.length * 0.2))) return;
    await runAiPlan('', { pool: unrouted, silent: true });
  }

  // Compact metadata chips on a map leaf — same vocabulary as the Match screen so
  // the whole Organize flow reads as one app: subject/description, 👤 people, shot.
  function dmapClipChips(c) {
    const deh = (s) => String(s || '').replace(/[-_]+/g, ' ').trim();
    const out = [];
    const label = deh(c.description || c.subject || c.location || '');
    if (label) out.push(`<span class="dmap-chip">${escapeHtml(label)}</span>`);
    const ppl = (Array.isArray(c.people) ? c.people : []).filter(Boolean);
    if (ppl.length) out.push(`<span class="dmap-chip people"><span class="fin-chip-ic">👤</span>${escapeHtml(ppl.join(', '))}</span>`);
    if (c.shotType) out.push(`<span class="dmap-chip shot">${escapeHtml(deh(c.shotType))}</span>`);
    (Array.isArray(c.tags) ? c.tags : []).slice(0, 3).forEach((t) => out.push(`<span class="dmap-chip">🏷 ${escapeHtml(t)}</span>`));
    return out.length ? `<span class="dmap-cchips">${out.join('')}</span>` : '';
  }
  function clipRow(c, depth) {
    const row = document.createElement('div');
    row.className = `dmap-clip dmap-cat-${categoryKey(placement[c.key])}` + (selected.has(c.key) ? ' sel' : '') + (recentlyPlaced.has(c.key) ? ' just-placed' : '');
    row.style.paddingLeft = `${depth * 16 + 16}px`;
    row.draggable = true;
    row.innerHTML = `<span class="dmap-cic keep-emoji">🎬</span><span class="dmap-cname">${escapeHtml(c.name)}</span>${dmapClipChips(c)}<button type="button" class="btn subtle dmap-edit" title="Fix subject / location">✎</button><button type="button" class="btn subtle dmap-move">Move…</button>`;
    // Click the row (not its buttons) to toggle selection.
    row.addEventListener('click', (e) => { if (e.target.closest('button')) return; toggleSel(c.key); });
    row.querySelector('.dmap-edit').addEventListener('click', (e) => { e.stopPropagation(); editClipMeta([c]); });
    row.querySelector('.dmap-move').addEventListener('click', (e) => { e.stopPropagation(); const keys = selected.has(c.key) ? [...selected] : [c.key]; pickFolder(placement[c.key], (rel) => moveKeys(keys, rel)); });
    row.addEventListener('dragstart', (e) => { dragKeys = selected.has(c.key) ? [...selected] : [c.key]; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', c.key); } catch { /* ignore */ } });
    row.addEventListener('dragend', () => { dragKeys = []; });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const keys = selected.has(c.key) ? [...selected] : [c.key];
      const n = keys.length;
      showContextMenu(e.clientX, e.clientY, [
        { label: n > 1 ? `Move ${n} clips…` : 'Move to folder…', action: () => pickFolder(placement[c.key], (rel) => moveKeys(keys, rel)) },
        { label: 'Edit subject / location…', action: () => editClipMeta(selected.has(c.key) ? [...selected].map((k) => clipByKey[k]).filter(Boolean) : [c]) },
        { sep: true },
        { label: selected.has(c.key) ? 'Deselect' : 'Select', action: () => toggleSel(c.key) }
      ]);
    });
    return row;
  }
  // Apply a folder to a set of clips (explicit move — they leave their auto group).
  function moveKeys(keys, rel) {
    const clean = String(rel).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim() || 'misc';
    for (const k of keys) { placement[k] = clean; autoKeys.delete(k); setMeta(k, 'you placed it here', 1, 'manual'); }
    renderTree();
  }
  function toggleSel(key) { if (selected.has(key)) selected.delete(key); else selected.add(key); renderTree(); }
  function updateSelBar() {
    const bar = q('.dmap-selbar'); if (!bar) return;
    bar.classList.toggle('hidden', selected.size === 0);
    if (selected.size) q('.dmap-selcount').textContent = `${selected.size} selected`;
  }
  // Rename a PROPOSED (not-yet-existing) folder: rewrite every placement under it.
  function renameNewFolder(rel) {
    const parts = rel.split('/'); const old = parts[parts.length - 1];
    pickName('Rename folder', old, 'New folder name', (name) => {
      const clean = name.trim(); if (!clean || clean === old) return;
      const parent = parts.slice(0, -1).join('/');
      const next = (parent ? parent + '/' : '') + slug(clean);
      for (const k of Object.keys(placement)) {
        if (placement[k] === rel) placement[k] = next;
        else if (placement[k].startsWith(rel + '/')) placement[k] = next + placement[k].slice(rel.length);
      }
      renderTree();
    });
  }
  // Edit subject/location for one or more clips, write it back to the real clip
  // (so it sticks to the metadata), and re-file any still on their auto folder.
  function editClipMeta(targets) {
    const first = targets[0];
    const many = targets.length > 1;
    pickMeta(many ? `Edit ${targets.length} clips` : (first.name || 'Edit clip'),
      { subject: many ? '' : first.subject, location: many ? '' : first.location },
      (patch) => {
        for (const c of targets) {
          if (patch.subject != null) c.subject = patch.subject;
          if (patch.location != null) c.location = patch.location;
          if (onEditMeta && c._ref) onEditMeta(c._ref, { subject: c.subject, location: c.location });
        }
        recomputeAuto();   // corrected metadata re-routes any clip still on auto
        renderTree();
      });
  }
  // Folder picker: filter existing folders or type a new relative path.
  function pickFolder(current, cb) {
    const p = document.createElement('div'); p.className = 'modal-overlay';
    p.innerHTML = `<div class="modal-card dmap-pick">
      <h3>Move to folder</h3>
      <input type="text" class="ai-input dpk-input" value="${escapeAttr(current || '')}" placeholder="type a new path, e.g. 2026/2026 - Client Work/Acme Co/Day 01" />
      <div class="dpk-list"></div>
      <div class="modal-actions"><button type="button" class="btn primary dpk-ok">Use this</button><button type="button" class="btn dpk-cancel">Cancel</button></div></div>`;
    document.body.appendChild(p);
    const pq = (s) => p.querySelector(s);
    const closeP = () => p.remove();
    pq('.dpk-cancel').addEventListener('click', closeP);
    p.addEventListener('mousedown', (e) => { if (e.target === p) closeP(); });
    const input = pq('.dpk-input');
    const renderList = () => {
      const f = input.value.trim().toLowerCase();
      const matches = folderPaths.filter((fp) => !f || fp.toLowerCase().includes(f)).slice(0, 40);
      pq('.dpk-list').innerHTML = matches.map((fp) => `<button type="button" class="dpk-row" data-p="${escapeAttr(fp)}">${escapeHtml(fp)}</button>`).join('') || '<p class="muted small">No matching folder — this will be created as a new one.</p>';
      pq('.dpk-list').querySelectorAll('.dpk-row').forEach((b) => b.addEventListener('click', () => { input.value = b.dataset.p; }));
    };
    input.addEventListener('input', renderList);
    renderList();
    setTimeout(() => input.focus(), 30);
    pq('.dpk-ok').addEventListener('click', () => { const v = input.value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim(); if (v) cb(v); closeP(); });
  }
  // Tiny single-field name prompt (used for renaming a proposed folder).
  function pickName(title, current, placeholder, cb) {
    const p = document.createElement('div'); p.className = 'modal-overlay';
    p.innerHTML = `<div class="modal-card modal-form dmap-pick">
      <h3>${escapeHtml(title)}</h3>
      <input type="text" class="ai-input dpk-name" value="${escapeAttr(current || '')}" placeholder="${escapeAttr(placeholder || '')}" />
      <div class="modal-actions"><button type="button" class="btn primary dpk-ok">Save</button><button type="button" class="btn dpk-cancel">Cancel</button></div></div>`;
    document.body.appendChild(p);
    const pq = (s) => p.querySelector(s);
    const closeP = () => p.remove();
    const inp = pq('.dpk-name');
    pq('.dpk-cancel').addEventListener('click', closeP);
    p.addEventListener('mousedown', (e) => { if (e.target === p) closeP(); });
    const ok = () => { cb(inp.value || ''); closeP(); };
    pq('.dpk-ok').addEventListener('click', ok);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  }
  // Subject + location editor — the fix that sticks to the metadata so a wrongly
  // labelled clip stops grouping with the wrong folder.
  function pickMeta(title, current, cb) {
    const p = document.createElement('div'); p.className = 'modal-overlay';
    p.innerHTML = `<div class="modal-card modal-form dmap-pick">
      <h3>${escapeHtml(title)}</h3>
      <label class="dpk-flabel muted small">Subject</label>
      <input type="text" class="ai-input dpk-subj" value="${escapeAttr(current.subject || '')}" placeholder="e.g. calisthenics" />
      <label class="dpk-flabel muted small">Location</label>
      <input type="text" class="ai-input dpk-loc" value="${escapeAttr(current.location || '')}" placeholder="e.g. backyard" />
      <div class="modal-actions"><button type="button" class="btn primary dpk-ok">Save</button><button type="button" class="btn dpk-cancel">Cancel</button></div></div>`;
    document.body.appendChild(p);
    const pq = (s) => p.querySelector(s);
    const closeP = () => p.remove();
    pq('.dpk-cancel').addEventListener('click', closeP);
    p.addEventListener('mousedown', (e) => { if (e.target === p) closeP(); });
    pq('.dpk-ok').addEventListener('click', () => { cb({ subject: slug(pq('.dpk-subj').value), location: slug(pq('.dpk-loc').value) }); closeP(); });
    setTimeout(() => pq('.dpk-subj').focus(), 30);
  }
  q('.dmap-root-btn').addEventListener('click', async () => { const r = await window.api.pickProjectsRoot(); if (r) loadTree(); });
  // Plan ⇄ Folders view toggle. The legend is only meaningful for the colour-coded tree.
  card.querySelectorAll('.dmap-vt').forEach((b) => b.addEventListener('click', () => {
    viewMode = b.dataset.view;
    card.querySelectorAll('.dmap-vt').forEach((x) => x.classList.toggle('on', x === b));
    const lg = q('.dmap-legend'); if (lg) lg.classList.toggle('hidden', viewMode !== 'tree');
    card.classList.toggle('dmap-planmode', viewMode === 'plan');
    render();
  }));
  card.classList.toggle('dmap-planmode', viewMode === 'plan');
  { const mo = q('.dmap-more'); if (mo) mo.addEventListener('click', () => { const t = q('.dmap-moretools'); if (t) t.classList.toggle('hidden'); }); }
  q('.dmap-rules').addEventListener('click', () => showRoutingRules(folderPaths, () => { recomputeAuto(); render(); }, clips.map((c) => ({ name: c.name, subject: c.subject, location: c.location, description: c.description, date: c.date }))));
  // Iterative refine: the user types what's wrong, the AI re-plans, repeat until right.
  q('.dmap-refine').addEventListener('click', () => showRefinePrompt((feedback) => { if (feedback) runAiPlan(feedback); }));
  // Run the AI placement pass over the still-auto clips (or a given pool) and apply
  // its destinations, carrying each clip's AI "why"/confidence into placeMeta so the
  // plan view shows it. Used by the primary Suggest button, Refine, and auto-plan.
  async function runAiPlan(feedback, opts = {}) {
    if (!aiReady()) { if (!opts.silent) showToast('Turn on AI to plan placement'); return 0; }
    const auto = clips.filter((c) => autoKeys.has(c.key));
    const pool = opts.pool || (auto.length ? auto : clips);   // default: everything still on auto
    if (!pool.length) { if (!opts.silent) showToast('Nothing left to plan'); return 0; }
    aiActivity(feedback ? 'AI is re-planning with your notes…' : 'AI is planning where each clip goes…', '');
    let r;
    try { r = await window.api.aiSuggestProjects({ clips: pool.map((c) => ({ name: c.name, subject: c.subject, description: c.description, location: c.location, date: c.date, observation: dmapObs(c), people: dmapPeople(c) })), folders: folderPaths, categories: treeCategories(), context: '', feedback: feedback || '' }); }
    catch { aiActivityDone('Could not plan — check the model in AI settings'); return 0; }
    if (!r || !r.ok || !Array.isArray(r.placements)) { aiActivityDone(r && r.error ? r.error : 'Could not plan'); return 0; }
    // Group placements by destination project, remembering each clip's reason/conf.
    const byPath = {}; const whyByKey = {};
    r.placements.forEach((pl) => { const c = pool[pl.i]; if (!c) return; const dest = projectBase(pl.path) || pl.path; (byPath[dest] = byPath[dest] || []).push(c); whyByKey[c.key] = { why: pl.why || 'AI placed', conf: pl.confidence }; });
    let placed = 0;
    for (const dest of Object.keys(byPath)) {
      for (const pc of placeGroupClips({ dest, clips: byPath[dest] })) {
        placement[pc.key] = pc.dest; autoKeys.delete(pc.key); recentlyPlaced.add(pc.key);
        const w = whyByKey[pc.key] || {}; setMeta(pc.key, w.why || 'AI placed', (w.conf == null ? 0.6 : w.conf), 'ai');
        placed += 1;
      }
    }
    aiActivityDone(placed ? `${feedback ? 'Re-planned' : 'Planned'} ${placed} clip${placed !== 1 ? 's' : ''} ✓` : 'No changes — try being more specific');
    render();
    return placed;
  }
  // Live activity strip — shows the user exactly what the AI is doing, step by step.
  const activity = () => q('.dmap-ai-activity');
  let thinkTimer = null;
  function aiActivity(msg, prog) {
    const a = activity(); a.classList.remove('hidden');
    q('.dmap-ai-msg').textContent = msg || '';
    q('.dmap-ai-prog').textContent = prog || '';
  }
  function aiActivityDone(msg) {
    if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; }
    q('.dmap-spinner').classList.add('done');
    q('.dmap-ai-msg').textContent = msg || ''; q('.dmap-ai-prog').textContent = '';
    setTimeout(() => { const a = activity(); if (a) a.classList.add('hidden'); q('.dmap-spinner').classList.remove('done'); }, 4000);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Reveal a set of {key,clips,dest} groups (+loose singles) into the tree one at a
  // time, with the activity strip + per-clip flash. Used by the Suggest wizard's Run.
  async function applyGroupsAnimated(groups, singles) {
    recentlyPlaced.clear();
    let placed = 0; const folderSet = new Set();
    for (const g of singles) { const dest = `${g.cat || pickCategory(g.rep)}/_Unsorted`; placement[g.rep.key] = dest; autoKeys.delete(g.rep.key); recentlyPlaced.add(g.rep.key); folderSet.add(dest); placed += 1; }
    if (singles.length) { aiActivity(`Filing ${singles.length} loose clip${singles.length !== 1 ? 's' : ''} → _Unsorted`, ''); renderTree(); await sleep(220); }
    for (let gi = 0; gi < groups.length; gi += 1) {
      const g = groups[gi];
      const placements = placeGroupClips(g);
      for (const pl of placements) { placement[pl.key] = pl.dest; autoKeys.delete(pl.key); recentlyPlaced.add(pl.key); folderSet.add(pl.dest); }
      placed += g.clips.length;
      const days = new Set(placements.map((p) => p.dest)).size;
      aiActivity(`Filing “${g.key}” (${g.clips.length})${days > 1 ? ` → ${days} day-folders` : ` → ${g.dest.split('/').slice(-2).join('/')}`}`, `${gi + 1}/${groups.length}`);
      renderTree();
      // eslint-disable-next-line no-await-in-loop
      await sleep(240);
    }
    aiActivityDone(`Placed ${placed} clip${placed !== 1 ? 's' : ''} into ${folderSet.size} folder${folderSet.size !== 1 ? 's' : ''} ✓`);
    q('.dmap-status').textContent = `${placed} placed`;
  }

  // 4-step "Suggest with AI" wizard — gathers what the user wants, the AI runs a
  // grouping pass mid-wizard, the user reviews/edits the plan, then Run files it.
  // GUARDRAIL: most mis-placements come from clips that were never analyzed with AI
  // (so the AI only sees a generic label like "vlog") and never face-scanned. Offer to
  // do that first when a big chunk of the batch is missing it.
  // Analyze the destination-map clips IN PLACE — works at any stage, straight from
  // each clip's source file (no need to be the live rename grid). Updates each clip's
  // subject/description/observation so the AI can place it correctly, then re-plans.
  async function analyzeDmapTargets(targets) {
    const pool = targets.filter((c) => c.sourcePath);
    if (!pool.length) { showToast('No source files to analyze'); return 0; }
    aiAborted = false;
    const faceOk = (await ensureFaceModels()).ok;         // scan faces too if set up
    const subjKey = (c) => slug(c.subject || c.location || '') || 'x';
    // For BIG batches, analyze ONE representative clip per subject (placement only
    // needs to understand the subject) and apply its observation/people to siblings —
    // turns hundreds of slow vision calls into a handful. Small batches: analyze each.
    const groups = {};
    for (const c of pool) { (groups[subjKey(c)] = groups[subjKey(c)] || []).push(c); }
    const sample = pool.length > 24 && Object.keys(groups).length < pool.length;
    const reps = sample ? Object.values(groups).map((g) => g[0]) : pool;
    setAiRunClips(reps);                                   // real-thumbnail conveyor for these clips
    let done = 0; let ok = 0;
    const faceClusters = []; const faceAutoByName = new Map(); let faceAuto = 0;   // → "Review faces" popup at the end
    for (const c of reps) {
      if (aiAborted) break;
      const r = c._ref || c;
      setTask('ai', aiModelLabel(), done + 1, reps.length, sample ? 'subject' : 'analyzing', c.name);
      const hasObs = !!String((r.observation || (r.meta && r.meta.observation) || c.observation || '')).trim();
      if (!(hasObs && (!faceOk || r._facesScanned))) {
        // 1) FACES — detect + match recognized people, tag the clip, and gather any
        //    new/uncertain faces so we can offer a naming popup once everything's done.
        if (faceOk && !r._facesScanned) {
          aiStageAdvance(c, 'scanning faces');
          // eslint-disable-next-line no-await-in-loop
          faceAuto += await collectClipFaces(c, faceClusters);
        }
        if (aiAborted) break;
        // 2) DESCRIBE — vision analysis (uses the people we just found).
        aiStageAdvance(c, 'analyzing');
        pushActivity(`Asking ${aiModelLabel()} to describe ${c.name}…`, 'describe');
        try {
          // eslint-disable-next-line no-await-in-loop
          const res = await window.api.aiSuggest({ sourcePath: c.sourcePath, model: aiCfg.model, quick: true, subjects: subjectsCache, categories: (aiCfg.suggestCategory && fieldHistoryCache.category) ? fieldHistoryCache.category : [], context: '', people: c.people || r.people || [], observation: '' });
          if (res && res.ok) {
            if (res.subject || res.description) pushActivity(`Wrote: ${[res.subject, res.description].filter(Boolean).join(' — ')}`, 'write');
            if (res.subject) { c.subject = res.subject; r.subject = res.subject; }
            if (res.description) { c.description = res.description; r.description = res.description; }
            if (Array.isArray(res.tags) && res.tags.length) r.tags = [...new Set([...(r.tags || []), ...res.tags])];
            const obs = res.observation || '';
            if (obs) { c.observation = obs; r.observation = obs; try { clipObsCache[clipKey(r)] = { obs, ts: Date.now() }; window.api.saveClipObs({ key: clipKey(r), obs }); } catch { /* non-fatal */ } }
            ok += 1;
          }
        } catch { /* keep going */ }
      } else { aiStageAdvance(c, 'already analyzed'); ok += 1; }
      // Propagate this rep's understanding to its same-subject siblings (placement only).
      if (sample) {
        for (const sib of (groups[subjKey(c)] || [])) {
          if (sib === c) continue;
          const sr = sib._ref || sib;
          if (c.observation && !String(sr.observation || sib.observation || '').trim()) {
            sib.observation = c.observation; sr.observation = c.observation;
            try { clipObsCache[clipKey(sr)] = { obs: c.observation, ts: Date.now() }; window.api.saveClipObs({ key: clipKey(sr), obs: c.observation }); } catch { /* non-fatal */ }
          }
          if (Array.isArray(c.people) && c.people.length) { const u = [...new Set([...(sib.people || []), ...c.people])]; sib.people = u; sr.people = u; }
        }
      }
      done += 1;
    }
    clearTask('ai');
    aiStageClose();
    const note = sample ? `Analyzed ${ok} subject${ok !== 1 ? 's' : ''} across ${pool.length} clips ✓` : `Analyzed ${ok} of ${pool.length} (faces + descriptions) ✓`;
    showToast(aiAborted ? `Stopped — analyzed ${ok}` : note, 4500);
    recomputeAuto(); renderTree();
    if (faceOk && !aiAborted) refreshAllClipPeople && refreshAllClipPeople();
    // Faces found → let the user name/confirm them (this is the assign-faces popup).
    if (faceClusters.length) setTimeout(() => showFaceReviewGrid(faceClusters, pool, faceAuto), 350);
    return ok;
  }
  async function ensureAnalyzedFirst(targets) {
    if (!aiReady()) return 'proceed';
    const obsOf = (c) => { const r = c._ref || {}; const m = r.meta || {}; return (r.observation && String(r.observation).trim()) || (clipObsCache[clipKey(r)] && clipObsCache[clipKey(r)].obs) || (m.observation || '') || ''; };
    // A clip counts as analyzed if it has an AI observation OR was marked analyzed by the
    // Match-screen Analyze (aiAnalyzed). Faces don't gate placement (placement uses the
    // subject/description), so we no longer re-prompt just because faces aren't scanned.
    const analyzedOf = (c) => { const r = c._ref || {}; const m = r.meta || {}; return !!(m.aiAnalyzed || r._aiAnalyzed) || !!obsOf(c); };
    const half = Math.ceil(targets.length * 0.5);
    const noObs = targets.filter((c) => !analyzedOf(c)).length;
    if (noObs < half) return 'proceed';   // mostly analyzed already
    // Live rename-stage clips can use the full Analyze flow (with face-scan offer);
    // organize-stage clips analyze in place from their files.
    const stateClips = targets.map((c) => c._ref).filter((r) => r && state.scannedFiles.indexOf(r) >= 0);
    const live = stateClips.length >= half;
    return await new Promise((resolve) => {
      const ov = document.createElement('div'); ov.className = 'modal-overlay';
      ov.innerHTML = `<div class="modal-card modal-form" style="width:min(510px,93vw);text-align:left">
        <div class="illo mob-illo">${ILLO_SCAN}</div>
        <div class="ai-hd" style="margin-top:2px"><div class="ai-hd-text"><h3>Analyze these clips first?</h3><p class="muted small"><b>${noObs} of ${targets.length}</b> of these clips haven't been analyzed yet. Without it the AI only sees a generic label like “vlog” and can file footage into the wrong project.</p><p class="muted small" style="margin-top:6px">This will, for every clip that needs it: <b>watch the footage</b>, <b>scan for faces</b> (recognized people are suggested for you to confirm afterwards — never auto-tagged), then write a real <b>subject, description & tags</b> — so it places into the right project.</p></div></div>
        <div class="modal-actions">
          <button type="button" class="btn primary eaf-analyze">Analyze + scan faces</button>
          <button type="button" class="btn eaf-anyway">Suggest anyway</button>
          <button type="button" class="btn eaf-cancel">Cancel</button>
        </div>
      </div>`;
      document.body.appendChild(ov);
      const done = (v) => { ov.remove(); resolve(v); };
      ov.querySelector('.eaf-analyze').addEventListener('click', async () => {
        done('analyze');
        if (live) {
          // full Rename-grid flow: select the clips and run Analyze (offers face scan).
          clearSelection(); stateClips.forEach((r) => { r.selected = true; }); close();
          setTimeout(() => aiAnalyzeSelected(), 60);
        } else {
          const n = await analyzeDmapTargets(targets);   // analyze right here, in the map
          if (n) setTimeout(() => runAiPlan(''), 250);   // then re-plan with real data
        }
      });
      ov.querySelector('.eaf-anyway').addEventListener('click', () => done('proceed'));
      ov.querySelector('.eaf-cancel').addEventListener('click', () => done('cancel'));
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) done('cancel'); });
    });
  }
  async function openSuggestWizard() {
    if (!aiReady()) { showToast('Turn on AI first'); return; }
    // Clips matched by a filing RULE (route or descriptor) are already placed
    // correctly by the rules engine — incl. per-day folders. The wizard's AI only
    // handles the truly UNROUTED clips, so it never overrides your rules/by-day.
    const targets = clips.filter((c) => { if (!autoKeys.has(c.key)) return false; const { route, desc } = rulesFor(c); return !route && !desc; });
    if (!targets.length) { showToast('Your filing rules already placed everything — nothing left for the AI. Edit rules with “Filing rules…”.'); return; }
    const gate = await ensureAnalyzedFirst(targets);
    if (gate !== 'proceed') return;   // user cancelled or chose to analyze first
    const dates = [...new Set(targets.map((c) => c.date).filter(Boolean))].sort();
    const dateSpan = dates.length ? (dates.length === 1 ? dates[0] : `${dates[0]} → ${dates[dates.length - 1]}`) : 'no dates';
    // A clip's grouping label: its subject, else location, else derived from the
    // FILENAME (strip date / version / camera-default tokens). On the Organize stage
    // the compressed files often have an empty meta.subject but the name carries it
    // (2026-05-16_lawnmowing_liam_v6.mp4 → "lawnmowing"), so this keeps questions/
    // grouping from collapsing to "misc".
    const clipLabel = (c) => {
      let s = slug(c.subject || '') || slug(c.location || '');
      if (s) return s;
      const stem = String(c.name || '').replace(/\.[^.]+$/, '');
      const toks = stem.split(/[_\s]+/).filter((t) => t && !/^\d{4}-\d{2}-\d{2}$/.test(t) && !/^v\d+$/i.test(t) && !/^\d{4,}$/.test(t) && !/^(gx|gopro|hero|dji|img|dsc|mvi)\w*$/i.test(t));
      return slug(toks[0] || '') || 'untitled';
    };
    // Group by a canonical key so spelling variants merge (lawn-mowing == lawnmowing).
    const canon = (s) => String(s).replace(/[^a-z0-9]/gi, '').toLowerCase();
    const gmap = new Map();
    for (const c of targets) { const lab = clipLabel(c); const k = canon(lab) || 'misc'; if (!gmap.has(k)) gmap.set(k, { key: lab, rep: c, clips: [] }); gmap.get(k).clips.push(c); }
    const groupsAll = [...gmap.values()];
    const wiz = { step: 0, ctx: '', people: '', locations: [...new Set(targets.map((c) => c.location).filter(Boolean))].join(', '), groups: null, singles: groupsAll.filter((g) => g.clips.length === 1), questions: null, answers: {} };
    // ONE good question per real subject — deterministic, no redundancy, real
    // options. (The free-form AI version produced redundant/nonsensical questions
    // like "Is 'delete' a project?" and asked "project or descriptor" AND "where"
    // for the same subject.) Junk/camera-default names and delete-markers are
    // recognised and asked the right thing.
    // Snap an AI free-text answer onto one of the question's real options so the chip
    // lights up (e.g. "descriptor" → "It's a descriptor", a category synonym/leaf →
    // the exact preset). Falls back to the raw answer (shown as its own chip).
    function normAnswerToHint(a, hints) {
      const lc = String(a || '').trim().toLowerCase();
      if (!lc) return '';
      if (/descript/.test(lc)) return hints.find((h) => /descript/.test(h.toLowerCase())) || "It's a descriptor";
      if (/^(delete|trash|bin|reject)/.test(lc)) return hints.find((h) => /delete/.test(h.toLowerCase())) || 'Delete later';
      if (/unsort|leave|skip/.test(lc)) return hints.find((h) => /unsort|leave/.test(h.toLowerCase())) || lc;
      const exact = hints.find((h) => h.toLowerCase() === lc); if (exact) return exact;
      const part = hints.find((h) => h.toLowerCase().includes(lc) || lc.includes(h.toLowerCase())); if (part) return part;
      return String(a).trim();
    }
    function buildSubjectQuestions() {
      // Merge variant spellings (lawn-mowing == lawnmowing) under one canonical key;
      // display the most common original spelling.
      const byKey = {};
      for (const c of targets) { const s = clipLabel(c); if (!s) continue; const k = canon(s); if (!k) continue; (byKey[k] = byKey[k] || { n: 0, origs: {} }); byKey[k].n += 1; byKey[k].origs[s] = (byKey[k].origs[s] || 0) + 1; }
      const subjects = Object.keys(byKey).sort((a, b) => byKey[b].n - byKey[a].n).slice(0, 12)
        .map((k) => ({ label: Object.entries(byKey[k].origs).sort((a, b) => b[1] - a[1])[0][0], n: byKey[k].n }));
      const cats = treeCategories();
      const catShort = cats.map((p) => p.split('/').pop().replace(/^\d{4}\s*-\s*/, ''));
      // Real project folders for hints — exclude folders that look like CLIP files
      // (date_subject_vN) wrongly sitting as folders, so the options stay clean.
      const looksLikeClip = (n) => /^\d{4}-\d{2}-\d{2}[_-]/.test(n) || /_v\d+$/i.test(n);
      const projSet = new Set();
      for (const fp of folderPaths) { const parts = fp.split('/'); if (parts.length >= 3 && /^\d{4}$/.test(parts[0]) && !looksLikeClip(parts[2])) projSet.add(parts[2]); }
      const projects = [...projSet];
      const DESCRIPTORS = ['vlog', 'pov', 'timelapse', 'time-lapse', 'b-roll', 'broll', 'montage', 'cutaway', 'slowmo', 'slow-mo', 'interview', 'talking-head', 'establishing', 'cinematic'];
      const isJunk = (s) => /^(gx|gopro|hero|dji|img|mvi|dsc|mov|vid|clip|untitled|misc|new|file)?[-_ ]*\d{3,}[a-z]*$/i.test(s) || /^\d{3,}$/.test(s);
      const isDelete = (s) => /(^|[-_ ])(delete|trash|junk|reject|bin)([-_ ]|$)/i.test(s);
      const qs = [];
      for (const { label: s, n } of subjects) {
        const lbl = `${n} clip${n !== 1 ? 's' : ''}`;
        if (isDelete(s)) { qs.push({ subject: s, count: n, q: `Delete the ${lbl} tagged '${s}' later?`, hints: ['Delete later', 'Keep — unsorted'] }); continue; }
        if (isJunk(s)) { qs.push({ subject: s, count: n, q: `'${s}' (${lbl}) looks unnamed — where should it go?`, hints: ['Leave unsorted', ...catShort] }); continue; }
        const isDesc = DESCRIPTORS.some((d) => s === d || s.includes(d));
        const folderHints = projects.filter((p) => p.toLowerCase().includes(s.split('-')[0]) || s.includes(p.toLowerCase().split(' ')[0])).slice(0, 3);
        // Shot-type words → lead with "It's a descriptor"; real subjects → lead with folders.
        // (One consistent straight apostrophe so it never double-lists as two options.)
        const base = isDesc ? ["It's a descriptor", ...folderHints, ...catShort] : [...folderHints, ...catShort, "It's a descriptor"];
        const seen = new Set();
        const hints = [...base, 'Delete later'].filter((h) => { const k = String(h).toLowerCase().trim(); if (!k || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
        qs.push({ subject: s, count: n, q: `Where should '${s}' (${lbl}) go?`, hints });
      }
      return qs;
    }
    const batchSummary = () => {
      const cnt = {}; for (const c of targets) { const s = c.subject || c.location || 'untitled'; cnt[s] = (cnt[s] || 0) + 1; }
      const subjList = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([s, n]) => `${s} (${n})`).join(', ');
      const locs = [...new Set(targets.map((c) => c.location).filter(Boolean))].slice(0, 12).join(', ');
      return `- ${targets.length} clips, dates ${dateSpan}\n- subjects (with counts): ${subjList || 'none'}\n- locations: ${locs || 'none'}`;
    };

    const TITLES = ['A few quick questions', 'People & places', 'Grouping plan', 'Review & run'];
    const ov = document.createElement('div'); ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal-card modal-form sw-card">
      <div class="sw-dots"></div>
      <h3 class="sw-title"></h3>
      <div class="sw-body"></div>
      <div class="modal-actions sw-actions">
        <button type="button" class="btn sw-back">Back</button>
        <button type="button" class="btn primary sw-next">Next</button>
        <button type="button" class="btn sw-cancel">Cancel</button>
      </div></div>`;
    document.body.appendChild(ov);
    const wq = (s) => ov.querySelector(s);
    const closeW = () => ov.remove();
    wq('.sw-cancel').addEventListener('click', closeW);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeW(); });

    const ctxLabel = () => {
      const qa = (wiz.questions || []).map((qq, i) => { const a = (wiz.answers[i] || '').trim(); if (!a) return ''; return qq.subject ? `'${qq.subject}' → ${a}` : `${qq.q} — ${a}`; }).filter(Boolean);
      // Auto-accepted subject→folder picks still inform placement even though we didn't ask.
      const auto = (wiz.autoResolved || []).map((r) => `'${r.subject}' → ${r.answer}`);
      return [...qa, ...auto, wiz.ctx, wiz.people && `People: ${wiz.people}`, wiz.locations && `Locations: ${wiz.locations}`].filter(Boolean).join('. ');
    };
    // Step 1's body: the AI's clarifying questions (with tap-able hints) + a free box.
    function drawQuestions() {
      const body = wq('.sw-body');
      const qs = wiz.questions || [];
      const autoN = (wiz.autoResolved || []).length;
      if (!qs.length) {
        // Everything got a confident answer — nothing to ask. Show what was auto-filed.
        const list = (wiz.autoResolved || []).slice(0, 14).map((r) => `<span class="sw-auto-chip">${escapeHtml(r.subject)} → <b>${escapeHtml(r.answer)}</b></span>`).join('');
        body.innerHTML = `<p class="muted small">${autoN ? `The AI confidently filed all ${autoN} subject${autoN !== 1 ? 's' : ''} — nothing to confirm here (you'll review the full plan next).` : `Your filing rules already cover these ${targets.length} clip${targets.length !== 1 ? 's' : ''} — nothing to ask.`}</p>
          ${list ? `<div class="sw-auto-list">${list}</div>` : ''}
          <label class="dpk-flabel muted small">Anything else?</label>
          <textarea class="ai-input sw-ctx" rows="2" placeholder="optional context for the AI">${escapeHtml(wiz.ctx)}</textarea>`;
      } else {
        // Chip-first rows: one tappable option per answer, the AI's pick badged ✦ and
        // pre-selected. No always-on text box (that's what looked duplicated) — a quiet
        // "Other…" reveals a field only when you want a custom answer.
        // Every real category + project folder, for an autocomplete you can TYPE into
        // (so a typed category is recognized without an exact guess, and lights its chip).
        const looksLikeClip = (n) => /^\d{4}-\d{2}-\d{2}[_-]/.test(n) || /_v\d+$/i.test(n);
        const destOpts = new Set();
        for (const p of treeCategories()) destOpts.add(p.split('/').pop().replace(/^\d{4}\s*-\s*/, ''));
        for (const fp of folderPaths) { const parts = fp.split('/'); if (parts.length >= 3 && /^\d{4}$/.test(parts[0]) && !looksLikeClip(parts[2])) destOpts.add(parts[2]); }
        const datalist = `<datalist id="sw-dest-opts">${[...destOpts].map((o) => `<option value="${escapeAttr(o)}"></option>`).join('')}</datalist>`;
        const rowsHtml = qs.map((qq, i) => {
          const raw = (wiz.answers[i] || '').trim();
          const ansLc = raw.toLowerCase();
          const aiLc = (qq.aiPick || '').toLowerCase();
          let chipList = qq.hints || [];
          // If the AI picked something not in the presets, surface it as its own chip.
          if (raw && !chipList.some((h) => h.toLowerCase() === ansLc)) chipList = [raw, ...chipList];
          const hints = chipList.map((h) => {
            const on = ansLc && ansLc === h.toLowerCase();
            const rec = aiLc && aiLc === h.toLowerCase();
            return `<button type="button" class="sw-hint${on ? ' on' : ''}${rec ? ' rec' : ''}" data-i="${i}" data-h="${escapeAttr(h)}">${rec ? '<span class="sw-rec-ic">✦</span>' : ''}${escapeHtml(h)}</button>`;
          }).join('');
          // Input is ALWAYS visible now (with the folder autocomplete) — no "Other…" gate.
          return `<div class="sw-q"><div class="sw-qq">${escapeHtml(qq.q)}</div><div class="sw-hints">${hints}</div><input type="text" class="ai-input sw-qa" list="sw-dest-opts" data-i="${i}" value="${escapeAttr(raw)}" placeholder="…or type / pick a folder" /></div>`;
        }).join('');
        body.innerHTML = `<p class="muted small">${autoN ? `The AI auto-filed ${autoN} clear subject${autoN !== 1 ? 's' : ''}. Just these ${qs.length} need your call` : 'The AI suggested an answer (✦) for each'} — tap a chip or type a folder. Skip any.</p>${datalist}<div class="sw-qs">${rowsHtml}</div><label class="dpk-flabel muted small">Anything else?</label><textarea class="ai-input sw-ctx" rows="2" placeholder="optional extra context">${escapeHtml(wiz.ctx)}</textarea>`;
        // Typing → record the answer AND light up a chip whose label matches what you typed.
        body.querySelectorAll('.sw-qa').forEach((inp) => inp.addEventListener('input', () => {
          const i = +inp.dataset.i; wiz.answers[i] = inp.value;
          const v = inp.value.trim().toLowerCase();
          body.querySelectorAll(`.sw-hint[data-i="${i}"]`).forEach((x) => x.classList.toggle('on', !!v && (x.dataset.h || '').toLowerCase() === v));
        }));
        body.querySelectorAll('.sw-hint').forEach((b) => b.addEventListener('click', () => {
          const i = +b.dataset.i; const inp = body.querySelector(`.sw-qa[data-i="${i}"]`);
          inp.value = b.dataset.h; wiz.answers[i] = b.dataset.h;
          body.querySelectorAll(`.sw-hint[data-i="${i}"]`).forEach((x) => x.classList.toggle('on', x === b));
        }));
      }
      body.querySelector('.sw-ctx').addEventListener('input', (e) => { wiz.ctx = e.target.value; });
      // Turn the answers into PERMANENT filing rules the app remembers (proposed,
      // you confirm each). This is how the data you give is saved for the future.
      const mk = document.createElement('button');
      mk.type = 'button'; mk.className = 'btn subtle sw-mkrules'; mk.textContent = '✨ Save these answers as filing rules…';
      mk.addEventListener('click', async () => {
        const text = ctxLabel(); if (!text.trim()) { showToast('Answer a question first'); return; }
        mk.disabled = true; mk.textContent = 'Thinking…';
        const res = await window.api.aiParseRules({ text, folders: folderPaths });
        mk.disabled = false; mk.textContent = '✨ Save these answers as filing rules…';
        if (res && res.ok && res.rules.length) { closeW(); showRoutingRules(folderPaths, () => { recomputeAuto(); renderTree(); }, clips.map((c) => ({ name: c.name, subject: c.subject, location: c.location, description: c.description, date: c.date })), res.rules); }
        else showToast(res && res.error ? res.error : 'No rules to propose from those answers');
      });
      body.appendChild(mk);
    }

    async function ensureGroups() {
      if (wiz.groups) return;
      const multi = groupsAll.filter((g) => g.clips.length > 1);
      const multiClipCount = multi.reduce((s, g) => s + g.clips.length, 0);
      const body = wq('.sw-body');
      body.innerHTML = `<div class="sw-think"><span class="illo sw-think-illo">${ILLO_THINKING}</span><span>AI is sorting your ${multiClipCount} clip${multiClipCount !== 1 ? 's' : ''} into ${multi.length} subject${multi.length !== 1 ? 's' : ''} (lawn-mowing, vlog, …) and choosing a folder for each…</span></div>`;
      let byIdx = {};
      if (multi.length) {
        const r = await window.api.aiSuggestProjects({ clips: multi.map((g) => ({ name: g.rep.name, subject: g.rep.subject, description: g.rep.description, location: g.rep.location, date: g.rep.date, observation: dmapObs(g.rep), people: dmapPeople(g.rep) })), folders: folderPaths, categories: treeCategories(), context: ctxLabel() });
        if (r && r.ok) for (const pl of r.placements) byIdx[pl.i] = pl.path;
      }
      wiz.groups = multi.map((g, gi) => ({ key: g.key, clips: g.clips, dest: projectBase(byIdx[gi] || `${pickCategory(g.rep)}/${g.key}`) }));
      // Pre-fetch the inner layout for any group that spans multiple days (so the
      // per-day split mirrors the project's existing subfolder structure).
      const multiDayDests = [...new Set(wiz.groups.filter((g) => new Set(g.clips.map((c) => c.date).filter(Boolean)).size > 1).map((g) => g.dest))];
      for (const d of multiDayDests) {
        if (dayInner[d] === undefined && folderPaths.includes(d)) {
          try { const il = await window.api.projectsInnerLayout(d); dayInner[d] = (il && il.ok && il.inner) ? il.inner : ''; } catch { dayInner[d] = ''; }
        }
      }
    }

    function renderStep() {
      wq('.sw-dots').innerHTML = TITLES.map((_, i) => `<span class="sw-dot${i === wiz.step ? ' on' : ''}${i < wiz.step ? ' done' : ''}"></span>`).join('');
      wq('.sw-title').textContent = `${wiz.step + 1}. ${TITLES[wiz.step]}`;
      wq('.sw-back').style.visibility = wiz.step === 0 ? 'hidden' : '';
      wq('.sw-next').textContent = wiz.step === 3 ? 'Run placement' : 'Next';
      const body = wq('.sw-body');
      if (wiz.step === 0) {
        if (!wiz.questions) {
          wiz.questions = buildSubjectQuestions();
          // Analyze with AI: let it pre-answer each subject (which folder / descriptor
          // / delete / unsorted); the user just confirms. Questions still show if AI fails.
          body.innerHTML = `<div class="sw-think"><span class="illo sw-think-illo">${ILLO_THINKING}</span><span>Analyzing your ${targets.length} clips…</span></div>`;
          window.api.aiAnswerSubjects({ subjects: wiz.questions.map((x) => ({ subject: x.subject, count: x.count || 1 })), folders: folderPaths, categories: treeCategories() })
            .then((res) => {
              if (res && res.ok && res.answers) {
                wiz.questions.forEach((x, i) => {
                  let a = res.answers[String(x.subject).toLowerCase()];
                  if (a && a.includes('/')) a = a.split('/').filter(Boolean).pop();   // a path slipped in → use the leaf folder
                  a = normAnswerToHint(a, x.hints || []);   // snap to a real option so the chip lights up
                  if (a && !(wiz.answers[i] || '').trim()) { wiz.answers[i] = a; x.aiPick = a; }
                });
                // Don't make the user confirm 20 obvious ones. When the AI confidently
                // placed a subject into a concrete folder (e.g. "yardwork" → lawn-mowing),
                // auto-accept it and hide that question — only KEEP the genuinely unsure
                // ones (no answer, or "leave unsorted"). The full plan is still reviewed
                // in step 2, so auto-accepted picks are never silently final.
                const kept = []; const keptAnswers = {}; wiz.autoResolved = [];
                wiz.questions.forEach((x, i) => {
                  const a = (wiz.answers[i] || '').trim();
                  const unsure = !a || /unsort|leave|^other/i.test(a);
                  if (unsure) { const ni = kept.length; kept.push(x); if (a) keptAnswers[ni] = a; }
                  else wiz.autoResolved.push({ subject: x.subject, answer: a });
                });
                wiz.questions = kept; wiz.answers = keptAnswers;
              }
              if (wiz.step === 0) drawQuestions();
            })
            .catch(() => { if (wiz.step === 0) drawQuestions(); });
        } else { drawQuestions(); }
      } else if (wiz.step === 1) {
        body.innerHTML = `<p class="muted small">Optional — who and where, so the AI can identify subjects.</p>
          <label class="dpk-flabel muted small">People in this batch</label>
          <input type="text" class="ai-input sw-people" value="${escapeAttr(wiz.people)}" placeholder="e.g. Liam, Josiah" />
          <label class="dpk-flabel muted small">Key locations</label>
          <input type="text" class="ai-input sw-loc" value="${escapeAttr(wiz.locations)}" placeholder="e.g. backyard, front-lawn" />`;
        body.querySelector('.sw-people').addEventListener('input', (e) => { wiz.people = e.target.value; });
        body.querySelector('.sw-loc').addEventListener('input', (e) => { wiz.locations = e.target.value; });
      } else if (wiz.step === 2) {
        const draw = () => {
          const body2 = wq('.sw-body');
          // Build a PREVIEW of the real resulting folder tree from the plan, so the
          // user sees exactly how it'll be organized before anything moves.
          const prev = {};
          for (const g of wiz.groups) for (const pl of placeGroupClips(g)) prev[pl.key] = pl.dest;
          for (const g of wiz.singles) prev[g.rep.key] = `${pickCategory(g.rep)}/_Unsorted`;
          const treeRoot = { children: new Map() };
          const ensure = (rel) => { let n = treeRoot; let cur = ''; for (const p of String(rel).split('/').filter(Boolean)) { cur = cur ? cur + '/' + p : p; if (!n.children.has(p)) n.children.set(p, { name: p, rel: cur, children: new Map(), n: 0 }); n = n.children.get(p); } return n; };
          for (const k of Object.keys(prev)) ensure(prev[k]).n += 1;
          const total = (node) => { let s = node.n || 0; for (const ch of node.children.values()) s += total(ch); return s; };
          const folderSet = new Set(folderPaths);
          const nNew = (() => { let c = 0; const walk = (nd) => { for (const ch of nd.children.values()) { if (!folderSet.has(ch.rel)) c += 1; walk(ch); } }; walk(treeRoot); return c; })();
          body2.innerHTML = `<p class="muted small">Here's exactly how your ${targets.length} clips will be organized — ${nNew} new folder${nNew !== 1 ? 's' : ''} will be created.${wiz.singles.length ? ` ${wiz.singles.length} loose → _Unsorted.` : ''}</p>
            <div class="sw-tree"></div>
            ${wiz.groups.length ? '<div class="sw-edit-h muted small">Wrong? Fix a destination:</div><div class="sw-groups"></div>' : ''}`;
          const treeHost = body2.querySelector('.sw-tree');
          const renderNode = (node, depth) => {
            const kids = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
            for (const ch of kids) {
              const isNew = !folderSet.has(ch.rel);
              const dated = /^\d{4}-\d{2}-\d{2}$/.test(ch.name);
              const row = document.createElement('div'); row.className = `sw-trow dmap-cat-${categoryKey(ch.rel)}`; row.style.paddingLeft = `${depth * 14}px`;
              row.innerHTML = `<span class="dmap-ficon keep-emoji">${dmapFolderIcon(dated, depth)}</span><span class="sw-tname">${escapeHtml(ch.name)}</span>${isNew ? '<span class="dmap-badge new">new</span>' : ''}<span class="sw-tn">${total(ch)}</span>`;
              treeHost.appendChild(row);
              renderNode(ch, depth + 1);
            }
          };
          renderNode(treeRoot, 0);
          if (wiz.groups.length) {
            const host = body2.querySelector('.sw-groups');
            wiz.groups.forEach((g) => {
              const row = document.createElement('div'); row.className = 'sw-grow';
              row.innerHTML = `<div class="sw-gh"><span class="dmap-cat-${categoryKey(g.dest)} sw-gdot"><span class="dmap-dot"></span></span><b>${escapeHtml(g.key)}</b> <span class="muted small">${g.clips.length} clip${g.clips.length !== 1 ? 's' : ''}</span></div>
                <input type="text" class="ai-input sw-gdest" value="${escapeAttr(g.dest)}" />`;
              const inp = row.querySelector('.sw-gdest');
              inp.addEventListener('input', (e) => { g.dest = e.target.value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim(); });
              inp.addEventListener('change', () => draw());   // refresh the tree once they finish editing
              host.appendChild(row);
            });
          }
        };
        body.innerHTML = '<div class="sw-think"><span class="illo sw-think-illo">${ILLO_THINKING}</span><span>AI is planning where everything goes…</span></div>';
        ensureGroups().then(draw);
      } else {
        const byCat = {};
        for (const g of wiz.groups || []) { const k = categoryKey(g.dest); byCat[k] = (byCat[k] || 0) + g.clips.length; }
        if (wiz.singles.length) byCat.unsorted = (byCat.unsorted || 0) + wiz.singles.length;
        const label = { client: 'Client Work', personal: 'Personal', social: 'Social Media', other: 'Other', unsorted: '_Unsorted (loose)' };
        const rows = Object.entries(byCat).map(([k, n]) => `<div class="sw-sum-row"><span class="dmap-cat-${k === 'unsorted' ? 'other' : k} sw-gdot"><span class="dmap-dot"></span></span>${escapeHtml(label[k] || k)}<span class="sw-sum-n">${n}</span></div>`).join('');
        body.innerHTML = `<p class="muted small">Here's where everything lands. New folders are proposed, not created until you hit Apply.</p>
          <div class="sw-summary">${rows || '<span class="muted small">Nothing to place.</span>'}</div>
          <p class="muted small" style="margin-top:10px">Run files them into the map (you still confirm with “Apply — file clips”).</p>`;
      }
    }
    wq('.sw-back').addEventListener('click', () => { if (wiz.step > 0) { wiz.step -= 1; renderStep(); } });
    wq('.sw-next').addEventListener('click', async () => {
      if (wiz.step < 3) { wiz.step += 1; renderStep(); return; }
      closeW();
      await applyGroupsAnimated(wiz.groups || [], wiz.singles || []);
    });
    renderStep();
  }

  // "Sort with me" — a guided, ONE-subject-at-a-time chat: watch a real clip, say where
  // it goes (tap a folder or type one), and it FILES that whole subject AND remembers a
  // rule so the same footage auto-routes next time. The cure for "the AI is just guessing".
  async function openSortChat() {
    const canon = (s) => String(s).replace(/[^a-z0-9]/gi, '').toLowerCase();
    const gmap = new Map();
    for (const c of clips) { const lab = clipLabel(c) || c.subject || c.location || 'misc'; const k = canon(lab) || 'misc'; if (!gmap.has(k)) gmap.set(k, { label: lab, clips: [] }); gmap.get(k).clips.push(c); }
    const groups = [...gmap.values()].sort((a, b) => b.clips.length - a.clips.length);
    if (!groups.length) { showToast('No clips to sort'); return; }
    // Destination options: existing project folders + the category roots.
    const looksLikeClip = (n) => /^\d{4}-\d{2}-\d{2}[_-]/.test(n) || /_v\d+$/i.test(n);
    const seenP = new Set(); const projOpts = [];
    for (const fp of folderPaths) { const parts = fp.split('/'); if (parts.length >= 3 && /^\d{4}$/.test(parts[0]) && !looksLikeClip(parts[2])) { const pth = parts.slice(0, 3).join('/'); if (!seenP.has(pth)) { seenP.add(pth); projOpts.push(pth); } } }
    const allPaths = [...new Set([...projOpts, ...treeCategories()])];
    let idx = 0; let filed = 0; let learned = 0;
    const ov = document.createElement('div'); ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal-card sortchat-card"><div class="sc2-hd"><span class="sc2-step muted small"></span><button type="button" class="btn ghost sc2-close">Done</button></div><div class="sc2-body"></div></div>`;
    document.body.appendChild(ov);
    const cq = (s) => ov.querySelector(s);
    const close = () => { ov.remove(); recomputeAuto(); renderTree(); if (filed) showToast(`Filed ${filed} group${filed !== 1 ? 's' : ''}${learned ? ` · learned ${learned} rule${learned !== 1 ? 's' : ''}` : ''} ✓`, 5000); };
    cq('.sc2-close').addEventListener('click', close);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    async function fileGroup(g, dest, remember) {
      dest = String(dest || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
      if (!dest) return;
      for (const pc of placeGroupClips({ dest: projectBase(dest), clips: g.clips })) { placement[pc.key] = pc.dest; autoKeys.delete(pc.key); recentlyPlaced.add(pc.key); }
      filed += 1;
      if (remember) {
        const kw = [...new Set(String(g.label).toLowerCase().split(/[\s\-_]+/).filter((w) => w.length > 2))];
        if (kw.length) {
          const existing = routesCache.find((r) => r.kind !== 'descriptor' && (r.match || []).some((m) => kw.includes(String(m).toLowerCase())));
          if (existing) existing.dest = projectBase(dest);
          else { routesCache.push({ name: g.label, kind: 'route', match: kw, dest: projectBase(dest), byDay: false }); learned += 1; }
          try { routesCache = (await window.api.saveRoutes(routesCache)) || routesCache; } catch { /* non-fatal */ }
        }
      }
    }
    async function show() {
      if (idx >= groups.length) { close(); return; }
      const g = groups[idx]; const rep = g.clips[0];
      cq('.sc2-step').textContent = `Clip group ${idx + 1} of ${groups.length}`;
      const body = cq('.sc2-body');
      let url = ''; try { url = await window.api.mediaUrl(rep.sourcePath); } catch { url = ''; }
      const chips = allPaths.map((p) => `<button type="button" class="sc2-chip dmap-cat-${categoryKey(p)}" data-dest="${escapeAttr(p)}"><span class="dmap-dot"></span>${escapeHtml(p.split('/').pop())}</button>`).join('');
      body.innerHTML = `
        <div class="sc2-vid">${url ? `<video src="${url}" controls autoplay muted loop playsinline></video>` : '<div class="sc2-novid">no preview</div>'}</div>
        <div class="sc2-subj">${escapeHtml(String(g.label).replace(/[-_]+/g, ' '))}</div>
        <div class="muted small sc2-sub">${g.clips.length} clip${g.clips.length !== 1 ? 's' : ''}${rep.description ? ` · ${escapeHtml(String(rep.description).replace(/[-_]+/g, ' '))}` : ''}</div>
        <div class="sc2-q">Where should this go?</div>
        <div class="sc2-chips">${chips}</div>
        <datalist id="sc2-opts">${allPaths.map((p) => `<option value="${escapeAttr(p)}"></option>`).join('')}</datalist>
        <input type="text" class="ai-input sc2-input" list="sc2-opts" placeholder="…or type a folder (new or existing), e.g. 2026/2026 - Personal/Kakwa Trip" />
        <label class="sc2-remember"><input type="checkbox" class="sc2-rem" checked /> <span>Remember this — auto-file “${escapeHtml(String(g.label).replace(/[-_]+/g, ' '))}” next time</span></label>
        <div class="sc2-actions"><button type="button" class="btn sc2-back" ${idx === 0 ? 'disabled' : ''}>Back</button><button type="button" class="btn sc2-skip">Skip</button><button type="button" class="btn primary sc2-file" disabled>File here →</button></div>`;
      const inp = body.querySelector('.sc2-input'); const fileBtn = body.querySelector('.sc2-file');
      const sync = (d) => { body.querySelectorAll('.sc2-chip').forEach((b) => b.classList.toggle('on', b.dataset.dest === d.trim())); fileBtn.disabled = !d.trim(); };
      const doFile = async () => { await fileGroup(g, inp.value, body.querySelector('.sc2-rem').checked); idx += 1; show(); };
      body.querySelectorAll('.sc2-chip').forEach((b) => b.addEventListener('click', () => { inp.value = b.dataset.dest; sync(inp.value); }));
      inp.addEventListener('input', () => sync(inp.value));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.value.trim()) { e.preventDefault(); doFile(); } });
      fileBtn.addEventListener('click', doFile);
      body.querySelector('.sc2-skip').addEventListener('click', () => { idx += 1; show(); });
      body.querySelector('.sc2-back').addEventListener('click', () => { if (idx > 0) { idx -= 1; show(); } });
    }
    show();
  }

  // Primary action: analyze anything unseen (so the AI isn't guessing from a bare
  // label), then run the placement pass inline — no separate wizard to wade through.
  async function aiPlanFlow() {
    if (!aiReady()) { showToast('Turn on AI in settings to auto-plan placement'); return; }
    const targets = clips.filter((c) => autoKeys.has(c.key));
    const g = await ensureAnalyzedFirst(targets.length ? targets : clips);
    if (g === 'cancel' || g === 'analyze') return;   // the analyze path re-plans itself
    await runAiPlan('');
  }
  q('.dmap-ai').addEventListener('click', aiPlanFlow);
  { const sm = q('.dmap-sortme'); if (sm) sm.addEventListener('click', openSortChat); }
  if (editable) {
    q('.dmap-apply').addEventListener('click', async () => {
      if (!root) { showToast('Set a Projects folder first'); return; }
      const embed = typeof opts.embedMeta === 'function' ? !!opts.embedMeta() : false;
      const rootClean = root.replace(/[\\/]+$/, '');
      const moves = clips.map((c) => {
        const rel = placement[c.key] || 'misc';
        return { from: c.sourcePath, toDir: `${rootClean}/${rel}`, rel, name: c.name, meta: (embed && c._ref && c._ref.meta) ? c._ref.meta : null };
      });
      const btn = q('.dmap-apply'); btn.disabled = true; btn.textContent = embed ? 'Embedding & filing…' : 'Filing…';
      aiActivity(embed ? 'Embedding metadata and filing clips…' : 'Filing clips…', '');
      const r = await window.api.projectsMove({ moves, embed });
      const okN = (r.results || []).filter((x) => x.ok).length;
      const failN = (r.results || []).length - okN;
      // Remember every filed clip in the project ledger (powers same-shoot detection
      // + the per-project AI summary), then refresh summaries for touched projects.
      try { recordToLedger(clips, placement, r.results || []); } catch (e) { /* non-fatal */ }
      aiActivityDone(`Filed ${okN}${failN ? `, ${failN} failed` : ''} into your Projects tree ✓`);
      showToast(`Filed ${okN}${failN ? `, ${failN} failed` : ''} ✓`, failN ? 6000 : 3500);
      btn.disabled = false; btn.textContent = 'Apply — file clips';
      if (typeof opts.onApplied === 'function') opts.onApplied(r);
      else close();
    });
  }
  loadTree();
}

// PROJECTS INDEX — browse every project footage has been filed into, each with its
// AI summary; search by name, people, places, keywords or what's in the footage.
async function showProjectsIndex() {
  let list = [];
  try { list = await window.api.ledgerGet(); } catch { list = []; }
  let root = '';
  try { root = await window.api.getProjectsRoot(); } catch { root = ''; }
  const fmtSpan = (m) => { const ds = (m.dates || []).filter(Boolean).slice().sort(); return ds.length ? (ds[0] === ds[ds.length - 1] ? ds[0] : `${ds[0]} – ${ds[ds.length - 1]}`) : ''; };
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card modal-form pidx" style="width:min(680px,94vw);max-height:86vh;display:flex;flex-direction:column">
    <div class="ai-hd"><span class="ai-hd-icon keep-emoji">🗂️</span><div class="ai-hd-text"><h3>Projects index</h3><p class="muted small">Every project your footage has been filed into, with an AI summary. Search names, people, places or what's in them.</p></div></div>
    <input type="text" class="ai-input pidx-search" placeholder="Search projects…" autocomplete="off" />
    <div class="pidx-list"></div>
    <div class="modal-actions"><button type="button" class="btn pidx-close">Close</button></div>
  </div>`;
  document.body.appendChild(ov);
  const listEl = ov.querySelector('.pidx-list');
  const searchEl = ov.querySelector('.pidx-search');
  const draw = () => {
    const ql = (searchEl.value || '').trim().toLowerCase();
    const items = list.filter((m) => {
      if (!ql) return true;
      const hay = [m.name, m.category, m.summary, ...(m.keywords || []), ...(m.subjects || []), ...(m.people || []), ...(m.locations || [])].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(ql);
    });
    if (!items.length) {
      listEl.innerHTML = list.length
        ? `<div class="pidx-empty muted small">No projects match that search.</div>`
        : `<div class="pidx-empty"><div class="illo mob-illo">${ILLO_PROJECTS}</div><div class="muted small" style="max-width:340px;margin:0 auto">No projects filed yet. Organize some footage and each project shows up here with a searchable AI summary.</div></div>`;
      return;
    }
    listEl.innerHTML = '';
    for (const m of items) {
      const card = document.createElement('div'); card.className = 'pidx-card';
      card.innerHTML = `<div class="pidx-top"><b class="pidx-name">${escapeHtml(m.name)}</b><span class="muted small pidx-meta">${escapeHtml(m.category || '')}${fmtSpan(m) ? ` · ${escapeHtml(fmtSpan(m))}` : ''} · ${m.clips} clip${m.clips !== 1 ? 's' : ''}</span></div>
        <div class="pidx-sum${m.summary ? '' : ' muted small'}">${m.summary ? escapeHtml(m.summary) : 'No summary yet.'}</div>
        ${(m.keywords && m.keywords.length) ? `<div class="pidx-kw">${m.keywords.map((k) => `<span class="pidx-tag">${escapeHtml(k)}</span>`).join('')}</div>` : ''}
        <div class="pidx-acts"><button type="button" class="btn subtle pidx-open">Open folder</button><button type="button" class="btn subtle pidx-refresh">${m.summary ? 'Refresh' : 'Generate'} summary</button></div>`;
      card.querySelector('.pidx-open').addEventListener('click', () => { if (root) window.api.openFolder(`${root.replace(/[\\/]+$/, '')}/${m.rel}`); else showToast('Set a Projects folder first'); });
      const rb = card.querySelector('.pidx-refresh');
      rb.addEventListener('click', async () => {
        if (!aiReady()) { showToast('Turn on AI to generate summaries'); return; }
        rb.disabled = true; rb.textContent = 'Summarizing…';
        try { const s = await window.api.ledgerSummarize(m.rel); if (s && s.ok) { m.summary = s.summary; m.keywords = s.keywords || m.keywords; draw(); } else { showToast(s && s.error ? s.error : 'Could not summarize'); rb.disabled = false; rb.textContent = 'Generate summary'; } }
        catch { showToast('Could not summarize'); rb.disabled = false; rb.textContent = 'Generate summary'; }
      });
      listEl.appendChild(card);
    }
  };
  searchEl.addEventListener('input', draw);
  draw();
  const close = () => ov.remove();
  ov.querySelector('.pidx-close').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  setTimeout(() => searchEl.focus(), 30);
}

// Open the map for the right stage: Organize screen → real compressed files
// (editable + apply); otherwise the named clips on the rename screen (preview).
function showDestinationMapAuto() {
  const finEl = document.getElementById('finalize');
  const onOrganize = finEl && !finEl.classList.contains('hidden') && finScan && finScan.files && finScan.files.length;
  if (onOrganize) {
    const sel = (finSelected().length ? finSelected() : finMatched());
    if (!sel.length) { showToast('No matched clips to map'); return; }
    showDestinationMap(sel.map((f) => ({ name: f.name, sourcePath: f.sourcePath, subject: f.meta && f.meta.subject, description: f.meta && f.meta.description, location: f.meta && f.meta.location, date: f.meta && f.meta.date, people: (f.meta && f.meta.people) || [], shotType: f.meta && f.meta.shotType, tags: (f.meta && f.meta.tags) || [], _ref: f })), {
      editable: true,
      // Edits made in the map stick to the compressed file's stored metadata so
      // the next Organize/Finalize embeds the corrected subject/location.
      onEditMeta: (f, patch) => {
        f.meta = f.meta || {};
        if (patch.subject != null) f.meta.subject = patch.subject;
        if (patch.location != null) f.meta.location = patch.location;
        try { window.api.saveFinalMeta({ [f.name]: { ...f.meta } }); } catch { /* non-fatal */ }
      }
    });
    return;
  }
  const named = state.scannedFiles.filter((c) => c.subject || c.description);
  if (!named.length) { showToast('Name some clips first to preview where they go'); return; }
  showDestinationMap(named.map((c) => ({ name: finalName(c), sourcePath: c.sourcePath, subject: c.subject, description: c.description, location: c.location, date: c.date, _ref: c })), {
    editable: false,
    // Edits write straight back to the clip on the rename grid + persist as a draft.
    onEditMeta: (clip, patch) => {
      if (patch.subject != null) clip.subject = patch.subject;
      if (patch.location != null) clip.location = patch.location;
      const i = state.scannedFiles.indexOf(clip);
      if (i >= 0) syncRowInputs([i]);
      refreshNames();
      scheduleDraftSave();
    }
  });
}

// Filing-rules editor (Edit → "Filing rules…" or the map's "Filing rules…"). Each
// rule routes a subject's clips to a folder, optionally one subfolder per day. You
// can add them structured OR describe one in plain English for the AI to set up.
async function showRoutingRules(folderPaths, onChange, clipsForExamples, pendingRules) {
  if (!folderPaths) {
    try {
      const r = await window.api.getProjectsTree();
      const fl = []; if (r && r.ok) (function walk(ns, b) { for (const n of ns) { const rel = (b ? b + '/' : '') + n.name; fl.push(rel); walk(n.children, rel); } })(r.tree, '');
      folderPaths = fl;
    } catch { folderPaths = []; }
  }
  if (!Array.isArray(clipsForExamples)) clipsForExamples = (state.scannedFiles || []).map((c) => ({ name: c.name, subject: c.subject, location: c.location, description: c.description, date: c.date }));
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card modal-form rules-card">
    <div class="ai-hd"><span class="ai-hd-icon">📂</span><div class="ai-hd-text"><h3>Filing rules</h3><p class="muted small">Where footage goes. A rule either sends a subject to a folder, OR marks a word as a <b>descriptor</b> (vlog, timelapse…) that should NOT become its own folder. Describe one in plain English and the AI proposes rules for you to confirm.</p></div></div>
    <ul class="rules-list"></ul>
    <button type="button" class="btn primary rules-add">+ Add rule</button>
    <div class="modal-actions"><button type="button" class="btn rules-done">Done</button></div>
  </div>`;
  document.body.appendChild(ov);
  const q = (s) => ov.querySelector(s);
  const close = () => { ov.remove(); if (onChange) onChange(); };
  q('.rules-done').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  const persist = async () => { try { routesCache = (await window.api.saveRoutes(routesCache)) || routesCache; } catch { /* ignore */ } };

  // Plain-language summary of a rule (also used in the verify wizard).
  const ruleSummary = (r) => {
    if (r.kind === 'descriptor') {
      return r.joinProject
        ? `Descriptor — file each clip into the project it was shot with (its day's footage), not its own folder.`
        : `Descriptor — each shooting day becomes its own separate project (not one big folder).`;
    }
    return `→ ${r.dest}${r.byDay ? '  ·  new folder per day' : ''}`;
  };
  const matchExamples = (rule) => {
    const ks = (rule.match || []).map((s) => s.toLowerCase());
    return clipsForExamples.filter((c) => { const h = `${c.subject || ''} ${c.location || ''} ${c.description || ''}`.toLowerCase(); return ks.some((k) => k && h.includes(k)); });
  };

  function render() {
    const list = q('.rules-list');
    if (!routesCache.length) { list.innerHTML = `<li class="dlg-empty"><span class="illo">${ILLO_FILES}</span><p class="dlg-empty-tx">No filing rules yet</p><p class="muted small">Add one — e.g. “skating → Social Media/Skate Project, new folder each day”, or “vlog is just a label, not its own project”.</p></li>`; return; }
    list.innerHTML = '';
    routesCache.forEach((r, idx) => {
      const li = document.createElement('li'); li.className = 'rules-item';
      const badge = r.kind === 'descriptor' ? '<span class="vh-badge desc">descriptor</span>' : (r.byDay ? '<span class="vh-badge auto">by day</span>' : '');
      li.innerHTML = `<div class="rules-meta"><div class="rules-name">${escapeHtml(r.name || (r.match || []).join(', '))} ${badge}</div><div class="rules-sub muted small">[${escapeHtml((r.match || []).join(', '))}] ${escapeHtml(ruleSummary(r))}</div></div><div class="rules-btns"><button type="button" class="btn subtle rules-edit">Edit</button><button type="button" class="btn ghost rules-del" title="Delete">✕</button></div>`;
      li.querySelector('.rules-edit').addEventListener('click', () => editRule(idx));
      li.querySelector('.rules-del').addEventListener('click', async () => { routesCache.splice(idx, 1); await persist(); render(); });
      list.appendChild(li);
    });
  }
  q('.rules-add').addEventListener('click', () => editRule(-1));

  // Verify wizard — walk the AI's proposed rules one at a time, showing real
  // example clips it would affect, and confirm each before saving.
  // A rule, phrased as a learned preference for the AI's memory (so memory visibly grows).
  const ruleMemoryText = (r) => {
    const m = (r.match || []).join(', ');
    if (r.kind === 'descriptor') return r.joinProject ? `"${m}" is a descriptor — file each clip with the project it was shot in, not its own folder.` : `"${m}" is a descriptor — each shooting day is its own separate project, not one big folder.`;
    return `File "${m}" footage into "${r.dest}"${r.byDay ? ', a new folder per day' : ''}.`;
  };
  function verifyRules(rules) {
    let i = 0; const accepted = [];
    const sv = document.createElement('div'); sv.className = 'modal-overlay'; document.body.appendChild(sv);
    const finish = async () => {
      sv.remove();
      if (accepted.length) {
        routesCache.push(...accepted); await persist();
        // Remember each rule as a learning so the AI's Memory grows and naming benefits.
        const notes = accepted.map(ruleMemoryText).filter(Boolean);
        if (notes.length) {
          try { await window.api.aiAddMemories(notes.map((t) => ({ text: t, example: '' }))); if (!Array.isArray(aiCfg.memories)) aiCfg.memories = []; for (const t of notes) aiCfg.memories.push({ text: t, example: '' }); } catch { /* non-fatal */ }
          showToast(`🧠 AI learned ${notes.length} new filing preference${notes.length !== 1 ? 's' : ''}`);
        }
      }
      render();
    };
    function show() {
      if (i >= rules.length) { finish(); return; }
      const r = rules[i];
      const ex = matchExamples(r);
      const exList = ex.slice(0, 6).map((c) => `<li>${escapeHtml(c.name)} <span class="muted small">(${escapeHtml(c.subject || c.location || '—')})</span></li>`).join('') || '<li class="muted small">No current clips match these keywords yet — the rule still applies to future footage.</li>';
      let preview = '';
      if (r.kind === 'descriptor' && !r.joinProject) { const dates = [...new Set(ex.map((c) => c.date).filter(Boolean))]; preview = dates.length ? `→ ${dates.length} separate day-project${dates.length !== 1 ? 's' : ''}: ${dates.slice(0, 4).join(', ')}${dates.length > 4 ? '…' : ''}` : '→ each shooting day gets its own project folder'; }
      else if (r.kind === 'descriptor') { preview = '→ each clip joins the project shot that day'; }
      else { preview = `→ ${r.dest}${r.byDay ? '/<date>' : ''}`; }
      const title = r.kind === 'descriptor' ? `“${(r.match || []).join(', ')}” is a descriptor` : `Send “${(r.match || []).join(', ')}” to a folder`;
      sv.innerHTML = `<div class="modal-card modal-form rule-verify">
        <div class="rv-step muted small">Rule ${i + 1} of ${rules.length}</div>
        <h3>${escapeHtml(title)}</h3>
        <p class="muted small">${escapeHtml(ruleSummary(r))}</p>
        <div class="rv-prev">${escapeHtml(preview)}</div>
        <div class="rv-ex-h muted small">Affects ${ex.length} of your current clip${ex.length !== 1 ? 's' : ''}${ex.length > 6 ? ' (showing 6)' : ''}:</div>
        <ul class="rv-ex">${exList}</ul>
        <div class="modal-actions">
          <button type="button" class="btn primary rv-add">Yes, add this rule</button>
          <button type="button" class="btn rv-edit">Edit…</button>
          <button type="button" class="btn rv-skip">Skip</button>
        </div></div>`;
      sv.querySelector('.rv-add').addEventListener('click', () => { accepted.push(r); i += 1; show(); });
      sv.querySelector('.rv-skip').addEventListener('click', () => { i += 1; show(); });
      sv.querySelector('.rv-edit').addEventListener('click', () => { sv.style.display = 'none'; editRule(-1, r, () => { i += 1; sv.style.display = ''; show(); }); });
    }
    show();
  }

  function editRule(idx, seed, after) {
    const r = idx >= 0 ? { ...routesCache[idx] } : (seed ? { ...seed } : { name: '', kind: 'route', match: [], dest: '', byDay: false });
    let kind = r.kind === 'descriptor' ? 'descriptor' : 'route';
    const p = document.createElement('div'); p.className = 'modal-overlay';
    p.innerHTML = `<div class="modal-card modal-form rule-edit">
      <h3>${idx >= 0 ? 'Edit rule' : 'New filing rule'}</h3>
      <label class="dpk-flabel muted small">Describe it in plain English (optional — AI proposes rules to confirm)</label>
      <div class="re-nl-row"><input type="text" class="ai-input re-nl" placeholder="e.g. vlog is just a label not its own project; timelapses go in the project they were taken in" /><button type="button" class="btn re-interpret">Interpret</button></div>
      <div class="re-kind">
        <button type="button" class="re-kindbtn ${kind === 'route' ? 'sel' : ''}" data-k="route">Files into a folder</button>
        <button type="button" class="re-kindbtn ${kind === 'descriptor' ? 'sel' : ''}" data-k="descriptor">Is a descriptor (vlog, timelapse…)</button>
      </div>
      <label class="dpk-flabel muted small">When the clip is about (keywords, comma-separated)</label>
      <input type="text" class="ai-input re-match" value="${escapeAttr((r.match || []).join(', '))}" placeholder="vlog, timelapse" />
      <div class="re-route">
        <label class="dpk-flabel muted small">File it into this folder</label>
        <input type="text" class="ai-input re-dest" value="${escapeAttr(r.dest || '')}" placeholder="2026/2026 - Social Media/My Project" />
        <div class="re-dest-list dpk-list"></div>
        <label class="an-remember"><input type="checkbox" class="re-byday" ${r.byDay ? 'checked' : ''}/> <span>New folder for each day (date subfolder)</span></label>
      </div>
      <div class="re-desc">
        <div class="an-mode-list">
          <button type="button" class="an-mode-opt re-join ${r.joinProject ? '' : 'sel'}" data-j="0"><span class="an-mode-dot"></span><span class="an-mode-tx"><b>Each day = its own project</b><span class="muted small">separate folders per shooting day (e.g. vlog)</span></span></button>
          <button type="button" class="an-mode-opt re-join ${r.joinProject ? 'sel' : ''}" data-j="1"><span class="an-mode-dot"></span><span class="an-mode-tx"><b>Joins the project it was shot with</b><span class="muted small">files with that day’s footage (e.g. timelapse)</span></span></button>
        </div>
      </div>
      <div class="modal-actions"><button type="button" class="btn primary re-save">Save rule</button><button type="button" class="btn re-cancel">Cancel</button></div>
    </div>`;
    document.body.appendChild(p);
    const pq = (s) => p.querySelector(s);
    const closeP = (saved) => { p.remove(); if (after) after(saved); };
    let joinProject = !!r.joinProject;
    const applyKind = () => {
      pq('.re-route').style.display = kind === 'route' ? '' : 'none';
      pq('.re-desc').style.display = kind === 'descriptor' ? '' : 'none';
      p.querySelectorAll('.re-kindbtn').forEach((b) => b.classList.toggle('sel', b.dataset.k === kind));
    };
    applyKind();
    p.querySelectorAll('.re-kindbtn').forEach((b) => b.addEventListener('click', () => { kind = b.dataset.k; applyKind(); }));
    p.querySelectorAll('.re-join').forEach((b) => b.addEventListener('click', () => { joinProject = b.dataset.j === '1'; p.querySelectorAll('.re-join').forEach((x) => x.classList.toggle('sel', x === b)); }));
    pq('.re-cancel').addEventListener('click', () => closeP(false));
    p.addEventListener('mousedown', (e) => { if (e.target === p) closeP(false); });
    const destInput = pq('.re-dest');
    const renderDest = () => {
      const f = destInput.value.trim().toLowerCase();
      const matches = folderPaths.filter((fp) => !f || fp.toLowerCase().includes(f)).slice(0, 30);
      pq('.re-dest-list').innerHTML = matches.map((fp) => `<button type="button" class="dpk-row" data-p="${escapeAttr(fp)}">${escapeHtml(fp)}</button>`).join('');
      pq('.re-dest-list').querySelectorAll('.dpk-row').forEach((b) => b.addEventListener('click', () => { destInput.value = b.dataset.p; pq('.re-dest-list').innerHTML = ''; }));
    };
    destInput.addEventListener('input', renderDest);
    pq('.re-interpret').addEventListener('click', async () => {
      const text = pq('.re-nl').value.trim(); if (!text) { showToast('Type a description first'); return; }
      if (!aiReady()) { showToast('Turn on AI first'); return; }
      const btn = pq('.re-interpret'); btn.disabled = true; btn.textContent = '…';
      const res = await window.api.aiParseRules({ text, folders: folderPaths });
      btn.disabled = false; btn.textContent = 'Interpret';
      if (res && res.ok && res.rules.length) { closeP(false); verifyRules(res.rules); }
      else showToast(res && res.error ? res.error : 'Could not interpret that');
    });
    pq('.re-save').addEventListener('click', async () => {
      const match = pq('.re-match').value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (!match.length) { showToast('Add at least one keyword'); return; }
      let rule;
      if (kind === 'descriptor') { rule = { name: r.name || match[0], kind: 'descriptor', match, joinProject, byDay: true }; }
      else {
        const dest = pq('.re-dest').value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
        if (!dest) { showToast('Pick a folder for this rule'); return; }
        rule = { name: r.name || match[0], kind: 'route', match, dest, byDay: pq('.re-byday').checked };
      }
      if (idx >= 0) routesCache[idx] = rule; else routesCache.push(rule);
      await persist(); p.remove(); render(); if (after) after(true);
    });
    setTimeout(() => pq('.re-nl').focus(), 30);
  }
  render();
  // Opened with rules to confirm (e.g. from the Suggest wizard's "save answers as
  // rules") — jump straight into the verify wizard.
  if (Array.isArray(pendingRules) && pendingRules.length) verifyRules(pendingRules);
}

// ---------------------------------------------------------------------------
// Face recognition (fully local, opt-in). Detection runs HERE via face-api.js
// (WebGL, no native modules); main persists/matches descriptors. Named people are
// auto-tagged onto clips → flow into XMP PersonInImage + keywords at Finalize.
// Degrades gracefully when the face-api library / weights aren't installed yet.
// ---------------------------------------------------------------------------
let _faceReady = null;
let faceScanAborted = false;
function faceDist(a, b) { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i += 1) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }
async function ensureFaceModels() {
  if (_faceReady) return _faceReady;
  _faceReady = (async () => {
    const fa = window.faceapi;
    // The library + the model weights are BUNDLED with the app (no manual setup) —
    // a failure here is the engine not starting, not missing files.
    if (window.__noFaceApi || !fa || !fa.nets) { _faceReady = null; return { ok: false, error: 'the face-recognition engine couldn’t start (the local library didn’t load).', kind: 'lib' }; }
    try {
      const url = 'face-models';   // bundled weights, served next to index.html
      await fa.nets.ssdMobilenetv1.loadFromUri(url);
      await fa.nets.faceLandmark68Net.loadFromUri(url);
      await fa.nets.faceRecognitionNet.loadFromUri(url);
      return { ok: true, fa };
    } catch (e) { _faceReady = null; logIssue('Face recognition', `models failed to load: ${(e && e.message) || 'unknown'}`); return { ok: false, error: `the models couldn’t load (${(e && e.message) ? String(e.message).slice(0, 120) : 'unknown'}).`, kind: 'load' }; }
  })();
  return _faceReady;
}
// Crop a face box out of an already-decoded HTMLImageElement. Uses the img directly
// (no re-decode) so it's synchronous and sharp. Output is 144×144 with 25% padding.
function cropFace(img, box) {
  try {
    const pad = Math.round(Math.max(box.width, box.height) * 0.25);
    const sx = Math.max(0, box.x - pad);
    const sy = Math.max(0, box.y - pad);
    const sw = Math.min(img.naturalWidth - sx, box.width + pad * 2);
    const sh = Math.min(img.naturalHeight - sy, box.height + pad * 2);
    const S = 144; const c = document.createElement('canvas'); c.width = S; c.height = S;
    c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, S, S);
    return c.toDataURL('image/jpeg', 0.9);
  } catch { return ''; }
}
async function detectFacesForClip(clip, onFrame) {
  const ready = await ensureFaceModels();
  if (!ready.ok) return { ready: false, error: ready.error, faces: [] };
  const fa = ready.fa;
  // faces:frames samples the WHOLE clip (1 frame every faceInterval seconds). We run
  // detection on each frame and merge faces that recur across frames (so one person
  // seen in many frames becomes ONE entry, keeping the biggest/clearest crop).
  const r = await window.api.facesFrames({ sourcePath: clip.sourcePath });
  const frames = (r && r.ok && Array.isArray(r.frames)) ? r.frames : [];
  if (!frames.length) return { ready: true, faces: [] };
  const collected = [];   // {descriptor, thumb, area}
  for (let fi = 0; fi < frames.length; fi += 1) {
    if (faceScanAborted) break;
    if (onFrame) onFrame(fi + 1, frames.length);
    const img = new Image(); img.src = frames[fi];
    // eslint-disable-next-line no-await-in-loop
    try { await img.decode(); } catch { continue; }
    let dets = [];
    // eslint-disable-next-line no-await-in-loop
    try { dets = await fa.detectAllFaces(img, new fa.SsdMobilenetv1Options({ minConfidence: 0.5 })).withFaceLandmarks().withFaceDescriptors(); } catch { dets = []; }
    for (const d of dets) {
      const box = d.detection.box; const area = box.width * box.height;
      // Skip faces that are too SMALL or low-confidence — their descriptors are noisy
      // and pollute a person's training set, which is what hurts recognition accuracy.
      const minSide = Math.max(64, img.naturalWidth * 0.055);
      if (box.width < minSide || box.height < minSide) continue;
      if ((d.detection.score || 0) < 0.55) continue;
      const desc = Array.from(d.descriptor);
      const existing = collected.find((c) => faceDist(c.descriptor, desc) < 0.45);
      if (existing) { if (area > existing.area) { existing.thumb = cropFace(img, box); existing.area = area; existing.descriptor = desc; } }
      else collected.push({ descriptor: desc, thumb: cropFace(img, box), area });
    }
  }
  return { ready: true, faces: collected.map((c) => ({ descriptor: c.descriptor, thumb: c.thumb })) };
}

// Detect faces in one clip and accumulate them into `clusters` (the shape
// showFaceReviewGrid expects). NOTHING is auto-tagged or auto-confirmed: a recognized
// face becomes a SUGGESTION (and is saved to that person's profile as UNCONFIRMED) so
// you confirm it yourself in Review faces / on the person's profile. Returns 0 (no
// faces are applied to clips until you confirm).
async function collectClipFaces(clip, clusters, keys) {
  const r = clip._ref || clip;
  // Which clips a confirmed face should tag. Normally just this clip; in Quick mode we
  // scan one clip per subject and pass the whole group's keys so confirming tags them all.
  const attach = (Array.isArray(keys) && keys.length) ? keys : [clip.key || clip.sourcePath];
  let fr = null;
  pushActivity(`Scanning ${clip.name} for faces…`, 'face');
  try { fr = await detectFacesForClip({ sourcePath: clip.sourcePath }, (fi, ft) => { if (fi === 1 || fi === ft) pushActivity(`Sampling frames (${fi}/${ft})`, 'frame'); }); } catch { return 0; }
  const nFaces = (fr && fr.faces || []).length;
  pushActivity(nFaces ? `Detected ${nFaces} face${nFaces !== 1 ? 's' : ''} in ${clip.name}` : `No faces in ${clip.name}`, 'face');
  for (const f of (fr && fr.faces) || []) {
    let m = null;
    try { m = await window.api.matchPerson({ descriptor: f.descriptor, threshold: FACE_SUGGEST_DIST }); } catch { /* offline ok */ }
    const dist = m && typeof m.dist === 'number' ? m.dist : Infinity;
    const matched = m && m.match && dist <= FACE_SUGGEST_DIST;
    // Cluster the face (recognized or not) for the Review grid — never auto-apply.
    let c = clusters.find((u) => faceDist(u.descriptor, f.descriptor) < 0.5);
    if (!c) {
      c = { thumb: f.thumb, descriptor: f.descriptor, descriptors: [], clipKeys: new Set(), suggest: null };
      clusters.push(c);
      pushActivity(matched ? `Looks like ${m.match.name} — needs your confirmation` : 'New face — will ask you to name it', 'face', f.thumb);
    }
    c.descriptors.push(f.descriptor); for (const k of attach) c.clipKeys.add(k);
    if (matched) {
      if (!c.suggest || dist < c.suggest.dist) c.suggest = { id: m.match.id, name: m.match.name, dist };
      notePerson(m.match.name, f.thumb);
      // Surface it on the person's profile as UNCONFIRMED so it shows up there for review.
      try { await window.api.savePerson({ name: m.match.name, descriptors: [f.descriptor], thumb: f.thumb, confirmed: false }); } catch { /* non-fatal */ }
    }
  }
  r._facesScanned = true;
  return 0;
}

// Reusable "scanning" animation — a framing-bracket icon with a sweeping accent
// line. Used in the face grid header and the live task panel to feel premium while
// work runs. currentColor for the brackets; the line uses the accent.
const SCAN_ANIM = `<svg class="scan-anim" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M4 8.5V5.5A1.5 1.5 0 0 1 5.5 4H8.5"/><path d="M20 8.5V5.5A1.5 1.5 0 0 0 18.5 4H15.5"/>
  <path d="M4 15.5V18.5A1.5 1.5 0 0 0 5.5 20H8.5"/><path d="M20 15.5V18.5A1.5 1.5 0 0 1 18.5 20H15.5"/>
  <line x1="6.5" x2="17.5" y1="12" y2="12" stroke="var(--accent)" stroke-width="1.8" opacity="0.9">
    <animate attributeName="y1" values="7;17;7" dur="1.9s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.2 1;0.4 0 0.2 1" keyTimes="0;0.5;1"/>
    <animate attributeName="y2" values="7;17;7" dur="1.9s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.2 1;0.4 0 0.2 1" keyTimes="0;0.5;1"/>
  </line>
</svg>`;

// Purpose-built animated file-explorer icons (white outline, inherit currentColor).
// FOLDER: a document rises out of the folder and tucks back in (a live "filing"
// motion). DATE: a calendar with a pulsing "today" cell. BOX: an archive box whose
// lid gently lifts. Used for the destination-map tree rows so the file explorer feels
// alive while you organise. SMIL animation = no JS, GPU-cheap even with many rows.
const IC_FOLDER = `<svg class="anim-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
  <g>
    <rect x="9" y="8" width="6" height="7.5" rx="1"/><line x1="10.6" y1="10.4" x2="13.4" y2="10.4"/><line x1="10.6" y1="12.4" x2="13.4" y2="12.4"/>
    <animateTransform attributeName="transform" type="translate" values="0 4.5;0 -3.5;0 4.5" dur="2.7s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.2 1;0.45 0 0.2 1" keyTimes="0;0.5;1"/>
    <animate attributeName="opacity" values="0;1;1;0" dur="2.7s" repeatCount="indefinite" keyTimes="0;0.22;0.78;1"/>
  </g>
  <path d="M3 7.6a1 1 0 0 1 1-1h4.5a1 1 0 0 1 .8.4l1.1 1.5a1 1 0 0 0 .8.4H20a1 1 0 0 1 1 1v7.7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/>
</svg>`;
const IC_DATE = `<svg class="anim-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
  <rect x="3.5" y="5" width="17" height="15" rx="2"/><line x1="3.5" y1="9.2" x2="20.5" y2="9.2"/><line x1="8" y1="3.4" x2="8" y2="6.4"/><line x1="16" y1="3.4" x2="16" y2="6.4"/>
  <rect x="10.4" y="12" width="3.2" height="3.2" rx="0.6" fill="currentColor" stroke="none">
    <animate attributeName="opacity" values="0.2;1;0.2" dur="1.8s" repeatCount="indefinite" calcMode="ease-in-out"/>
  </rect>
</svg>`;
const IC_BOX = `<svg class="anim-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
  <path d="M4.5 9.5h15v8a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1Z"/><line x1="10" y1="13" x2="14" y2="13"/>
  <path d="M3 6.5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v3H3Z">
    <animateTransform attributeName="transform" type="translate" values="0 0;0 -1.8;0 0" dur="2.8s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.2 1;0.4 0 0.2 1" keyTimes="0;0.5;1"/>
  </path>
</svg>`;
// Native COLOURFUL emoji for the file-explorer tree (user wants the yellow folders).
// Wrapped in .keep-emoji so the white-outline replacer leaves them as real emoji.
function dmapFolderIcon(dated, depth) { return dated ? '📅' : (depth === 0 ? '🗂️' : '📁'); }

// Scan selected clips: detect faces, AUTO-tag confident matches, and cluster the
// rest into SUGGESTED (tentative match to a known person) + NEW (unknown) groups
// for the digiKam-style confirm grid. Confirming there grows each person so
// recognition gets better the more you review (learns as it grows).
const FACE_CONFIRM_DIST = 0.46;   // <= this: auto-tag, very confident
const FACE_SUGGEST_DIST = 0.60;   // <= this: suggest the person, ask to confirm
async function scanFacesForClips(clipList, opts = {}) {
  if (!clipList || !clipList.length) { showToast('Select some clips first'); return; }
  // Skip clips already scanned in a previous (or interrupted) run — face scanning is
  // slow and the result is remembered, so never redo a clip unless explicitly forced.
  const toScan = opts.force ? clipList : clipList.filter((c) => !c._facesScanned);
  const skipped = clipList.length - toScan.length;
  if (!toScan.length) {
    showToast(`Already scanned ${clipList.length === 1 ? 'this clip' : `all ${clipList.length} clips`} — nothing new (faces are remembered).`, 4000);
    return;
  }
  const probe = await ensureFaceModels();
  if (!probe.ok) { showFaceSetup(probe.error); return; }
  faceScanAborted = false;
  aiFollow = true; aiAborted = false; showFollowBtn(false);
  clearActivity();
  const clusters = [];   // {thumb, descriptor, descriptors:[], clipKeys:Set, suggest}
  let done = 0;
  for (const clip of toScan) {
    if (faceScanAborted) break;
    const ci = state.scannedFiles.indexOf(clip);   // the live scan overlay on the card
    setTask('faces', 'Face scan', done + 1, toScan.length, 'scanning', clip.name);
    markClipAnalyzing(ci, 'face scan');
    pushActivity(`Scanning ${clip.name} for faces…`, 'face');
    // eslint-disable-next-line no-await-in-loop
    const res = await detectFacesForClip(clip, (fi, ft) => { setTask('faces', 'Face scan', done + 1, toScan.length, `frame ${fi}/${ft}`, clip.name); if (fi === 1 || fi === ft) pushActivity(`Sampling frames (${fi}/${ft})`, 'frame'); });
    markClipAnalyzing(ci, false);
    pushActivity(res.faces.length ? `Detected ${res.faces.length} face${res.faces.length !== 1 ? 's' : ''}` : 'No faces found', 'face');
    // Remember this clip was scanned (even if nothing matched) so we never re-nag,
    // and PERSIST it now so a mid-stream cutoff still remembers what's done.
    clip._facesScanned = true; if (clip._ref) clip._ref._facesScanned = true;
    const byKeyClip = state.scannedFiles.find((c) => clipKey(c) === clipKey(clip)); if (byKeyClip) byKeyClip._facesScanned = true;
    flushDraftSave();   // persist scanned-flag immediately — a mid-stream cutoff is remembered
    for (const f of res.faces) {
      // eslint-disable-next-line no-await-in-loop
      const m = await window.api.matchPerson({ descriptor: f.descriptor, threshold: FACE_SUGGEST_DIST });
      const dist = m && typeof m.dist === 'number' ? m.dist : Infinity;
      const matched = m && m.match && dist <= FACE_SUGGEST_DIST;
      // NEVER auto-tag or auto-confirm. Recognized faces become SUGGESTIONS you confirm
      // in the Review grid, and are saved to the person's profile as UNCONFIRMED.
      let c = clusters.find((u) => faceDist(u.descriptor, f.descriptor) < 0.5);
      if (!c) { c = { thumb: f.thumb, descriptor: f.descriptor, descriptors: [], clipKeys: new Set(), suggest: null }; clusters.push(c); pushActivity(matched ? `Looks like ${m.match.name} — needs your confirmation` : 'New face — will ask you to name it', 'face', f.thumb); }
      c.descriptors.push(f.descriptor); c.clipKeys.add(clip.key || clip.sourcePath);
      if (matched) {
        if (!c.suggest || dist < c.suggest.dist) c.suggest = { id: m.match.id, name: m.match.name, dist };
        notePerson(m.match.name, f.thumb);
        // eslint-disable-next-line no-await-in-loop
        await window.api.savePerson({ name: m.match.name, descriptors: [f.descriptor], thumb: f.thumb, confirmed: false });
      }
    }
    done += 1;
  }
  clearAllAnalyzing(); clearTask('faces');
  scheduleDraftSave();   // make sure the last clips' scanned-flags persist
  if (faceScanAborted) { showToast(`Face scan stopped — ${done} scanned so far are remembered (resume to do the rest).`, 4500); }
  const toReview = clusters.length;
  if (!faceScanAborted) pcNotify('Face scan complete', `${toReview} face${toReview !== 1 ? 's' : ''} to review & confirm${skipped ? ` · skipped ${skipped} already-scanned` : ''}.`);
  if (clusters.length) await showFaceReviewGrid(clusters, toScan, 0);   // await so Analyze can name AFTER you confirm
  else if (!faceScanAborted) showToast(`No new faces found${skipped ? ` (skipped ${skipped} already scanned)` : ''}`);
}

// digiKam-style face confirm GRID. Three sections: SUGGESTED (tentative match —
// dashed accent border + "Is this <name>?"), NEW (unknown — "Who is this?" with
// tap-chips for existing people), and CONFIRMED (solid green border). Confirming or
// naming applies immediately AND grows that person's descriptors (learns as it grows).
async function showFaceReviewGrid(clusters, clipList, autoCount) {
  let people = [];
  try { people = await window.api.getPeople(); } catch { people = []; }
  return new Promise((resolveGrid) => {
  const names = people.map((p) => p.name);
  const byKey = {}; for (const c of clipList) byKey[c.key || c.sourcePath] = c;
  clusters.forEach((c, i) => { c._i = i; });
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card face-grid-card">
    <div class="ai-hd"><span class="ai-hd-icon fg-hd-anim">${SCAN_ANIM}</span><div class="ai-hd-text"><h3>Review faces</h3><p class="muted small">Confirm or correct who these are — type a name or tap a suggestion. Each one teaches the app for next time.</p></div></div>
    <div class="face-grid-scroll"></div>
    <div class="modal-actions"><button type="button" class="btn primary fg-confirm-all">Confirm all suggestions</button><button type="button" class="btn fg-done">Done</button></div>
  </div>`;
  document.body.appendChild(ov);
  const scroll = ov.querySelector('.face-grid-scroll');
  const close = () => { ov.remove(); refreshNames && refreshNames(); refreshAllClipPeople(); resolveGrid(); };
  ov.querySelector('.fg-done').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });

  function tagClips(cl, name) {
    for (const k of cl.clipKeys) { const c = byKey[k]; if (c) c.people = [...new Set([...(c.people || []), name])]; }
  }
  function untagClips(cl, name) {
    for (const k of cl.clipKeys) { const c = byKey[k]; if (c && Array.isArray(c.people)) c.people = c.people.filter((n) => n !== name); }
  }
  async function assign(cl, name) {
    name = String(name || '').trim();
    if (!name) return;
    await window.api.savePerson({ name, descriptors: cl.descriptors, thumb: cl.thumb });
    tagClips(cl, name);
    rememberSubject && rememberSubject(name);
    cl.done = true; cl.assignedName = name;
    if (!names.includes(name)) names.push(name);
    render();
  }
  function cardHTML(cl) {
    const thumb = cl.thumb ? `<img src="${cl.thumb}" alt="face"/>` : `<span class="face-ph-icon">🙂</span>`;
    const seen = `${cl.clipKeys.size} clip${cl.clipKeys.size !== 1 ? 's' : ''}`;
    if (cl.done) {
      return `<div class="face-grid-card-item confirmed" data-i="${cl._i}">
        <div class="fgc-photo">${thumb}<span class="fgc-badge">✓</span></div>
        <div class="fgc-name">${escapeHtml(cl.assignedName)}</div>
        <div class="fgc-sub muted small">${seen} · tagged</div>
        <button class="fgc-undo" title="Undo">Undo</button>
      </div>`;
    }
    if (cl.suggest && !cl.rejected) {
      const others = names.filter((n) => n.toLowerCase() !== cl.suggest.name.toLowerCase()).slice(0, 8);
      const othChips = others.map((n) => `<button class="fgc-chip" data-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('');
      return `<div class="face-grid-card-item suggested" data-i="${cl._i}">
        <div class="fgc-photo">${thumb}</div>
        <div class="fgc-q">Is this <b>${escapeHtml(cl.suggest.name)}</b>?</div>
        <div class="fgc-sub muted small">${seen}</div>
        <div class="fgc-btns"><button class="fgc-yes" title="Yes — confirm">✓ Yes</button><button class="fgc-no" title="No">✗</button></div>
        <input type="text" class="ai-input fgc-input" placeholder="or type the right name…" autocomplete="off"/>
        ${othChips ? `<div class="fgc-chips compact">${othChips}</div>` : ''}
      </div>`;
    }
    const chips = names.slice(0, 8).map((n) => `<button class="fgc-chip" data-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join('');
    return `<div class="face-grid-card-item fresh" data-i="${cl._i}">
      <div class="fgc-photo">${thumb}</div>
      <div class="fgc-sub muted small">${seen}</div>
      <input type="text" class="ai-input fgc-input" placeholder="Who is this?" autocomplete="off"/>
      ${chips ? `<div class="fgc-chips compact">${chips}</div>` : ''}
      <div class="fgc-btns"><button class="fgc-save" title="Save">✓</button><button class="fgc-skip" title="Not a person / skip">✗</button></div>
    </div>`;
  }
  function section(title, list) {
    if (!list.length) return '';
    return `<div class="fg-section">${escapeHtml(title)} <span class="fg-count">${list.length}</span></div><div class="face-grid">${list.map(cardHTML).join('')}</div>`;
  }
  function render() {
    const live = clusters.filter((c) => !c.skipped);
    const suggested = live.filter((c) => !c.done && c.suggest && !c.rejected);
    const fresh = live.filter((c) => !c.done && (!c.suggest || c.rejected));
    const recognized = live.filter((c) => c.done && c.autoMatched);
    const confirmed = live.filter((c) => c.done && !c.autoMatched);
    scroll.innerHTML = section('Suggested — confirm or correct', suggested)
      + section('New faces — who is this?', fresh)
      + section('Recognized automatically — fix any that are wrong', recognized)
      + section('Just confirmed', confirmed);
    if (!live.length) scroll.innerHTML = '<p class="muted small" style="text-align:center;padding:24px 0">All faces handled ✓</p>';
    wire();
    const anySuggested = suggested.length > 0;
    const btn = ov.querySelector('.fg-confirm-all');
    if (btn) btn.style.display = anySuggested ? '' : 'none';
  }
  // Smooth micro-tint over the face before the action lands: blue for accept,
  // red for reject. The action fires mid-flash so it feels instant but soft.
  function flash(card, kind, fn) {
    const ph = card.querySelector('.fgc-photo');
    if (ph) ph.classList.add(kind === 'ok' ? 'flash-ok' : 'flash-no');
    setTimeout(fn, 280);
  }
  function wire() {
    scroll.querySelectorAll('.face-grid-card-item').forEach((card) => {
      const cl = clusters[Number(card.dataset.i)];
      if (!cl) return;
      const yes = card.querySelector('.fgc-yes'); if (yes) yes.addEventListener('click', () => flash(card, 'ok', () => assign(cl, cl.suggest.name)));
      const no = card.querySelector('.fgc-no'); if (no) no.addEventListener('click', () => flash(card, 'no', () => { cl.rejected = true; render(); }));
      const undo = card.querySelector('.fgc-undo'); if (undo) undo.addEventListener('click', () => { if (cl.autoMatched && cl.assignedName) untagClips(cl, cl.assignedName); cl.done = false; cl.autoMatched = false; cl.assignedName = ''; cl.suggest = null; render(); });
      const save = card.querySelector('.fgc-save'); const inp = card.querySelector('.fgc-input');
      if (save && inp) save.addEventListener('click', () => { if (inp.value.trim()) flash(card, 'ok', () => assign(cl, inp.value)); });
      if (inp) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.value.trim()) { e.preventDefault(); flash(card, 'ok', () => assign(cl, inp.value)); } });
      const skip = card.querySelector('.fgc-skip'); if (skip) skip.addEventListener('click', () => flash(card, 'no', () => { cl.skipped = true; render(); }));
      card.querySelectorAll('.fgc-chip').forEach((chip) => chip.addEventListener('click', () => flash(card, 'ok', () => assign(cl, chip.dataset.name))));
    });
  }
  ov.querySelector('.fg-confirm-all').addEventListener('click', async () => {
    const pending = clusters.filter((c) => !c.done && !c.skipped && c.suggest && !c.rejected);
    for (const c of pending) { /* eslint-disable-next-line no-await-in-loop */ await assign(c, c.suggest.name); }
  });
  render();
  });
}

function showFaceSetup(reason) {
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card modal-form" style="width:min(520px,94vw);text-align:left">
    <div class="illo mob-illo">${ILLO_PEOPLE}</div>
    <div class="ai-hd" style="margin-top:2px"><div class="ai-hd-text"><h3>Face recognition</h3><p class="muted small">It's <b>built in and fully local</b> — no cloud, no setup, no downloads. The models ship with the app.</p></div></div>
    <p class="muted small fs-reason">${reason ? `It didn’t load this time — ${escapeHtml(reason)} This is usually a temporary graphics/driver hiccup; try again.` : 'Once it loads, “Scan faces” finds people in your clips, you name each one once, and future clips auto-tag them into the metadata (PersonInImage + keywords).'}</p>
    <div class="modal-actions"><button type="button" class="btn primary fs-retry">Try again</button><button type="button" class="btn fs-ok">Close</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('.fs-ok').addEventListener('click', close);
  ov.querySelector('.fs-retry').addEventListener('click', async () => {
    const btn = ov.querySelector('.fs-retry'); btn.disabled = true; btn.textContent = 'Loading…';
    _faceReady = null;
    const r = await ensureFaceModels();
    if (r && r.ok) { close(); showToast('Face recognition ready ✓'); }
    else { btn.disabled = false; btn.textContent = 'Try again'; const p = ov.querySelector('.fs-reason'); if (p) p.textContent = `Still couldn’t start — ${(r && r.error) || 'unknown error'} Make sure your graphics drivers are up to date.`; }
  });
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
}

const PEOPLE_ILLUS = `<div class="people-illus">
  <svg viewBox="0 0 140 112" xmlns="http://www.w3.org/2000/svg">
    <path d="M24 30L24 20L34 20" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M116 30L116 20L106 20" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M24 82L24 92L34 92" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M116 82L116 92L106 92" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="70" cy="48" r="26" fill="none" stroke="var(--text-3)" stroke-width="1.5" stroke-dasharray="5 3"/>
    <circle cx="61" cy="43" r="3.5" fill="var(--text-2)"/>
    <circle cx="79" cy="43" r="3.5" fill="var(--text-2)"/>
    <path d="M62 57 Q70 64 78 57" fill="none" stroke="var(--text-2)" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M18 106 Q18 80 70 80 Q122 80 122 106" fill="none" stroke="var(--text-3)" stroke-width="1.5"/>
    <line x1="30" x2="110" y1="48" y2="48" stroke="var(--accent)" stroke-width="1.5" opacity="0.85">
      <animate attributeName="y1" values="22;74;22" dur="2.6s" repeatCount="indefinite" calcMode="ease-in-out"/>
      <animate attributeName="y2" values="22;74;22" dur="2.6s" repeatCount="indefinite" calcMode="ease-in-out"/>
      <animate attributeName="opacity" values="0.15;0.9;0.15" dur="2.6s" repeatCount="indefinite" calcMode="ease-in-out"/>
    </line>
  </svg>
</div>`;

// People dashboard (digiKam-style): a sidebar of every known person + a main panel
// showing all of that person's face crops. Rename, merge duplicates, remove a wrong
// face, set a cover, delete, or scan more clips.
const PD_IGNORED = '__ignored__';
async function showPeopleManager() {
  let people = [];
  let ignoredN = 0;
  try { people = await window.api.getPeople(); } catch { people = []; }
  try { ignoredN = await window.api.ignoredCount(); } catch { ignoredN = 0; }
  let selId = people.length ? people[0].id : (ignoredN ? PD_IGNORED : null);
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card pd-card">
    <div class="pd-hd">
      <span class="pd-hd-icon">${typeof SCAN_ANIM !== 'undefined' ? SCAN_ANIM : '🫥'}</span>
      <div class="pd-hd-tx"><h3>People &amp; faces</h3><p class="muted small pd-hd-sub">Confirm who's who, merge duplicates, ignore non-people, or scan more clips.</p></div>
      <button type="button" class="btn primary pd-scan">Scan clips</button>
    </div>
    <div class="pd-body"><div class="pd-side"></div><div class="pd-main"></div></div>
    <div class="modal-actions"><button type="button" class="btn pd-done">Done</button></div>
  </div>`;
  document.body.appendChild(ov);
  const q = (s) => ov.querySelector(s);
  const close = () => ov.remove();
  q('.pd-done').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  q('.pd-scan').addEventListener('click', () => {
    const sel = currentSelectedClips();
    if (!sel.length) { showToast('Tick some clips first (or open a card)'); return; }
    close(); scanFacesForClips(sel);
  });

  async function reloadPeople(keepSel) {
    try { people = await window.api.getPeople(); } catch { people = []; }
    try { ignoredN = await window.api.ignoredCount(); } catch { ignoredN = 0; }
    const stillValid = selId === PD_IGNORED ? ignoredN > 0 : people.some((p) => p.id === selId);
    if (!keepSel || !stillValid) selId = people.length ? people[0].id : (ignoredN ? PD_IGNORED : null);
    renderSide(); renderMain();
  }
  function renderSide() {
    const side = q('.pd-side');
    if (!people.length && !ignoredN) { side.style.display = 'none'; return; }
    side.style.display = '';
    const personRows = people.map((p) => `<button type="button" class="pd-person${p.id === selId ? ' active' : ''}" data-id="${p.id}">
      <span class="pd-person-thumb">${p.thumb ? `<img src="${p.thumb}"/>` : '<span class="face-ph-icon">🙂</span>'}</span>
      <span class="pd-person-tx"><span class="pd-person-name">${escapeHtml(p.name)}</span><span class="pd-person-count muted small">${p.count} face${p.count !== 1 ? 's' : ''}</span></span>
      ${p.unconfirmed ? `<span class="pd-badge" title="${p.unconfirmed} to confirm">${p.unconfirmed}</span>` : ''}
    </button>`).join('');
    const ignoredRow = ignoredN ? `<button type="button" class="pd-person pd-ignored-row${selId === PD_IGNORED ? ' active' : ''}" data-id="${PD_IGNORED}">
      <span class="pd-person-thumb pd-ignored-thumb">⊘</span>
      <span class="pd-person-tx"><span class="pd-person-name">Ignored</span><span class="pd-person-count muted small">${ignoredN} face${ignoredN !== 1 ? 's' : ''}</span></span>
    </button>` : '';
    side.innerHTML = personRows + (ignoredRow ? `<div class="pd-side-sep"></div>${ignoredRow}` : '');
    side.querySelectorAll('.pd-person').forEach((b) => {
      b.addEventListener('click', () => { selId = b.dataset.id; renderSide(); renderMain(); });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = b.dataset.id;
        selId = id; renderSide(); renderMain();
        if (id === PD_IGNORED) { showContextMenu(e.clientX, e.clientY, [{ label: 'Restore all ignored', action: async () => { let list = []; try { list = await window.api.listIgnoredFaces(); } catch { /* */ } for (let k = list.length - 1; k >= 0; k -= 1) { /* eslint-disable-next-line no-await-in-loop */ await window.api.unignoreFace(k); } await reloadPeople(false); } }]); return; }
        const p = people.find((x) => x.id === id);
        showContextMenu(e.clientX, e.clientY, [
          { label: 'Rename', action: () => { const inp = q('.pd-name'); if (inp) { inp.focus(); inp.select(); } } },
          { label: 'Merge…', action: async () => { const d = await window.api.personDetail(id); if (d && d.ok) openMerge(d); } },
          { sep: true },
          { label: 'Delete person', danger: true, action: async () => { if (p) removeClipPersonName(p.name); await window.api.deletePerson(id); await reloadPeople(false); } }
        ]);
      });
    });
  }
  function faceCard(f, kind, n) {
    const delay = `style="animation-delay:${Math.min(n * 26, 380)}ms"`;
    const img = f.t ? `<img src="${f.t}"/>` : '<span class="face-ph-icon">🙂</span>';
    let acts = '';
    const reassign = `<button type="button" class="pd-fa" data-act="reassign" title="This is someone else…">⇄</button>`;
    if (kind === 'ignored') acts = `<button type="button" class="pd-fa" data-act="restore" title="Not ignored — restore">↩</button>`;
    else if (kind === 'unconf') acts = `<button type="button" class="pd-fa ok" data-act="confirm" title="Yes, this is them">✓</button>${reassign}<button type="button" class="pd-fa" data-act="ignore" title="Ignore">⊘</button><button type="button" class="pd-fa" data-act="remove" title="Remove">✕</button>`;
    else acts = `${reassign}<button type="button" class="pd-fa" data-act="ignore" title="Ignore">⊘</button><button type="button" class="pd-fa" data-act="remove" title="Remove">✕</button>`;
    const cover = kind === 'conf' && f.cover ? '<span class="pd-cover-tag">cover</span>' : '';
    return `<div class="pd-face${f.cover ? ' cover' : ''}${kind === 'unconf' ? ' unconf' : ''}" data-idx="${f.i}" ${delay}>${img}${cover}<div class="pd-face-acts">${acts}</div></div>`;
  }
  async function renderMain() {
    const main = q('.pd-main');
    if (!people.length && !ignoredN) {
      main.innerHTML = `${PEOPLE_ILLUS}<p class="muted small" style="text-align:center;max-width:360px;margin:0 auto">No people yet. Tick some clips and tap <b>Scan clips</b> — name each face once and it auto-tags from now on.</p>`;
      return;
    }
    if (selId === PD_IGNORED) {
      let list = [];
      try { list = await window.api.listIgnoredFaces(); } catch { list = []; }
      main.innerHTML = `<div class="pd-main-hd"><h3 class="pd-title">Ignored faces</h3></div>
        <div class="pd-faces-hd muted small">Faces you told the app to skip — they won't be suggested as people. ↩ to restore one.</div>
        <div class="pd-faces">${list.map((f, n) => faceCard(f, 'ignored', n)).join('') || '<p class="muted small">Nothing ignored.</p>'}</div>`;
      const fc = main.querySelector('.pd-faces');
      fc && fc.addEventListener('click', async (e) => {
        const card = e.target.closest('.pd-face'); if (!card) return;
        const act = (e.target.closest('[data-act]') || {}).dataset; if (!act) return;
        if (act.act === 'restore') { await window.api.unignoreFace(Number(card.dataset.idx)); await reloadPeople(true); }
      });
      fc && fc.addEventListener('contextmenu', (e) => {
        const card = e.target.closest('.pd-face'); if (!card) return;
        e.preventDefault(); e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, [{ label: 'Restore (not ignored)', action: async () => { await window.api.unignoreFace(Number(card.dataset.idx)); await reloadPeople(true); } }]);
      });
      return;
    }
    let d = null;
    try { d = await window.api.personDetail(selId); } catch { d = null; }
    if (!d || !d.ok) { main.innerHTML = '<p class="muted small">Could not load this person.</p>'; return; }
    const faces = (d.faces || []).map((f) => ({ ...f, cover: f.t && f.t === d.cover }));
    const unconf = faces.filter((f) => !f.confirmed);
    const conf = faces.filter((f) => f.confirmed);
    const sec = (title, list, kind) => list.length ? `<div class="pd-sec-hd">${escapeHtml(title)} <span class="fg-count">${list.length}</span></div><div class="pd-faces">${list.map((f, n) => faceCard(f, kind, n)).join('')}</div>` : '';
    main.innerHTML = `<div class="pd-main-hd">
        <input type="text" class="ai-input pd-name" value="${escapeHtml(d.name)}" spellcheck="false" />
        <div class="pd-acts"><button type="button" class="btn subtle pd-merge">Merge…</button><button type="button" class="btn subtle danger pd-del">Delete</button></div>
      </div>
      <div class="pd-faces-hd muted small">${conf.length} confirmed${unconf.length ? ` · ${unconf.length} to confirm` : ''} · click a confirmed face to make it the cover</div>
      ${sec('Unconfirmed — is this them?', unconf, 'unconf')}
      ${sec('Confirmed', conf, 'conf')}
      ${!faces.length ? '<p class="muted small">No face crops stored yet.</p>' : ''}`;
    const nameInp = main.querySelector('.pd-name');
    const commitName = async () => { const nm = nameInp.value.trim(); if (nm && nm !== d.name) { await window.api.renamePerson({ id: selId, name: nm }); updateClipPeopleName(d.name, nm); showToast(`Renamed to "${nm}"`); await reloadPeople(true); } };
    nameInp.addEventListener('blur', commitName);
    nameInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameInp.blur(); } });
    main.querySelector('.pd-del').addEventListener('click', async () => { removeClipPersonName(d.name); await window.api.deletePerson(selId); await reloadPeople(false); });
    main.querySelector('.pd-merge').addEventListener('click', () => openMerge(d));
    main.querySelectorAll('.pd-faces').forEach((fc) => {
      fc.addEventListener('click', async (e) => {
        const card = e.target.closest('.pd-face'); if (!card) return;
        const idx = Number(card.dataset.idx);
        const actBtn = e.target.closest('[data-act]');
        const act = actBtn ? actBtn.dataset.act : (e.target.closest('img') && card.classList.contains('cover') === false && !card.classList.contains('unconf') ? 'cover' : null);
        if (act === 'reassign') { showReassignFacePicker(selId, idx, () => reloadPeople(true)); return; }
        if (act === 'confirm') await window.api.confirmFace({ id: selId, index: idx });
        else if (act === 'ignore') await window.api.ignoreFace({ id: selId, index: idx });
        else if (act === 'remove') await window.api.removePersonFace({ id: selId, index: idx });
        else if (act === 'cover') await window.api.setPersonCover({ id: selId, thumb: card.querySelector('img').getAttribute('src') });
        else return;
        await reloadPeople(true);
      });
      fc.addEventListener('contextmenu', (e) => {
        const card = e.target.closest('.pd-face'); if (!card) return;
        e.preventDefault(); e.stopPropagation();
        const idx = Number(card.dataset.idx);
        const isUnconf = card.classList.contains('unconf');
        const isCover = card.classList.contains('cover');
        const reload = () => reloadPeople(true);
        const items = [];
        if (isUnconf) items.push({ label: 'Confirm — this is them', action: async () => { await window.api.confirmFace({ id: selId, index: idx }); reload(); } });
        items.push({ label: 'This is someone else…', action: () => showReassignFacePicker(selId, idx, reload) });
        if (!isCover) items.push({ label: 'Set as cover', action: async () => { const img = card.querySelector('img'); if (img) { await window.api.setPersonCover({ id: selId, thumb: img.getAttribute('src') }); reload(); } } });
        items.push({ label: 'Ignore this face', action: async () => { await window.api.ignoreFace({ id: selId, index: idx }); reload(); } });
        items.push({ sep: true });
        items.push({ label: 'Remove this face', danger: true, action: async () => { await window.api.removePersonFace({ id: selId, index: idx }); reload(); } });
        showContextMenu(e.clientX, e.clientY, items);
      });
    });
  }
  function openMerge(d) {
    const others = people.filter((p) => p.id !== selId);
    if (!others.length) { showToast('No other people to merge'); return; }
    const pop = document.createElement('div'); pop.className = 'modal-overlay';
    pop.innerHTML = `<div class="modal-card modal-form" style="width:min(420px,92vw);text-align:left">
      <div class="ai-hd"><span class="ai-hd-icon">🔗</span><div class="ai-hd-text"><h3>Merge into ${escapeHtml(d.name)}</h3><p class="muted small">Pick a duplicate — its faces move into ${escapeHtml(d.name)} and it's removed.</p></div></div>
      <div class="pd-merge-list">${others.map((p) => `<button type="button" class="pd-merge-opt" data-id="${p.id}"><span class="people-thumb">${p.thumb ? `<img src="${p.thumb}"/>` : '🙂'}</span><span class="people-name">${escapeHtml(p.name)}</span><span class="muted small">${p.count}</span></button>`).join('')}</div>
      <div class="modal-actions"><button type="button" class="btn pd-merge-cancel">Cancel</button></div>
    </div>`;
    document.body.appendChild(pop);
    pop.addEventListener('mousedown', (e) => { if (e.target === pop) pop.remove(); });
    pop.querySelector('.pd-merge-cancel').addEventListener('click', () => pop.remove());
    pop.querySelectorAll('.pd-merge-opt').forEach((b) => b.addEventListener('click', async () => {
      const from = others.find((p) => p.id === b.dataset.id);
      await window.api.mergePerson({ intoId: selId, fromId: b.dataset.id });
      if (from) updateClipPeopleName(from.name, d.name);
      pop.remove(); showToast('Merged ✓'); await reloadPeople(true);
    }));
  }
  renderSide(); renderMain();
}
// Keep clip people-tags consistent when a person is renamed / merged / deleted in
// the dashboard, so the metadata written at Finalize matches the dashboard.
function updateClipPeopleName(oldName, newName) {
  const fix = (arr) => (Array.isArray(arr) ? [...new Set(arr.map((n) => (n === oldName ? newName : n)))] : arr);
  (state.scannedFiles || []).forEach((c) => { if (Array.isArray(c.people)) c.people = fix(c.people); });
  if (typeof finScan !== 'undefined' && finScan && Array.isArray(finScan.files)) finScan.files.forEach((f) => { if (f.meta && Array.isArray(f.meta.people)) f.meta.people = fix(f.meta.people); });
  refreshNames && refreshNames();
}
function removeClipPersonName(name) {
  (state.scannedFiles || []).forEach((c) => { if (Array.isArray(c.people)) c.people = c.people.filter((n) => n !== name); });
  if (typeof finScan !== 'undefined' && finScan && Array.isArray(finScan.files)) finScan.files.forEach((f) => { if (f.meta && Array.isArray(f.meta.people)) f.meta.people = f.meta.people.filter((n) => n !== name); });
}
// The clips currently in play to scan (rename grid selection, else all scanned).
function currentSelectedClips() {
  const fin = document.getElementById('finalize');
  if (fin && !fin.classList.contains('hidden') && finScan && finScan.files) {
    return (finSelected().length ? finSelected() : finMatched()).map((f) => ({ key: f.name, name: f.name, sourcePath: f.sourcePath, people: (f.meta && f.meta.people) || [], _ref: f }));
  }
  const sel = (state.scannedFiles || []).filter((c) => c.selected);
  return (sel.length ? sel : (state.scannedFiles || []));
}

// Model store popout (Engine → Browse models…). Browse/download/remove local
// models — vision (look at clips) + reasoning (text). Self-contained; callbacks
// let the AI settings update its dropdowns. opts: {onUseVision,onUseReasoning,onChanged}
const STORE_REASONING = [
  { name: 'qwen3:8b', desc: 'Qwen3 8B — strong all-round reasoning (recommended).', rec: true },
  { name: 'qwen3:4b', desc: 'Qwen3 4B — lighter & faster.' },
  { name: 'llama3.1:8b', desc: 'Llama 3.1 8B — solid alternative.' }
];
function showModelStore(opts = {}) {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card ai-import" style="width:min(700px,94vw); max-height:88vh; display:flex; flex-direction:column">
    <div class="ai-hd"><span class="ai-hd-icon">🗄️</span><div class="ai-hd-text"><h3>Model store</h3><p class="muted small">Vision models look at your clips; reasoning (text) models do the thinking. Everything downloads locally into Ollama.</p></div></div>
    <div class="ms-status muted small"></div>
    <div class="ms-scroll" style="overflow:auto; flex:1; min-height:140px">
      <div class="ms-list"></div>
      <h4 class="ai-pane-title" style="margin:16px 0 0">Reasoning models <span class="muted small" style="font-weight:400">(text)</span></h4>
      <div class="ms-reason"></div>
    </div>
    <div class="ai-ctl-row" style="gap:8px; margin-top:12px"><input type="text" class="ai-input ms-pull-name" placeholder="Pull any model by name — e.g. qwen3:8b, minicpm-v" style="flex:1" /><button type="button" class="btn ms-pull">Pull</button></div>
    <div class="ms-pull-status muted small hidden" style="margin-top:4px"></div>
    <div class="modal-actions"><button type="button" class="btn ms-close">Close</button></div>
  </div>`;
  document.body.appendChild(ov);
  const q = (s) => ov.querySelector(s);
  let unsub = null;
  let pulling = false;
  const close = () => { if (unsub) unsub(); ov.remove(); };
  q('.ms-close').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });

  async function pull(name, statusEl) {
    if (pulling) { showToast('A download is already running — let it finish'); return false; }
    pulling = true;
    statusEl.classList.remove('hidden'); statusEl.textContent = `Downloading ${name}…`;
    if (unsub) unsub();
    unsub = window.api.onAiPullProgress((p) => {
      if (p.error) { statusEl.textContent = `Error: ${p.error}`; return; }
      statusEl.textContent = `${name}: ${p.status || 'working'}${p.percent != null ? ` · ${p.percent}%` : ''}`;
    });
    const r = await window.api.aiPull(name);
    if (unsub) { unsub(); unsub = null; }
    pulling = false;
    return r && r.ok;
  }
  async function load() {
    q('.ms-status').textContent = 'Loading…';
    let res; try { res = await window.api.aiCatalog(); } catch { res = null; }
    if (!res || !res.ok) { q('.ms-status').textContent = 'Could not reach Ollama — is it installed and running?'; return; }
    const inst = res.catalog.filter((m) => m.installed).length;
    q('.ms-status').textContent = `${res.catalog.length} vision models · ${inst} installed${res.live ? '' : ' · built-in list'}`;
    renderRows(q('.ms-list'), res.catalog, 'vision');
    const installed = res.installed || [];
    const instBase = new Set(installed.map((n) => n.split(':')[0]));
    const reason = STORE_REASONING.map((m) => ({ ...m, installed: instBase.has(m.name.split(':')[0]) || installed.includes(m.name) }));
    renderRows(q('.ms-reason'), reason, 'reason');
  }
  function renderRows(listEl, items, kind) {
    listEl.innerHTML = '';
    for (const m of items) {
      const row = document.createElement('div'); row.className = 'ai-store-item' + (m.rec ? ' rec' : '');
      const meta = [m.params, m.size].filter(Boolean).join(' · ') || (kind === 'reason' ? 'text model' : 'vision model');
      const badges = `${m.rec ? '<span class="ai-store-badge">Recommended</span>' : ''}${m.live ? '<span class="ai-store-badge live">New</span>' : ''}`;
      row.innerHTML = `<div class="ai-store-info"><div class="ai-store-name">${escapeHtml(m.name)}${badges}</div><div class="ai-store-meta muted small">${escapeHtml(meta)}</div><div class="ai-store-desc muted small">${escapeHtml(m.desc || '')}</div></div><div class="ai-store-action"></div>`;
      const act = row.querySelector('.ai-store-action');
      const useFn = kind === 'reason' ? opts.onUseReasoning : opts.onUseVision;
      if (m.installed) {
        act.innerHTML = `<span class="ai-store-installed">Installed ✓</span><div class="ai-ctl-row" style="gap:6px"><button type="button" class="btn subtle ms-use">Use</button><button type="button" class="btn subtle ms-rm">Remove</button></div>`;
        act.querySelector('.ms-use').addEventListener('click', () => { if (useFn) useFn(m.name); showToast(`${kind === 'reason' ? 'Reasoning' : 'Vision'} model: ${m.name}`); });
        act.querySelector('.ms-rm').addEventListener('click', async () => {
          const ch = await keyChoiceDialog('Remove model?', `Delete ${m.name} from Ollama? Frees disk space; you’d re-download it to use it again.`, [{ label: 'Remove', value: 'rm' }, { label: 'Cancel', value: null }]);
          if (ch !== 'rm') return;
          const r = await window.api.aiDelete(m.name);
          if (r && r.ok) { if (opts.onChanged) opts.onChanged(); load(); showToast(`${m.name} removed`); }
          else showToast(`Couldn't remove: ${r ? r.error : 'unknown'}`);
        });
      } else {
        act.innerHTML = `<button type="button" class="btn ms-dl">${kind === 'reason' ? 'Download & use' : 'Download'}</button><div class="ms-dl-status muted small hidden"></div>`;
        const st = act.querySelector('.ms-dl-status');
        act.querySelector('.ms-dl').addEventListener('click', async () => {
          const ok = await pull(m.name, st);
          if (ok) { if (useFn) useFn(m.name); if (opts.onChanged) opts.onChanged(); load(); showToast(`${m.name} ready ✓`); }
          else st.textContent = 'Failed';
        });
      }
      listEl.appendChild(row);
    }
  }
  q('.ms-pull').addEventListener('click', async () => {
    const name = q('.ms-pull-name').value.trim();
    if (!name) { showToast('Type a model name'); return; }
    const ok = await pull(name, q('.ms-pull-status'));
    if (ok) { if (opts.onChanged) opts.onChanged(); load(); showToast(`${name} ready ✓`); }
  });
  load();
}

function showAiSettings() {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  const c = { ...aiCfg };
  c.memories = (aiCfg.memories || []).map((m) => ({ ...m }));   // editable copy
  // Editable shot-types list — seed with the user's, or the built-in defaults.
  c.shotTypes = (Array.isArray(aiCfg.shotTypes) && aiCfg.shotTypes.length)
    ? aiCfg.shotTypes.map((s) => ({ ...s }))
    : DEFAULT_SHOT_TYPES.map((s) => ({ ...s }));
  if (!c.endpoint) c.endpoint = 'http://localhost:11434';
  const tgl = (cls, on) => `<label class="tgl"><input type="checkbox" class="${cls}" ${on ? 'checked' : ''} /><span class="tgl-track"></span></label>`;
  const ICON = {
    engine: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.2M12 18.8V21M21 12h-2.2M5.2 12H3M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2 5.6 5.6"/></svg>',
    analysis: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    instructions: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="4" width="14" height="16" rx="1.5"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
    learn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.7 4 4 1.7-4 1.7L12 14l-1.7-3.6-4-1.7 4-1.7z"/><path d="M18 14l.9 2 2 .9-2 .9L18 20l-.9-2.2-2-.9 2-.9z"/></svg>',
    memory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h12a1 1 0 0 1 1 1v15l-7-3.2L5 20V5a1 1 0 0 1 1-1z"/></svg>',
    connection: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="9" width="10" height="6" rx="1"/><path d="M9 9V5M15 9V5M9 19v-4M15 19v-4"/></svg>',
    store: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16l-1 3.5a2 2 0 0 1-2 1.5H7a2 2 0 0 1-2-1.5L4 7z"/><path d="M5 7l1.2-2.4A1 1 0 0 1 7.1 4h9.8a1 1 0 0 1 .9.6L19 7M6 12v7h12v-7"/></svg>'
  };
  const NAV = [['engine', 'Engine'], ['analysis', 'Analysis'], ['instructions', 'Instructions'], ['memory', 'Memory']];
  const navHtml = NAV.map(([id, label], i) => `<button type="button" class="ai-nav-item${i === 0 ? ' active' : ''}" data-nav="${id}"><span class="ai-nav-ic">${ICON[id]}</span><span class="ai-nav-tx">${label}</span></button>`).join('');

  ov.innerHTML = `<div class="modal-card ai-panel ai-settings">
    <nav class="ai-nav">
      <div class="ai-nav-search">
        <svg class="ai-nav-search-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input type="text" class="ai-nav-searchbox" placeholder="Search" spellcheck="false" />
      </div>
      <div class="ai-nav-label">AI suggestions</div>
      <div class="ai-nav-group">${navHtml}</div>
    </nav>
    <div class="ai-main">
      <button type="button" class="ai-close" title="Close">✕</button>
      <div class="ai-status" id="aiStatus">Checking Ollama…</div>
      <div class="ai-panes">
        <section class="ai-pane" data-pane="engine">
          <h4 class="ai-pane-title">Engine</h4>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Enable AI suggestions</span><span class="ai-card-sub">Turns on the AI actions (right-click a description → AI)</span></div>
            ${tgl('ai-enabled', c.enabled)}
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Vision model</span><span class="ai-card-sub">The local model that looks at your clips</span></div>
            <div class="ai-ctl-row"><span class="ai-model-mount"></span><button type="button" class="btn subtle ai-refresh">Refresh</button></div>
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Reasoning model <span class="muted small">(optional)</span></span><span class="ai-card-sub">A text model for the thinking tasks — learning rules, grouping memories, refining, multi-pass naming. A strong text model does these far better than a vision model.</span></div>
            <span class="ai-text-model-mount"></span>
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Models</span><span class="ai-card-sub">Browse, download and remove local models — vision &amp; reasoning</span></div>
            <button type="button" class="btn ai-browse-models">Browse models…</button>
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Ollama address</span><span class="ai-card-sub">Default is fine unless you changed Ollama's port</span></div>
            <input type="text" class="ai-input ai-endpoint" value="${escapeAttr(c.endpoint)}" style="width:230px" />
          </div>
        </section>

        <section class="ai-pane hidden" data-pane="analysis">
          <h4 class="ai-pane-title">Analysis</h4>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Multi-pass reasoning</span><span class="ai-card-sub">Names each clip in steps — look, then name in your style, then self-check. Slower but better.</span></div>
            ${tgl('ai-multipass', c.multiPass)}
          </div>
          <div class="ai-row col">
            <div class="ai-row-head"><span class="ai-card-title">Frames analysed per clip</span><span class="ai-val ai-frames-val">${c.frames}</span></div>
            <input type="range" min="1" max="12" step="1" value="${c.frames}" class="ai-frames ai-range" />
            <span class="ai-card-sub">More frames read motion &amp; shot type better, but run slower — they're tiled into one contact-sheet grid.</span>
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Let AI change the subject</span><span class="ai-card-sub">Off = keep your subjects; AI only fills/refines the description &amp; metadata from what it sees.</span></div>
            ${tgl('ai-updsubj', c.updateSubject)}
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Ask me to confirm after each run</span><span class="ai-card-sub">After analysing, step through each clip to confirm or fix its name — every correction teaches the AI.</span></div>
            ${tgl('ai-askrun', c.askAfterRun)}
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Detect shot type</span><span class="ai-card-sub">talking-head / pov / vlog / timelapse… prefixed to the description</span></div>
            ${tgl('ai-shot', c.detectShot)}
          </div>
          <div class="ai-row col">
            <div class="ai-row-head"><div class="ai-card-text"><span class="ai-card-title">Shot types</span><span class="ai-card-sub">The shot types the AI may choose from. Give each a short description so it knows what to look for.</span></div></div>
            <div class="ai-shot-list"></div>
            <button type="button" class="btn subtle ai-shot-add" style="align-self:flex-start">＋ Add shot type</button>
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Guess a Category</span><span class="ai-card-sub">Only from categories you already use</span></div>
            ${tgl('ai-cat', c.suggestCategory)}
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Suggest tags</span><span class="ai-card-sub">Auto-fill each clip's tag row with searchable keywords (place, objects, mood…)</span></div>
            ${tgl('ai-tags', c.suggestTags !== false)}
          </div>
          <div class="ai-row col">
            <div class="ai-row-head"><span class="ai-card-title">Creativity</span><span class="ai-val ai-temp-val">${c.temperature}</span></div>
            <input type="range" min="0" max="1" step="0.05" value="${c.temperature}" class="ai-temp ai-range" />
            <span class="ai-card-sub">Lower = consistent &amp; literal · higher = more varied wording</span>
          </div>
          <h4 class="ai-pane-title" style="margin-top:20px">Face recognition</h4>
          <div class="ai-row col">
            <div class="ai-row-head"><span class="ai-card-title">Scan a frame every</span><span class="ai-val ai-faceint-val">${c.faceInterval}s</span></div>
            <input type="range" min="1" max="15" step="1" value="${c.faceInterval}" class="ai-faceint ai-range" />
            <span class="ai-card-sub">How often to sample the clip when scanning for faces. Smaller = catches people who appear only briefly, but slower.</span>
          </div>
          <div class="ai-row col">
            <div class="ai-row-head"><span class="ai-card-title">Max frames per clip</span><span class="ai-val ai-facemax-val">${c.faceMaxFrames}</span></div>
            <input type="range" min="4" max="120" step="4" value="${c.faceMaxFrames}" class="ai-facemax ai-range" />
            <span class="ai-card-sub">Upper limit so very long clips don't take forever. Frames are spread evenly across the whole clip.</span>
          </div>
        </section>

        <section class="ai-pane hidden" data-pane="instructions">
          <h4 class="ai-pane-title">Instructions to the model</h4>
          <div class="ai-row col">
            <span class="ai-card-sub">Your guidance only — the strict-JSON format &amp; field rules are added automatically.</span>
            <textarea class="ai-prompt ai-textarea" rows="6">${escapeHtml(c.prompt || AI_DEFAULT_GUIDANCE)}</textarea>
            <button type="button" class="btn subtle ai-prompt-reset" style="align-self:flex-start">Reset to default</button>
          </div>
        </section>

        <section class="ai-pane hidden" data-pane="memory">
          <h4 class="ai-pane-title">Memory</h4>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Learn from my edits</span><span class="ai-card-sub">When you change a name the AI suggested, it quietly works out the pattern and asks before remembering.</span></div>
            ${tgl('ai-learnedits', c.learnFromEdits)}
          </div>
          <div class="ai-row">
            <div class="ai-card-text"><span class="ai-card-title">Learn from each analysis</span><span class="ai-card-sub">After analysing, the AI looks back at what it saw and how it named clips, then folds the pattern into memory automatically.</span></div>
            ${tgl('ai-learnanalysis', c.learnFromAnalysis)}
          </div>
          <div class="ai-row col">
            <div class="ai-card-text"><span class="ai-card-title">Learn my style from a folder</span><span class="ai-card-sub">Reads the names you've already given clips, works out your style, and proposes rules to add (you confirm). Real examples are used in every suggestion.</span></div>
            <div class="ai-ctl-row" style="gap:8px; flex-wrap:wrap">
              <button type="button" class="btn subtle ai-learn-folder">Choose folder…</button>
              <span class="ai-learn-dir muted small" style="align-self:center"></span>
            </div>
            <button type="button" class="btn primary ai-learn-btn" style="align-self:flex-start">Analyse my naming style</button>
            <div class="ai-learn-status muted small hidden"></div>
          </div>
          <div class="ai-row col">
            <div class="ai-row-head"><span class="ai-card-title">Remembered preferences</span><button type="button" class="btn subtle ai-mem-tidy">Tidy &amp; group</button></div>
            <span class="ai-card-sub">What the AI follows on every suggestion — built from your feedback, style, edits and imports. Edit, delete, or add your own.</span>
            <input type="text" class="ai-input ai-mem-search" placeholder="Search memories…" spellcheck="false" />
            <div class="ai-mem-list"></div>
            <div class="ai-ctl-row" style="align-self:flex-start; gap:8px">
              <button type="button" class="btn subtle ai-mem-add">＋ Add memory</button>
              <button type="button" class="btn subtle ai-mem-import">Import notes / SOP…</button>
            </div>
          </div>
        </section>
      </div>
    </div></div>`;
  document.body.appendChild(ov);
  const $$ = (sel) => ov.querySelector(sel);
  let unsubPull = null;
  let memUnsub = null;
  let saved = false;
  // Like the Claude settings — there's no Save button; closing applies the changes.
  function saveAndClose() {
    if (saved) return; saved = true;
    if (unsubPull) unsubPull();
    if (memUnsub) memUnsub();
    document.removeEventListener('keydown', onEsc, true);
    aiCfg = {
      enabled: c.enabled, endpoint: (c.endpoint || '').trim() || 'http://localhost:11434', model: (c.model || '').trim(), textModel: (c.textModel || '').trim(),
      suggestCategory: c.suggestCategory, suggestTags: c.suggestTags !== false, frames: c.frames, detectShot: c.detectShot, temperature: c.temperature,
      updateSubject: !!c.updateSubject, askAfterRun: !!c.askAfterRun,
      shotTypes: (c.shotTypes || []).map((s) => ({ name: (s.name || '').trim(), desc: (s.desc || '').trim() })).filter((s) => s.name),
      prompt: (c.prompt || '').trim(),
      multiPass: !!c.multiPass, learnFromEdits: !!c.learnFromEdits, learnFromAnalysis: !!c.learnFromAnalysis,
      faceInterval: c.faceInterval, faceMaxFrames: c.faceMaxFrames,
      memories: c.memories.map((m) => ({ id: m.id, text: (m.text || '').trim(), example: (m.example || '').trim() })).filter((m) => m.text)
    };
    window.api.setPrefs({ ai: aiCfg });
    applyAiPref();
    ov.remove();
  }
  function onEsc(e) { if (e.key === 'Escape') { e.preventDefault(); saveAndClose(); } }
  document.addEventListener('keydown', onEsc, true);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) saveAndClose(); });
  $$('.ai-close').addEventListener('click', saveAndClose);
  $$('.ai-nav-searchbox').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    ov.querySelectorAll('.ai-nav-item').forEach((b) => {
      const txt = b.querySelector('.ai-nav-tx').textContent.toLowerCase();
      b.classList.toggle('hidden', !!q && !txt.includes(q));
    });
  });
  $$('.ai-enabled').addEventListener('change', (e) => { c.enabled = e.target.checked; });
  $$('.ai-cat').addEventListener('change', (e) => { c.suggestCategory = e.target.checked; });
  $$('.ai-tags').addEventListener('change', (e) => { c.suggestTags = e.target.checked; });
  $$('.ai-shot').addEventListener('change', (e) => { c.detectShot = e.target.checked; });
  $$('.ai-updsubj').addEventListener('change', (e) => { c.updateSubject = e.target.checked; });
  $$('.ai-askrun').addEventListener('change', (e) => { c.askAfterRun = e.target.checked; });
  // Editable shot-types list (name + description for the model).
  const shotListEl = $$('.ai-shot-list');
  function renderShots() {
    shotListEl.innerHTML = '';
    c.shotTypes.forEach((s, i) => {
      const row = document.createElement('div'); row.className = 'ai-shot-row';
      const nm = document.createElement('input'); nm.type = 'text'; nm.className = 'ai-input ai-shot-name'; nm.value = s.name || ''; nm.placeholder = 'name (e.g. drone)';
      nm.addEventListener('input', () => { s.name = nm.value; });
      const ds = document.createElement('input'); ds.type = 'text'; ds.className = 'ai-input ai-shot-desc'; ds.value = s.desc || ''; ds.placeholder = 'what it looks like (helps the AI)';
      ds.addEventListener('input', () => { s.desc = ds.value; });
      const del = document.createElement('button'); del.type = 'button'; del.className = 'hk-reset'; del.title = 'Delete'; del.textContent = '✕';
      del.addEventListener('click', () => { c.shotTypes.splice(i, 1); renderShots(); });
      row.append(nm, ds, del);
      shotListEl.appendChild(row);
    });
  }
  renderShots();
  $$('.ai-shot-add').addEventListener('click', () => { c.shotTypes.push({ name: '', desc: '' }); renderShots(); setTimeout(() => { const ins = shotListEl.querySelectorAll('.ai-shot-name'); if (ins.length) ins[ins.length - 1].focus(); }, 10); });
  $$('.ai-multipass').addEventListener('change', (e) => { c.multiPass = e.target.checked; });
  $$('.ai-learnedits').addEventListener('change', (e) => { c.learnFromEdits = e.target.checked; });
  $$('.ai-learnanalysis').addEventListener('change', (e) => { c.learnFromAnalysis = e.target.checked; });
  $$('.ai-endpoint').addEventListener('input', (e) => { c.endpoint = e.target.value; });
  $$('.ai-frames').addEventListener('input', (e) => { c.frames = Number(e.target.value); $$('.ai-frames-val').textContent = c.frames; });
  $$('.ai-temp').addEventListener('input', (e) => { c.temperature = Number(e.target.value); $$('.ai-temp-val').textContent = c.temperature; });
  $$('.ai-faceint').addEventListener('input', (e) => { c.faceInterval = Number(e.target.value); $$('.ai-faceint-val').textContent = `${c.faceInterval}s`; });
  $$('.ai-facemax').addEventListener('input', (e) => { c.faceMaxFrames = Number(e.target.value); $$('.ai-facemax-val').textContent = c.faceMaxFrames; });
  $$('.ai-prompt').addEventListener('input', (e) => { c.prompt = e.target.value; });
  $$('.ai-prompt-reset').addEventListener('click', () => { c.prompt = ''; $$('.ai-prompt').value = AI_DEFAULT_GUIDANCE; });
  // Memory list editor — searchable + auto-grouped into ≤5 collapsible categories.
  const memListEl = $$('.ai-mem-list');
  const memSearch = $$('.ai-mem-search');
  const MEM_CATS = ['Subjects', 'Descriptions', 'Shot types', 'Formatting', 'Other'];
  function memCategory(text) {
    const t = (text || '').toLowerCase();
    if (/\bshot|pov|talking|vlog|angle|camera|motion|footage|b-roll|timelapse|interview|drone\b/.test(t)) return 'Shot types';
    if (/lowercase|case|hyphen|format|prefix|suffix|filename|spell|capital|word count|underscore/.test(t)) return 'Formatting';
    if (/subject|person|name|who|client|people|featured/.test(t)) return 'Subjects';
    if (/descri|keyword|detail|caption|action|what.*happen/.test(t)) return 'Descriptions';
    return 'Other';
  }
  function memRow(m) {
    const row = document.createElement('div'); row.className = 'ai-mem-row';
    const main = document.createElement('div'); main.className = 'ai-mem-main';
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'ai-input ai-mem-text'; inp.value = m.text || ''; inp.placeholder = 'A preference the AI should follow';
    inp.addEventListener('input', () => { m.text = inp.value; });
    const eg = document.createElement('input');
    eg.type = 'text'; eg.className = 'ai-mem-eg'; eg.value = m.example || ''; eg.placeholder = 'e.g. a concrete example (optional)';
    eg.addEventListener('input', () => { m.example = eg.value; });
    main.append(inp, eg);
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'hk-reset ai-mem-del'; del.title = 'Delete'; del.textContent = '✕';
    del.addEventListener('click', () => { c.memories = c.memories.filter((x) => x !== m); renderMems(); });
    row.append(main, del);
    return row;
  }
  function renderMems() {
    memListEl.innerHTML = '';
    if (!c.memories.length) {
      const empty = document.createElement('div');
      empty.className = 'dlg-empty';
      empty.innerHTML = `<span class="illo">${ILLO_MEMORY}</span><p class="dlg-empty-tx">Nothing learned yet</p><p class="muted small">Leave feedback, run “Learn my style”, or add your own — the AI remembers how you like clips named.</p>`;
      memListEl.appendChild(empty);
      return;
    }
    const q = (memSearch.value || '').trim().toLowerCase();
    const items = c.memories.filter((m) => !q || (m.text || '').toLowerCase().includes(q) || (m.example || '').toLowerCase().includes(q));
    if (!items.length) { const e = document.createElement('p'); e.className = 'muted small'; e.textContent = 'No memories match your search.'; memListEl.appendChild(e); return; }
    const groups = {};
    for (const m of items) { const cat = memCategory(m.text); (groups[cat] = groups[cat] || []).push(m); }
    for (const cat of MEM_CATS) {
      const list = groups[cat]; if (!list || !list.length) continue;
      const det = document.createElement('details'); det.className = 'ai-mem-group';
      det.open = !!q;   // collapsed by default; expanded while searching
      const sum = document.createElement('summary'); sum.innerHTML = `${escapeHtml(cat)} <span class="ai-mem-count">${list.length}</span>`;
      det.appendChild(sum);
      for (const m of list) det.appendChild(memRow(m));
      memListEl.appendChild(det);
    }
  }
  memSearch.addEventListener('input', renderMems);
  renderMems();
  // Add memory → full editor with optional "Refine with AI" + revert.
  $$('.ai-mem-add').addEventListener('click', () => {
    showMemoryEditor({ text: '', example: '' }, (saved) => { c.memories.push({ id: '', text: saved.text, example: saved.example || '' }); renderMems(); });
  });
  // Import a document (SOP / naming guide) → AI extracts rules → confirm → add.
  $$('.ai-mem-import').addEventListener('click', () => showImportDialog((items) => {
    for (const it of items) c.memories.push({ id: '', text: it.text, example: it.example || '' });
    renderMems();
  }));
  // If feedback arrives while the dialog is open, reflect the new memories.
  memUnsub = window.api.onAiMemoryUpdated((p) => { if (p && Array.isArray(p.memories)) { c.memories = p.memories.map((m) => ({ ...m })); renderMems(); } });

  // Model store is now a popout (Engine → Browse models…), so it's not a nav pane.
  $$('.ai-browse-models').addEventListener('click', () => showModelStore({
    onUseVision: (name) => { c.model = name; refreshStatus(); },
    onUseReasoning: (name) => { c.textModel = name; refreshStatus(); },
    onChanged: () => refreshStatus()
  }));

  // Sidebar navigation.
  ov.querySelectorAll('.ai-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      ov.querySelectorAll('.ai-nav-item').forEach((b) => b.classList.toggle('active', b === btn));
      const target = btn.dataset.nav;
      ov.querySelectorAll('.ai-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== target));
    });
  });

  // Learn-my-style: choose a folder of already-named clips → propose style rules
  // (you confirm before they're added). Defaults to your Compressed folder.
  let learnDir = (cfg && cfg.finalizeSource) || '';
  const learnDirEl = $$('.ai-learn-dir');
  function showLearnDir() { learnDirEl.textContent = learnDir ? learnDir : 'Compressed folder (default)'; }
  showLearnDir();
  $$('.ai-learn-folder').addEventListener('click', async () => {
    const p = await window.api.pickFolder({ title: 'Choose a folder of named clips to learn from', defaultPath: learnDir });
    if (p) { learnDir = p; showLearnDir(); }
  });
  $$('.ai-learn-btn').addEventListener('click', async () => {
    const btn = $$('.ai-learn-btn'); const st = $$('.ai-learn-status');
    btn.disabled = true; st.classList.remove('hidden'); st.textContent = 'Reading your names and learning your style…';
    const r = await window.api.aiLearnNames(learnDir ? { dir: learnDir } : {});
    btn.disabled = false;
    if (!r || !r.ok) { st.textContent = `Couldn't learn: ${r ? r.error : 'unknown'}`; return; }
    st.textContent = `Read ${r.examples} of your names.`;
    if (!(r.proposed && r.proposed.length)) { st.textContent += ' No new rules to add — your style is already captured.'; return; }
    showProposedRulesDialog('Rules learned from your style', `From ${r.examples} of your own names. Tick the ones to remember.`, r.proposed, (mems) => { c.memories = mems.map((m) => ({ ...m })); renderMems(); });
  });
  // Tidy & group: consolidate many tiny memories into fewer grouped ones (confirm).
  $$('.ai-mem-tidy').addEventListener('click', async () => {
    const btn = $$('.ai-mem-tidy'); const old = btn.textContent; btn.disabled = true; btn.textContent = 'Grouping…';
    const r = await window.api.aiConsolidateMemories();
    btn.disabled = false; btn.textContent = old;
    if (!r || !r.ok) { showToast(`Couldn't group: ${r ? r.error : 'unknown'}`); return; }
    showProposedRulesDialog('Tidy & group memories', `This replaces your ${r.before} memories with these ${r.proposed.length} grouped ones. Tick to keep, then Apply.`,
      r.proposed, (mems) => { c.memories = mems.map((m) => ({ ...m })); renderMems(); }, { replace: true });
  });

  const statusEl = $$('.ai-status');
  const modelSel = createSelect({ value: c.model, placeholder: '(no models)', empty: '(no models)', style: 'min-width:200px;max-width:280px' });
  $$('.ai-model-mount').appendChild(modelSel.el);
  const textModelSel = createSelect({ value: c.textModel, placeholder: '(use vision model)', style: 'min-width:200px;max-width:280px' });
  $$('.ai-text-model-mount').appendChild(textModelSel.el);
  function fillTextModelSel(models) {
    const list = [{ value: '', label: '(use vision model)' }];
    for (const n of (models || [])) list.push({ value: n, label: n });
    if (c.textModel && !(models || []).includes(c.textModel)) list.push({ value: c.textModel, label: `${c.textModel} (saved)` });
    textModelSel.setOptions(list);
    textModelSel.value = c.textModel || '';
  }
  async function refreshStatus() {
    statusEl.textContent = 'Checking Ollama…';
    statusEl.className = 'ai-status';
    const s = await window.api.getAiStatus();
    if (!s || !s.running) {
      statusEl.innerHTML = `⚠ Ollama not reachable at <code>${escapeHtml(c.endpoint)}</code>. Install it from ollama.com, then it runs in the background.`;
      statusEl.classList.add('warn');
      modelSel.setOptions(c.model ? [{ value: c.model, label: `${c.model} (saved)` }] : []);
      modelSel.value = c.model || '';
      fillTextModelSel([]);
      return;
    }
    const vis = (s.vision && s.vision.length) ? s.vision : [];
    const list = vis.length ? vis : s.models;
    statusEl.innerHTML = vis.length
      ? `✓ Ollama running · ${vis.length} vision model${vis.length !== 1 ? 's' : ''} available`
      : '✓ Ollama running, but no vision model yet. Add one below (e.g. <code>qwen2.5vl:7b</code>).';
    statusEl.classList.add('ok');
    modelSel.setOptions(list.map((n) => ({ value: n, label: n + (vis.includes(n) ? '' : ' (text only?)') })));
    if (!c.model && list.length) c.model = list[0];
    modelSel.value = c.model || '';
    fillTextModelSel(s.models || list);   // reasoning model can be ANY installed model
  }
  modelSel.onChange((v) => { c.model = v; });
  textModelSel.onChange((v) => { c.textModel = v; });
  $$('.ai-refresh').addEventListener('click', refreshStatus);
  refreshStatus();
}

// Preferences — set the compression intake folder.
function showPreferences() {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  let pending = state.intakeFolder || '';
  const hkRows = HOTKEY_ACTIONS.map((a) =>
    `<div class="hk-row" data-row="${a.id}">
       <div class="hk-info">
         <span class="hk-name">${escapeHtml(a.label)}</span>
         <span class="hk-sub">${escapeHtml(a.desc || '')}</span>
       </div>
       <button type="button" class="hk-key" data-hk="${a.id}">${keycapsHtml(hotkeys[a.id])}</button>
       <button type="button" class="hk-reset" data-hk="${a.id}" title="Reset to default">⟲</button>
     </div>`
  ).join('');
  ov.innerHTML = `<div class="modal-card modal-form pref-modal">
    <h3>Preferences</h3>
    <p class="pref-intro muted small">Where footage is copied, and the shortcuts used while renaming.</p>

    <section class="pref-section">
      <div class="pref-sec-h"><span class="pref-sec-t">Intake folder</span></div>
      <div class="pref-body">
        <div class="pref-row">
          <input type="text" class="pref-path" readonly value="${escapeAttr(pending)}" />
          <button type="button" class="btn pref-browse">Browse…</button>
        </div>
        <p class="muted small pref-hint">Footage is copied here in the Upload step.</p>
      </div>
    </section>

    <section class="pref-section">
      <div class="pref-sec-h"><span class="pref-sec-t">Keyboard shortcuts</span><span class="pref-sec-sub muted small">Rename screen</span></div>
      <div class="pref-body">
        <p class="muted small pref-hint">Click a shortcut, then press your keys.</p>
        <div class="hk-list">${hkRows}</div>
      </div>
    </section>

    <section class="pref-section">
      <div class="pref-sec-h"><span class="pref-sec-t">Text shortcuts</span></div>
      <div class="pref-body">
        <p class="muted small pref-hint">Press a shortcut while typing in a field to insert its text. Use a modifier (Ctrl/Alt) so it won't clash with normal typing.</p>
        <div class="tm-list"></div>
        <button type="button" class="btn subtle tm-add">＋ Add text shortcut</button>
      </div>
    </section>

    <div class="modal-actions">
      <button type="button" class="btn primary pref-save">Save</button>
      <button type="button" class="btn pref-cancel">Cancel</button>
    </div></div>`;
  document.body.appendChild(ov);
  const close = () => { document.removeEventListener('keydown', onPrefKeydown, true); ov.remove(); };
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('.pref-cancel').addEventListener('click', close);
  ov.querySelector('.pref-browse').addEventListener('click', async () => {
    const p = await window.api.pickIntakeFolder();
    if (p) { pending = p; ov.querySelector('.pref-path').value = p; }
  });

  // --- key-capture state shared by action hotkeys + text shortcuts ---
  const pendingHotkeys = { ...hotkeys };
  const macros = (textMacros || []).map((m) => ({ key: m.key || '', text: m.text || '' }));
  let listening = null;     // hk-key button currently capturing
  let listeningMacro = -1;  // macro row index currently capturing
  const renderKey = (btn) => { btn.innerHTML = keycapsHtml(pendingHotkeys[btn.dataset.hk]); };
  const stopListening = () => {
    if (listening) { listening.classList.remove('listening'); renderKey(listening); listening = null; }
    if (listeningMacro >= 0) { listeningMacro = -1; renderMacros(); }
  };

  // Action hotkeys
  ov.querySelectorAll('.hk-key').forEach((btn) => {
    btn.addEventListener('click', () => {
      stopListening();
      listening = btn; btn.classList.add('listening');
      btn.innerHTML = '<span class="kc-listening">Press keys…</span>';
    });
  });
  ov.querySelectorAll('.hk-reset').forEach((btn) => {
    btn.addEventListener('click', () => {
      pendingHotkeys[btn.dataset.hk] = DEFAULT_HOTKEYS[btn.dataset.hk];
      const keyBtn = ov.querySelector(`.hk-key[data-hk="${btn.dataset.hk}"]`);
      if (keyBtn) { keyBtn.classList.remove('listening'); renderKey(keyBtn); }
    });
  });

  // Text shortcuts — dynamic, unlimited rows
  const tmList = ov.querySelector('.tm-list');
  function renderMacros() {
    tmList.innerHTML = '';
    if (!macros.length) {
      const empty = document.createElement('p');
      empty.className = 'muted small'; empty.textContent = 'No text shortcuts yet.';
      tmList.appendChild(empty);
    }
    macros.forEach((m, i) => {
      const row = document.createElement('div'); row.className = 'tm-row';
      const keyBtn = document.createElement('button');
      keyBtn.type = 'button';
      keyBtn.className = 'hk-key tm-key' + (i === listeningMacro ? ' listening' : '');
      keyBtn.innerHTML = (i === listeningMacro) ? '<span class="kc-listening">Press keys…</span>' : keycapsHtml(m.key);
      keyBtn.addEventListener('click', () => { stopListening(); listeningMacro = i; renderMacros(); });
      const txt = document.createElement('input');
      txt.type = 'text'; txt.className = 'tm-text'; txt.placeholder = 'text to insert'; txt.value = m.text;
      txt.addEventListener('input', () => { m.text = txt.value; });
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'hk-reset tm-del'; del.title = 'Remove'; del.textContent = '✕';
      del.addEventListener('click', () => { macros.splice(i, 1); if (listeningMacro === i) listeningMacro = -1; renderMacros(); });
      row.append(keyBtn, txt, del);
      tmList.appendChild(row);
    });
  }
  renderMacros();
  ov.querySelector('.tm-add').addEventListener('click', () => { macros.push({ key: '', text: '' }); renderMacros(); });

  // Unified key capture (action hotkey OR text-shortcut key). Attached at the
  // DOCUMENT level so it fires no matter where focus is — rebuilding a macro row
  // moves focus to <body>, which a listener on the modal would never catch.
  function onPrefKeydown(e) {
    if (!listening && listeningMacro < 0) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { stopListening(); return; }
    const key = eventToHotkey(e);
    if (!key) return;
    if (listening) {
      pendingHotkeys[listening.dataset.hk] = key;
      listening.classList.remove('listening'); renderKey(listening); listening = null;
    } else if (listeningMacro >= 0) {
      macros[listeningMacro].key = key; listeningMacro = -1; renderMacros();
    }
  }
  document.addEventListener('keydown', onPrefKeydown, true);

  ov.querySelector('.pref-save').addEventListener('click', async () => {
    const saved = await window.api.setIntake(pending);
    state.intakeFolder = saved;
    const line = document.getElementById('intakePathLine');
    if (line) line.textContent = saved;
    hotkeys = { ...hotkeys, ...pendingHotkeys };
    textMacros = macros.filter((m) => m.key && m.text);
    await window.api.setPrefs({ hotkeys, textMacros });
    close();
  });
}

// Edit subjects — manage the reusable subject history.
function showEditSubjects() {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card modal-form">
    <h3>Subjects</h3>
    <p class="muted small">Reusable subjects shown when naming clips.</p>
    <div class="subj-add">
      <input type="text" class="f-desc subj-new" placeholder="Add a subject…" autocomplete="off" />
      <button type="button" class="btn primary subj-add-btn">Add</button>
    </div>
    <ul class="subj-list"></ul>
    <div class="modal-actions"><button type="button" class="btn primary subj-done">Done</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('.subj-done').addEventListener('click', close);

  async function renderList() {
    const subs = await window.api.getSubjects();
    const list = ov.querySelector('.subj-list');
    list.innerHTML = subs.length ? '' : '<li class="muted small subj-empty">No subjects yet.</li>';
    for (const s of subs) {
      const li = document.createElement('li');
      li.className = 'subj-item';
      li.innerHTML = `<span>${escapeHtml(s)}</span><button type="button" class="btn ghost subj-del" title="Remove">✕</button>`;
      li.querySelector('.subj-del').addEventListener('click', async () => {
        await window.api.removeSubject(s);
        await renderList();
        await refreshSubjectOptions();
      });
      list.appendChild(li);
    }
  }
  async function add() {
    const inp = ov.querySelector('.subj-new');
    if (slug(inp.value)) { await rememberSubject(inp.value); inp.value = ''; await renderList(); }
  }
  ov.querySelector('.subj-add-btn').addEventListener('click', add);
  ov.querySelector('.subj-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  renderList();
}

// ---------------------------------------------------------------------------
// Navigation: back to the start screen + clickable step pills
// ---------------------------------------------------------------------------
// While a copy runs, confirm before navigating away from the transfer view
// (the copy keeps running in the background; the header chip brings you back).
async function confirmLeaveTransfer() {
  if (!copyInProgress) return true;
  return confirmDialog('Leave the transfer view?',
    'The copy keeps running in the background — use the “Copying…” chip to come back.',
    'Leave', 'Stay');
}

async function goHome() {
  if (!(await confirmLeaveTransfer())) return;
  closePopover();
  $('flow').classList.add('hidden');
  $('finalize').classList.add('hidden');
  $('phone').classList.add('hidden');
  $('actionList').classList.remove('hidden'); $('driveList').classList.remove('hidden');
  state.phoneBackup = false;
  if (state.drive) $('driveBanner').classList.remove('hidden');
  refreshDriveList();   // re-read removable drives when returning home
}

// ---------------------------------------------------------------------------
// Phone backup (MTP) — pull photos + videos off a plugged-in phone.
// ---------------------------------------------------------------------------
const phoneState = { device: null, media: [], filter: 'all', dest: '', copying: false };

async function openPhone(device) {
  closePopover();
  $('flow').classList.add('hidden');
  $('finalize').classList.add('hidden');
  $('actionList').classList.add('hidden'); $('driveList').classList.add('hidden');
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
  await phoneScanScoped();
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
  // Default-select only what hasn't been backed up before (shared import memory).
  phoneState.media = ((res && res.media) || []).map((m, i) => {
    const isNew = !importedSet.has(importKey({ name: m.name, size: m.size }));
    return { ...m, _i: i, _new: isNew, selected: isNew };
  });
  const total = phoneState.media.length;
  const newOnes = phoneState.media.filter((m) => m._new);
  const newN = newOnes.length;
  const newPh = newOnes.filter((m) => m.kind === 'photo').length;
  const newVid = newN - newPh;
  if (!total) {
    $('phNewSummary').textContent = 'Nothing here';
    $('phNewSub').textContent = 'No photos or videos in the selected album(s).';
  } else if (!newN) {
    $('phNewSummary').textContent = 'All backed up ✓';
    $('phNewSub').textContent = `${total} item${total !== 1 ? 's' : ''} here — all already backed up. Use Review to back any up again.`;
  } else {
    $('phNewSummary').textContent = `${newN} new to back up`;
    $('phNewSub').textContent = `${newPh} photo${newPh !== 1 ? 's' : ''} · ${newVid} video${newVid !== 1 ? 's' : ''} · ${total} in selection`;
  }
  $('phBackupNew').textContent = newN ? `Back up ${newN} new` : 'Nothing new';
  $('phBackupNew').disabled = !newN || phoneState.copying;
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
  const m = String(name || '').match(/(20\d{2})[-_]?(\d{2})[-_]?(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
function phoneRenderGrid() {
  const host = $('phGrid');
  const items = phoneState.media.filter((m) => phoneState.filter === 'all' || m.kind === phoneState.filter);
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
  const vis = phoneState.media.filter((m) => phoneState.filter === 'all' || m.kind === phoneState.filter);
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
  $('phCopyBar').style.width = '0%'; $('phCopyPct').textContent = '0%';
  $('phCopyLabel').textContent = nPho ? 'Copying photos → 04 - Photos Temp…' : 'Preparing videos…';
  $('phCopySub').textContent = nVid ? `${nVid} video${nVid !== 1 ? 's' : ''} stay on the device until you copy them out` : '';
  const items = sel.map((m) => ({ rel: m.rel, name: m.name, size: m.size, kind: m.kind, abs: m.abs }));
  // Register a persistent task so leaving the window and coming back still shows it (tap to return).
  setTask('phone', 'Backing up phone', 0, sel.length, 'preparing', '');
  const off = window.api.onPhoneCopyProgress((p) => {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    $('phCopyBar').style.width = `${pct}%`; $('phCopyPct').textContent = `${pct}%`;
    $('phCopyLabel').textContent = `Preparing… ${p.done}/${p.total}`;
    $('phCopySub').textContent = p.name || '';
    setTask('phone', 'Backing up phone', p.done || 0, p.total || sel.length, 'preparing', p.name || '');
  });
  let res;
  try { res = await window.api.pullFromPhone({ device: phoneState.device, items, photoDest: dests.photo, sim: phoneState.sim }); }
  catch (e) { res = { ok: false, error: e.message || String(e) }; }
  off();
  clearTask('phone');
  phoneState.copying = false;
  if (res && res.ok && Array.isArray(res.staged) && res.staged.length) {
    if (typeof pcNotify === 'function') pcNotify('Phone ready', `${nPho} photo${nPho !== 1 ? 's' : ''} in Photos Temp · ${nVid} video${nVid !== 1 ? 's' : ''} ready to name.`);
    enterRenameWithPhoneFiles(res.staged);
  } else {
    $('phCopyLabel').textContent = `Couldn’t prepare media${res && res.error ? `: ${res.error}` : ''}`;
    showToast(`Phone pull failed${res && res.error ? `: ${res.error}` : ''}`, 6000);
    phoneUpdateBar();
  }
}

// Load the staged local files into the rename flow as clips — so phone photos AND
// videos get the FULL treatment (AI naming, faces, tags) in the normal rename screen.
function enterRenameWithPhoneFiles(staged) {
  state.phoneBackup = true;
  state.scannedDrive = '__phone__';
  state.scannedFiles = staged.map((f) => {
    const clip = {
      ...f,
      origBase: f.name.slice(0, f.name.length - (f.ext || '').length),
      date: phoneDateOf(f.name) || toDateStr(f.mtimeMs),
      dateLocked: !!phoneDateOf(f.name),
      subject: '', description: '', version: 1, selected: false,
      isPhoto: f.kind === 'photo'
    };
    for (const fld of organizeFields) clip[fld.id] = '';
    return clip;
  });
  $('phone').classList.add('hidden');
  $('finalize').classList.add('hidden');
  $('actionList').classList.add('hidden'); $('driveList').classList.add('hidden');
  $('driveBanner').classList.add('hidden');
  $('flow').classList.remove('hidden');
  setStep(1);
  $('scanState').classList.add('hidden');
  buildRenameStep();
  showToast(`${state.scannedFiles.length} item${state.scannedFiles.length !== 1 ? 's' : ''} pulled off your phone — name them, then continue ✓`, 5000);
}

// Jump straight to the Name & copy (rename) flow from any screen.
async function goToRename() {
  closePopover();
  if (!state.scannedFiles || !state.scannedFiles.length) { showToast('Choose a drive first — then you can name & copy its clips'); return; }
  $('finalize').classList.add('hidden');
  $('actionList').classList.add('hidden'); $('driveList').classList.add('hidden');
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
    if (n === 1 && state.scannedFiles.length) buildRenameStep();
    else if (n === 2 && state.scannedFiles.length) buildUploadStep();
    else if (n === 3 && state.copied.length) buildDeleteStep();
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
  if (state.phoneBackup) $('copyStartBtn').textContent = 'Copy out';
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
  if (!state.phoneBackup && !photos) { if (box) box.remove(); return; }
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
    const pct = p.totalBytes ? Math.min(100, (p.copiedBytes / p.totalBytes) * 100) : 0;
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
  $('actionList').classList.add('hidden'); $('driveList').classList.add('hidden');
  $('driveBanner').classList.add('hidden');
  $('flow').classList.remove('hidden');
  setStep(2);
  $('fileList').innerHTML = '';
  showCopyingUI();
  subscribeProgress();
  updateCopyChip(status);
  if (status && status.totalBytes) {
    const pct = Math.min(100, (status.copiedBytes / status.totalBytes) * 100);
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
function buildPhotoJobs(photos, includePhotosTemp) {
  const jobs = [];
  const photosTemp = phoneStagingDests().photo.replace(/[\\/]+$/, '');
  const dests = [];
  if (cfg.phoneDestComputer && cfg.phoneComputerFolder) dests.push(cfg.phoneComputerFolder.replace(/[\\/]+$/, ''));
  if (cfg.phoneDestNas && cfg.phoneNasFolder) dests.push(cfg.phoneNasFolder.replace(/[\\/]+$/, ''));
  const projRoot = (organizeDest || (cfg && cfg.projectsRoot) || '').replace(/[\\/]+$/, '');
  let routedN = 0;
  for (const p of photos) {
    const fname = finalName(p);
    if (includePhotosTemp && photosTemp) jobs.push({ src: p.sourcePath, dest: `${photosTemp}\\${fname}` });
    for (const d of dests) jobs.push({ src: p.sourcePath, dest: `${d}\\${fname}` });
    if (projRoot) {
      const route = phoneRouteFor(p);
      if (route) { const sub = `${route.dest.replace(/\//g, '\\')}${route.byDay && p.date ? `\\${p.date}` : ''}`; jobs.push({ src: p.sourcePath, dest: `${projRoot}\\${sub}\\${fname}` }); routedN += 1; }
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
  let copied = 0;
  try { const r = await window.api.distributePhotos({ jobs }); copied = (r && r.copied) || 0; } catch { /* non-fatal */ }
  const names = [cfg.phoneDestComputer && cfg.phoneComputerFolder ? 'computer' : '', cfg.phoneDestNas && cfg.phoneNasFolder ? 'NAS' : ''].filter(Boolean).join(' + ') || 'Photos Temp';
  return `${photos.length} photo${photos.length !== 1 ? 's' : ''} → ${names}${routedN ? ` (${routedN} into Projects)` : ''}`;
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
  const jobs = vids.map((v) => ({ phoneRef: v.phoneRef || { sim: false, device: phoneState.device, rel: '', name: v.name, size: v.size }, dest: `${intake}\\${finalName(v)}` }));
  copyInProgress = true; showCopyingUI();
  $('copyBar').style.width = '0%'; $('copyPct').textContent = '0%';
  $('copyLabel').textContent = vids.length ? 'Copying videos → 01 - Uncompressed…' : 'Finishing…';
  $('copySub').textContent = '';
  setTask('phone-copy', 'Copying off phone', 0, jobs.length || 1, 'copying', '');
  const off = window.api.onPhoneCopyProgress((p) => {
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    $('copyBar').style.width = `${pct}%`; $('copyPct').textContent = `${pct}%`;
    $('copyLabel').textContent = `Copying videos… ${p.done}/${p.total}`;
    $('copySub').textContent = p.name || '';
    setTask('phone-copy', 'Copying off phone', p.done || 0, p.total || jobs.length || 1, 'copying', p.name || '');
  });
  let res = { ok: true, copied: 0 };
  if (jobs.length) { try { res = await window.api.copyPhoneVideos({ jobs }); } catch (e) { res = { ok: false, error: e.message }; } }

  // Distribute the renamed PHOTOS (already in Photos Temp) to computer/NAS + Projects.
  const { jobs: pjobs, dests, routedN } = buildPhotoJobs(photos, false);
  let distributed = 0;
  if (pjobs.length) {
    $('copyLabel').textContent = 'Backing up photos…'; $('copySub').textContent = '';
    try { const r2 = await window.api.distributePhotos({ jobs: pjobs }); distributed = (r2 && r2.copied) || 0; } catch { /* non-fatal */ }
  }
  off(); clearTask('phone-copy'); copyInProgress = false; hideCopyChip();
  // Remember what we just backed up (by original phone name+size) so next time the
  // smart chooser knows it's no longer "new" — this is what makes "Back up new" work
  // across sessions. Shared with the card import index.
  try {
    const keys = state.scannedFiles.map((c) => importKey({ name: c.name, size: c.size }));
    if (keys.length) { window.api.importsAdd(keys); keys.forEach((k) => importedSet.add(k)); }
  } catch { /* non-fatal */ }
  $('copyBar').style.width = '100%'; $('copyPct').textContent = '100%';
  const destNames = [cfg.phoneDestComputer && cfg.phoneComputerFolder ? 'computer' : '', cfg.phoneDestNas && cfg.phoneNasFolder ? 'NAS' : ''].filter(Boolean).join(' + ');
  const routedNote = routedN ? ` (${routedN} also filed into Projects)` : '';
  const photoLine = (dests.length || routedN) ? `${distributed} photo cop${distributed !== 1 ? 'ies' : 'y'} → ${destNames || 'Projects'}${routedNote}` : `${photos.length} photo${photos.length !== 1 ? 's' : ''} in 04 - Photos Temp`;
  const failNote = (res && res.failed) ? ` · ⚠ ${res.failed} couldn’t be verified (kept on phone — try again)` : ' (verified)';
  showDone(`${res.copied || 0} video${(res.copied || 0) !== 1 ? 's' : ''} → 01 - Uncompressed${failNote} · ${photoLine}. Compress the videos, then Organize & back up.`);
  if (typeof pcNotify === 'function') pcNotify('Phone backup', `${res.copied || 0} videos staged${res && res.failed ? ` · ${res.failed} failed` : ''} · ${photoLine}.`);
}

async function runCopy() {
  if (state.phoneBackup) return runPhoneCopy();
  maybeFlushEdits(true);   // learn from any AI-name edits before this batch leaves
  const clips = filesToCopy();
  const files = clips.map((f) => ({
    sourcePath: f.sourcePath, name: f.name, ext: f.ext, size: f.size, newName: finalStem(f)
  }));
  if (!files.length) {
    // Photos-only card (no video) → just back up the photos.
    if (clipPhotos().length) { const s = await distributeFlowPhotos(); showDone(s || 'Photos backed up'); }
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
  const res = await window.api.startCopy(files, state.intakeFolder);
  copyInProgress = false;
  unsubscribeProgress();
  hideCopyChip();

  if (res && res.cancelled) {
    buildUploadStep();
    $('copyLabel').textContent = 'Copy cancelled';
    return;
  }
  if (!res || !res.ok) {
    if (!(res && res.cancelled)) logIssue('Copy', (res && res.error) || 'unknown error');
    $('copyLabel').textContent = `Copy failed: ${res ? res.error : 'unknown error'}`;
    $('copyStartBtn').classList.remove('hidden');
    $('copyStartBtn').disabled = false;
    $('cancelCopyBtn').classList.add('hidden');
    $('backToRenameBtn').disabled = false;
    return;
  }
  if (res.nas && res.nas.failed) logIssue('NAS backup', `${res.nas.failed} file(s) failed to back up to NAS`);
  state.copied = res.copied;
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
    window.api.clearDrafts(verifiedClips.map((f) => `${f.name}__${f.size}`));
  } catch { /* non-fatal */ }
  // Back up any photos on the card alongside the videos.
  const photoSummary = await distributeFlowPhotos();
  const vnote = vres.fail ? ` · ⚠ ${vres.fail} failed verification` : ' · all verified ✓';
  $('copyLabel').textContent = (photoSummary ? `Copy complete · ${photoSummary}` : 'Copy complete') + vnote;
  $('copyBar').style.width = '100%';
  $('copyPct').textContent = '100%';
  // Auto-analyze the copied footage in the BACKGROUND (if AI is on) so it's already
  // analyzed by the time you organize — then re-save its metadata. Fire-and-forget.
  if (aiReady() && uiPrefs.autoAnalyzeAfterCopy !== false) autoAnalyzeAfterCopyRun(clips);
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
  try { results = await window.api.verifyCopies(state.copied.map((c) => ({ source: c.sourcePath, dest: c.destPath }))); }
  catch { results = []; }
  const bySrc = {}; results.forEach((r) => { if (r) bySrc[r.source] = r; });
  let ok = 0; let fail = 0;
  for (const c of state.copied) { const v = bySrc[c.sourcePath]; c._verified = !!(v && v.ok); c._verifyReason = (v && v.reason) || ''; if (c._verified) ok += 1; else { fail += 1; logIssue('Copy verify', `${c.name}: ${c._verifyReason || 'mismatch'}`); } }
  state.copyVerify = { ok, fail };
  if (fail) showToast(`⚠ ${fail} file${fail !== 1 ? 's' : ''} didn’t copy correctly — re-copy before clearing the card`, 7000);
  return { ok, fail };
}
// Persist each clip's full metadata keyed by its final filename (carry-forward to
// Organize). Called after copy and again after background analysis enriches it.
function saveFlowFinalMeta(clips) {
  const map = {};
  for (const clip of clips) {
    const rec = {
      subject: clip.subject || '', description: clip.description || '', date: clip.date || '',
      location: clip.location || '', context: clip.context || '',
      shotType: clip.shotType || '', observation: clip.observation || '',
      people: Array.isArray(clip.people) ? clip.people : []
    };
    for (const fld of organizeFields) rec[fld.id] = clip[fld.id] || '';
    rec.tags = Array.isArray(clip.tags) ? clip.tags : [];
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
  const obsOf = (c) => (c.observation && c.observation.trim()) || (clipObsCache[clipKey(c)] && clipObsCache[clipKey(c)].obs) || '';
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
  for (const c of reps) {
    if (aiAborted) break;
    const i = state.scannedFiles.indexOf(c);
    setTask('ai', aiModelLabel(), done + 1, reps.length, 'analyzing', c.name);
    aiStageAdvance(c, 'analyzing');
    try { if (i >= 0) await aiSuggestClip(i, 'empty', { quiet: true }); } catch { /* keep going */ }
    if (sample) {
      const obs = obsOf(c);
      for (const sib of (groups[key(c)] || [])) { if (sib !== c && obs && !obsOf(sib)) { sib.observation = obs; try { clipObsCache[clipKey(sib)] = { obs, ts: Date.now() }; window.api.saveClipObs({ key: clipKey(sib), obs }); } catch { /* ignore */ } } }
    }
    done += 1;
  }
  clearTask('ai'); aiStageClose();
  saveFlowFinalMeta(clips);   // re-save so Organize gets the new observations/people
  autoAnalyzeRunning = false;
  if (!aiAborted) showToast('Footage analyzed — it’ll place itself correctly when you organize ✓', 4000);
}

$('cancelCopyBtn').addEventListener('click', async () => {
  const ok = await confirmDialog('Cancel the copy?', 'Files already copied stay in the intake folder.', 'Cancel copy', 'Keep copying');
  if (!ok) return;
  $('cancelCopyBtn').disabled = true;
  $('cancelCopyBtn').textContent = 'Cancelling…';
  await window.api.cancelCopy();
});

// ---------------------------------------------------------------------------
// Copy status chip (header) + generic confirm dialog
// ---------------------------------------------------------------------------
function updateCopyChip(p) {
  if (!p) { hideCopyChip(); return; }
  if (p.phase === 'done' || p.phase === 'cancelled' || p.active === false) { hideCopyChip(); return; }
  const pct = p.totalBytes ? Math.min(100, (p.copiedBytes / p.totalBytes) * 100) : 0;
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
  const fill = $('reclaimFill'); if (fill) fill.style.width = `${total ? Math.min(100, (bytes / total) * 100) : 0}%`;
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
    try { verify = await window.api.verifyCopies(toCheck.map((i) => ({ source: state.copied[i].sourcePath, dest: state.copied[i].destPath }))); }
    catch { verify = []; }
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
  const paths = verifiedIdx.map((i) => state.copied[i].sourcePath);
  btn.disabled = true; btn.textContent = 'Deleting…';
  const results = await window.api.deleteSource(paths);
  const okCount = results.filter((r) => r.ok).length;
  const delFail = results.length - okCount;
  let msg = `Copied ${state.copied.length} clip${state.copied.length > 1 ? 's' : ''} to intake · ${okCount} verified & removed from card`;
  if (delFail) msg += ` · ${delFail} couldn’t be deleted`;
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
function renderFinMap() {
  const host = $('finMapHost'); if (!host) return;
  const sel = (finSelected().length ? finSelected() : finMatched());
  if (!sel.length) { host.innerHTML = '<p class="muted small">No matched clips — go back to the Match step and tick some.</p>'; return; }
  showDestinationMap(sel.map((f) => ({ name: f.name, sourcePath: f.sourcePath, subject: f.meta && f.meta.subject, description: f.meta && f.meta.description, location: f.meta && f.meta.location, date: f.meta && f.meta.date, people: (f.meta && f.meta.people) || [], shotType: f.meta && f.meta.shotType, tags: (f.meta && f.meta.tags) || [], _ref: f })), {
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
  $('actionList').classList.add('hidden'); $('driveList').classList.add('hidden');
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
  const res = await window.api.finalizeScan(finScan.dir, { includePhotos: !!uiPrefs.finalizePhotos });
  $('finScanState').classList.add('hidden');
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
  const faceClusters = []; const faceAutoByName = new Map();
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
      if (r.observation) { f.meta.observation = r.observation; try { clipObsCache[clipKey(f)] = { obs: r.observation, ts: Date.now() }; window.api.saveClipObs({ key: clipKey(f), obs: r.observation }); } catch { /* non-fatal */ } }
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
      if (fill) fill.style.width = `${p.pct || 0}%`;
      if (stat) {
        if (p.phase === 'done') stat.innerHTML = `<span class="cmp-ok">✓ ${p.inBytes && p.outBytes ? `−${Math.max(0, Math.round((1 - p.outBytes / p.inBytes) * 100))}%` : 'done'}</span>`;
        else if (p.phase === 'skipped') stat.innerHTML = '<span class="muted small">already done</span>';
        else if (p.phase === 'error') stat.innerHTML = `<span class="cmp-err" title="${escapeHtml(p.error || '')}">failed</span>`;
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
// Smart chooser actions
$('phBackupNew').addEventListener('click', () => {
  phoneState.media.forEach((m) => { m.selected = !!m._new; });   // back up only what's new
  phoneCopy();
});
$('phReview').addEventListener('click', phoneEnterReview);
$('phSelectAll').addEventListener('change', (e) => {
  // Toggle only the currently-visible (filtered) media, not hidden items.
  const vis = phoneState.media.filter((m) => phoneState.filter === 'all' || m.kind === phoneState.filter);
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
