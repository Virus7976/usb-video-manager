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
    html += `</div><div class="cal-foot"><button type="button" class="cal-today">Today</button>${currentStr ? '<button type="button" class="cal-clear">Clear date</button>' : ''}</div>`;
    cal.innerHTML = html;
    cal.querySelector('.cal-prev').onclick = () => { vm -= 1; if (vm < 0) { vm = 11; vy -= 1; } render(); };
    cal.querySelector('.cal-next').onclick = () => { vm += 1; if (vm > 11) { vm = 0; vy += 1; } render(); };
    cal.querySelector('.cal-title').onclick = () => { mode = 'month'; render(); };
    cal.querySelector('.cal-today').onclick = () => { onPick(toDateStr(Date.now())); closePopover(); };
    const clr = cal.querySelector('.cal-clear');   // clearing was impossible before — needed a version restore
    if (clr) clr.onclick = () => { onPick(''); closePopover(); };
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
    // The user CHOSE this date — drop the auto flag so updateBatchBar stops managing the field and
    // never clears or overwrites their choice.
    delete $('batchDate').dataset.auto;
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
    { label: 'Phone backup folder (wireless)…', action: () => pickPhoneBackupFolder() },
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
        { label: 'Scan faces on selected clips', desc: 'Just find the faces in the ticked clips and open the review to name them — no vision naming, no descriptions.', action: scanFacesSelected },
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
    { label: "What's new…", action: showChangelog },
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

// Resolve a value that may be a function (label/checked/header/submenu can each be lazy).
const val = (v) => (typeof v === 'function' ? v() : v);

// One flyout SUBMENU builder shared by the menu bar (openMenu) and the right-click
// context menu (showContextMenu). It renders the SUPERSET of both callers' item features
// — sep, header, desc (two-line), danger, disabled, check/radio marks — which stays
// behavior-identical for each caller because menu-bar submenu items never set
// danger/disabled and context items never set header/desc. Positions the sub as a fixed
// body child hugging `menuEl`'s right edge, and returns the element so the caller can
// track it as its own activeSub. Hover in/out is wired to the caller's close-timer.
function buildSubmenuFlyout(opts, anchorBtn, menuEl, cancelCloseSub, scheduleCloseSub) {
  const sub = document.createElement('div');
  sub.className = 'flyout dropdown-menu submenu';
  sub.dataset.for = anchorBtn.dataset.key || '';
  const subHasChecks = opts.some((o) => o.type === 'check');   // toggle list → show ✓ column
  for (const o of opts) {
    if (o.sep) { const s = document.createElement('div'); s.className = 'flyout-sep'; sub.appendChild(s); continue; }
    if (o.header) { const h = document.createElement('div'); h.className = 'flyout-header'; h.textContent = val(o.header); sub.appendChild(h); continue; }
    const oc = val(o.checked);
    const si = document.createElement('button');
    // Check-type items show a ✓ column; radio-style items (speed/date) stay highlighted.
    si.className = 'flyout-item' + (o.type !== 'check' && oc ? ' selected' : '') + (o.desc ? ' has-desc' : '') + (o.danger ? ' danger' : '') + (o.disabled ? ' disabled' : '');
    let inner = '';
    if (subHasChecks) inner += `<span class="flyout-check">${o.type === 'check' && oc ? '✓' : ''}</span>`;
    // A `desc` gives the item a second muted line explaining what it does — used to
    // disambiguate similar AI actions (analyze vs improve vs auto-name).
    inner += o.desc
      ? `<span class="flyout-stack"><span class="flyout-label">${escapeHtml(val(o.label))}</span><span class="flyout-desc">${escapeHtml(val(o.desc))}</span></span>`
      : `<span class="flyout-label">${escapeHtml(val(o.label))}</span>`;
    si.innerHTML = inner;
    if (!o.disabled) si.addEventListener('click', () => { closePopover(); if (o.action) o.action(); });
    sub.appendChild(si);
  }
  sub.addEventListener('mouseenter', cancelCloseSub);
  sub.addEventListener('mouseleave', scheduleCloseSub);
  sub.style.position = 'fixed';
  sub.style.visibility = 'hidden';
  // Append to <body>, NOT the menu: the menu's backdrop-filter makes it the containing
  // block for fixed children (breaking viewport coords) and nesting backdrop-filter
  // renders see-through. Body keeps it aligned + opaque.
  document.body.appendChild(sub);
  const mr = menuEl.getBoundingClientRect();
  const r = anchorBtn.getBoundingClientRect();
  const sr = sub.getBoundingClientRect();
  let left = mr.right - 3;               // hug the menu's right edge (slight overlap bridges hover)
  if (left + sr.width > window.innerWidth - 8) left = mr.left - sr.width + 3;
  let top = r.top - 5;
  if (top + sr.height > window.innerHeight - 8) top = window.innerHeight - sr.height - 8;
  sub.style.left = `${Math.max(8, left)}px`;
  sub.style.top = `${Math.max(8, top)}px`;
  sub.style.visibility = 'visible';
  return sub;
}

