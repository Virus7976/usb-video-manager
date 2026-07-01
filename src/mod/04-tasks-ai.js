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
  // A real, prominent determinate bar (fills + surges) so "how much is left" is obvious.
  const bar = $('ttBar'); const fill = $('ttBarFill'); const pctEl = $('ttBarPct');
  const pctMain = pt.total ? Math.round((pt.current / pt.total) * 100) : 0;
  if (bar && fill) { bar.classList.remove('hidden'); fill.style.width = `${pctMain}%`; if (pctEl) pctEl.textContent = `${pctMain}%`; }
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
      { v: 'refine', t: 'Improve my notes', d: 'use my subject/description/location as context' },
      { v: 'empty', t: 'Only name blank clips', d: 'leave anything I already typed' },
      { v: 'all', t: 'Start over', d: 'ignore what\'s there and name from scratch' }
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
    showToast(r && r.ok ? 'Feedback saved ✓' : `Couldn’t save: ${r ? r.error : 'please try again'}`);
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
    else status.textContent = `Couldn't save: ${r ? r.error : 'please try again'}`;
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
    if (!requireAi()) return;
    original = { text: q('.me-text').value, example: q('.me-eg').value };
    const btn = q('.me-refine'); btn.disabled = true; q('.me-status').textContent = 'Refining…';
    const r = await window.api.aiRefineMemory(text);
    btn.disabled = false;
    if (r && r.ok) { q('.me-text').value = r.text; if (r.example) q('.me-eg').value = r.example; q('.me-status').textContent = 'Refined ✓'; q('.me-revert').classList.remove('hidden'); }
    else { q('.me-status').textContent = `Couldn’t refine: ${r ? r.error : 'please try again'}`; }
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
    else showToast(`Couldn't apply: ${r ? r.error : 'please try again'}`);
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
    if (!requireAi()) return;
    const text = q('.imp-text').value.trim();
    const path = ov.dataset.path || '';
    if (!text && !path) { showToast('Paste notes or choose a file'); return; }
    const btn = q('.imp-extract'); btn.disabled = true; q('.imp-status').textContent = 'Reading & extracting…';
    const r = await window.api.aiImportDoc(text ? { text } : { path });
    btn.disabled = false;
    if (!r || !r.ok) { q('.imp-status').textContent = `Couldn’t extract: ${r ? r.error : 'please try again'}`; return; }
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
    else showToast(`Couldn't add: ${r ? r.error : 'please try again'}`);
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
    } else showToast(`Couldn't save feedback: ${r ? r.error : 'please try again'}`);
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