function openMenu(trigger) {
  const items = MENUS[trigger.dataset.menu] || [];
  const hasChecks = items.some((it) => it.type === 'check');
  const menu = document.createElement('div');
  menu.className = 'flyout menu-flyout';
  let activeSub = null;
  let subTimer = null;
  const closeSub = () => { if (activeSub) { activeSub.remove(); activeSub = null; } };
  const scheduleCloseSub = () => { clearTimeout(subTimer); subTimer = setTimeout(closeSub, 600); };
  const cancelCloseSub = () => clearTimeout(subTimer);

  function openSubmenu(anchorBtn, item) {
    cancelCloseSub();
    if (activeSub && activeSub.dataset.for === anchorBtn.dataset.key) return; // already open
    closeSub();
    const opts = (val(item.submenu) || []).filter(Boolean);
    activeSub = buildSubmenuFlyout(opts, anchorBtn, menu, cancelCloseSub, scheduleCloseSub);
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
  const scheduleCloseSub = () => { clearTimeout(subTimer); subTimer = setTimeout(closeSub, 600); };
  const cancelCloseSub = () => clearTimeout(subTimer);
  function openSub(anchorBtn, item) {
    cancelCloseSub();
    if (activeSub && activeSub.dataset.for === anchorBtn.dataset.key) return;
    closeSub();
    const opts = (val(item.submenu) || []).filter(Boolean);
    activeSub = buildSubmenuFlyout(opts, anchorBtn, menu, cancelCloseSub, scheduleCloseSub);
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
    aiOn
      ? { label: 'AI', submenu: () => [
        { label: 'Run AI on this clip', action: () => runAiOnClip(i) },
        { label: 'Analyze selected clips', action: aiAnalyzeSelected },
        { label: 'Improve descriptions (use all data)', action: aiImproveSelected },
        { sep: true },
        { label: 'Scan faces on selected clips', action: scanFacesSelected },
        { label: 'AI settings…', action: showAiSettings },
        { label: 'People & faces…', action: showPeopleManager }
      ] }
      : { label: 'Turn on AI…', action: () => requireAi() },   // was a dead, greyed-out submenu
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
    { label: 'Find & replace…', action: () => showFindReplace() },
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
      { label: 'Scan faces on selected clips', action: scanFacesSelected },
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
function selectAllClips(on) {
  // Batch: set state for ALL clips, then touch only the DOM cards that exist (windowed)
  // and refresh the bar ONCE. (Calling setClipSelected per clip re-ran updateBatchBar +
  // rebuilt a growing checked-strip ~n times = O(n²) → froze/crashed on a 3000-clip roll.)
  // RESPECT THE FILTER — same rule the batch-bar select already follows: a bulk edit must never reach
  // a clip the user can't see (filtering to "Unnamed" then Select-All + Apply overwrote finished clips).
  const scoped = typeof clipFilterActive === 'function' && clipFilterActive();
  (state.scannedFiles || []).forEach((c) => { if (scoped && !clipMatchesFilter(c)) return; c.selected = on; });
  document.querySelectorAll('#renameList .rename-card').forEach((card) => {
    const c = state.scannedFiles[Number(card.dataset.i)];
    if (scoped && !clipMatchesFilter(c)) return;
    const cb = card.querySelector('.clip-check'); if (cb) cb.checked = on;
    card.classList.toggle('selected', on);
  });
  updateBatchBar();
}
function invertClipSelection() {
  // Batch (like selectAllClips) — per-clip setClipSelected re-ran updateBatchBar+strip
  // once per clip = O(n²) freeze on big rolls. Respects the filter (see selectAllClips).
  const scoped = typeof clipFilterActive === 'function' && clipFilterActive();
  (state.scannedFiles || []).forEach((c) => { if (scoped && !clipMatchesFilter(c)) return; c.selected = !c.selected; });
  document.querySelectorAll('#renameList .rename-card').forEach((card) => {
    const i = Number(card.dataset.i); const on = !!(state.scannedFiles[i] && state.scannedFiles[i].selected);
    const cb = card.querySelector('.clip-check'); if (cb) cb.checked = on;
    card.classList.toggle('selected', on);
  });
  updateBatchBar();
}

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
    { label: 'AI: Scan faces on selected clips', hint: 'ai', run: scanFacesSelected },
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
    // scroll-reset-ok: this list is the RESULT OF A QUERY. Typing a new filter should land you on
    // match #1, not at whatever offset the previous result set happened to leave behind.
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
    // Every bind/clear click re-renders the entire list — preserve the reading position.
    const keepTop = list.scrollTop;
    list.innerHTML = `<div class="ksc-sec">Editable</div>${rows}<div class="ksc-sec">Built-in</div>${fixedRows}`;
    list.scrollTop = keepTop;
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
    { ic: '📶', title: 'Pair phone (Wi-Fi)', sub: 'Scan a QR to back up your phone with no cable', go: () => showWirelessPairModal() },
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
    ai: { enabled: !!(aiCfg && aiCfg.enabled), endpoint: (aiCfg && aiCfg.endpoint) || DEFAULT_OLLAMA_ENDPOINT, model: (aiCfg && aiCfg.model) || '', touched: false },
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
// "What's new" — the changelog, in the app. Renders a deliberately SMALL subset of markdown:
// headings, bullets, `code`, **bold**, *italic*. Everything is escaped FIRST and the inline rules
// are applied to escaped text, so no changelog content can inject markup — this renderer runs
// webSecurity:false, so that ordering is not optional.
function renderChangelogMarkdown(md) {
  const out = [];
  let inList = false;
  const inline = (s) => escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    // Keep-a-Changelog links are noise in a dialog — show the text, drop the target.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length} class="cl-h cl-h${h[1].length}">${inline(h[2])}</h${h[1].length}>`); continue; }
    if (li) { if (!inList) { out.push('<ul class="cl-list">'); inList = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    out.push(`<p class="cl-p">${inline(line)}</p>`);
  }
  closeList();
  return out.join('');
}
async function showChangelog() {
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card modal-form" style="width:min(720px,94vw);max-height:84vh;display:flex;flex-direction:column">
    <div class="ai-hd"><span class="ai-hd-icon">📝</span><div class="ai-hd-text"><h3>What's new</h3><p class="muted small cl-sub">Loading…</p></div></div>
    <div class="cl-body"><div class="muted small" style="padding:24px;text-align:center">Loading…</div></div>
    <div class="modal-actions"><button type="button" class="btn primary cl-close">Close</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('.cl-close').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  const body = ov.querySelector('.cl-body');
  const sub = ov.querySelector('.cl-sub');
  // IPC can reject; without the catch the dialog would sit on "Loading…" forever with no clue why.
  try {
    const r = await window.api.changelog();
    if (r && r.ok) {
      body.innerHTML = renderChangelogMarkdown(r.text);
      sub.textContent = r.version ? `You're on v${r.version}. Newest changes first.` : 'Newest changes first.';
    } else {
      body.innerHTML = `<div class="muted small" style="padding:24px;text-align:center">Couldn't read the changelog${r && r.error ? ` — ${escapeHtml(r.error)}` : ''}.</div>`;
      sub.textContent = '';
    }
  } catch (e) {
    body.innerHTML = `<div class="muted small" style="padding:24px;text-align:center">Couldn't read the changelog — ${escapeHtml((e && e.message) || String(e))}.</div>`;
    sub.textContent = '';
    logIssue('UI', `Changelog failed to load: ${(e && e.message) || e}`);
  }
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
    <p class="muted small">Version ${escapeHtml(appVersionStr || '—')}</p>
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
    // Adding/removing/reordering a field re-renders the list; keep the user where they were.
    const keepTop = listEl.scrollTop;
    setTimeout(() => { listEl.scrollTop = keepTop; }, 0);
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

// Find & replace across names (audit #73). Live preview before anything changes: on a corpus this
// size "replace across 400 clips" is not something to run blind, and the count is the only honest
// way to tell the user what they're about to do.
function showFindReplace() {
  const fields = frTargetFields();
  const ov = document.createElement('div'); ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card modal-form" style="width:min(560px,94vw)">
    <div class="ai-hd"><span class="ai-hd-icon">🔤</span><div class="ai-hd-text"><h3>Find &amp; replace</h3><p class="muted small">Across the names you've given clips — never the files on disk.</p></div></div>
    <div class="pref-section">
      <label class="pref-sec-t" for="frFind">Find</label>
      <div class="pref-body"><input id="frFind" type="text" class="txt" autocomplete="off" placeholder="e.g. mowwing"></div>
      <label class="pref-sec-t" for="frRepl">Replace with</label>
      <div class="pref-body"><input id="frRepl" type="text" class="txt" autocomplete="off" placeholder="e.g. mowing"></div>
      <div class="pref-sec-t">In</div>
      <div class="pref-body fr-fields">${fields.map((f) => `<label class="fr-chk"><input type="checkbox" data-fld="${escapeAttr(f.id)}"${f.id === 'subject' || f.id === 'description' ? ' checked' : ''}> ${escapeHtml(f.label)}</label>`).join('')}</div>
      <div class="pref-body fr-opts">
        <label class="fr-chk"><input type="checkbox" id="frSel"> Only ticked clips</label>
        <label class="fr-chk"><input type="checkbox" id="frCase"> Match case</label>
        <label class="fr-chk"><input type="checkbox" id="frWord"> Whole word</label>
      </div>
    </div>
    <p class="muted small fr-preview" aria-live="polite">Type something to find.</p>
    <div class="modal-actions"><button type="button" class="btn fr-cancel">Cancel</button><button type="button" class="btn primary fr-go" disabled>Replace</button></div>
  </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  const q = (s) => ov.querySelector(s);
  const opts = () => ({
    fields: [...ov.querySelectorAll('[data-fld]')].filter((c) => c.checked).map((c) => c.dataset.fld),
    selectedOnly: q('#frSel').checked, matchCase: q('#frCase').checked, wholeWord: q('#frWord').checked,
  });
  const preview = () => {
    const find = q('#frFind').value;
    const o = opts();
    if (!find || !o.fields.length) {
      q('.fr-preview').textContent = find ? 'Pick at least one field.' : 'Type something to find.';
      q('.fr-go').disabled = true; return;
    }
    const { clips, hits } = frMatches(find, o);
    q('.fr-preview').textContent = clips.length
      ? `${hits} match${hits !== 1 ? 'es' : ''} in ${clips.length} clip${clips.length !== 1 ? 's' : ''}.`
      : 'No matches.';
    q('.fr-go').disabled = !clips.length;
  };
  ov.addEventListener('input', preview);
  ov.addEventListener('change', preview);
  q('.fr-cancel').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  // withBusyBtn: applyFindReplace awaits saveVersionPoint, which can reject — without it a failure
  // would leave the button stuck on "Replacing…" for the session (the async-cleanup rule).
  q('.fr-go').addEventListener('click', () => {
    const find = q('#frFind').value; const repl = q('#frRepl').value;
    withBusyBtn(q('.fr-go'), 'Replacing…', async () => {
      const n = await applyFindReplace(find, repl, opts());
      close();
      showToast(n ? `Replaced in ${n} clip${n !== 1 ? 's' : ''} — undo from History if that wasn't right` : 'Nothing to replace', 4500);
    });
  });
  setTimeout(() => { try { q('#frFind').focus(); } catch { /* ignore */ } }, 0);
}
