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
  else if (id === 'ai') {
    aiAborted = true;
    // Abort the request that is ACTUALLY in flight (audit #78). The flag alone is only checked
    // between clips, so Cancel used to sit at "Cancelling…" for the rest of the current call —
    // up to 180 s for a vision pass, or the whole tool loop for naming.
    try { window.api.aiCancel(); } catch { /* main may already be gone */ }
    showToast('Cancelling AI…', 3000);
  }
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
  aiStageEl.querySelector('.aist-fill').style.width = `${pctOf(cur, total)}%`;
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
  // THE one real signal in the whole learning system: the user looked at what the AI wrote and
  // decided it was wrong. Mark the clip, so "learn from this analysis" can tell the difference
  // between a name the USER chose and a name the AI simply produced — see reflectFromClips.
  clip._userNamed = true;
  aiEdits.push({ field, from, to });
  clip[key] = '';             // record this correction only once

  // …and keep the NAME HE TYPED, not just a rule distilled from it. Until now this correction went
  // off to the model to be turned into an English rule and the pair itself was dropped — so the
  // few-shot examples could only ever come from mining old filenames, and the app never actually
  // showed the model the thing he had just told it. It is one pair, so both fields are read from the
  // clip (this fires BEFORE the assignment at the call sites — hence `to` for the field in hand).
  const pair = {
    subject: field === 'subject' ? to : (clip.subject || ''),
    description: field === 'description' ? to : (clip.description || ''),
  };
  if (pair.subject && pair.description) {
    // Fire-and-forget: an unreachable main process must never block the user typing a name.
    Promise.resolve(window.api.aiRecordStyleCorrection(pair)).catch(() => {});
  }
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
        // Only claim it learned if it actually did. The toast used to sit OUTSIDE this try while the
        // in-memory push sat inside it, so a rejection lost the lot — disk AND memory — and still
        // congratulated the user. This is the headline learning feature: a false ✓ here means he
        // stops correcting and the AI keeps making the same mistake.
        let learned = false;
        try {
          const rr = await window.api.aiAddMemories(notes);
          learned = !(rr && rr.ok === false);
        } catch (e) { learned = false; logIssue('AI', `Couldn’t save what the AI learned: ${(e && e.message) || e}`); }
        if (learned) {
          // Keep the in-memory list in step only when the write stuck, so the two cannot diverge.
          if (!Array.isArray(aiCfg.memories)) aiCfg.memories = [];
          aiCfg.memories.push(...notes);
          showToast(`🧠 AI learned ${notes.length} thing${notes.length !== 1 ? 's' : ''} from your edits`);
        } else {
          showToast('The AI couldn’t save what it learned from your edits', 6000);
          logIssue('AI', `aiAddMemories did not persist ${notes.length} note(s) from edits`);
        }
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
  saveAiQuestions();
}
function resolveAiQuestion(id) {
  const q = aiQuestions.find((x) => x.id === id);
  if (!q) return;
  aiQuestions = aiQuestions.filter((x) => x.id !== id);
  if ((q.type === 'subject' || q.type === 'category') && typeof q.clipIndex === 'number'
      && !aiQuestions.some((x) => x.clipIndex === q.clipIndex)) markClipQuestion(q.clipIndex, false);
  renderAiHazard();
  saveAiQuestions();
}

// --- the review queue survives a restart -------------------------------------------------
//
// aiQuestions was pure memory. The AI would finish 100 clips with "Ask me to confirm" on, and
// quitting before you got to the review lost every one of them: the names stayed, but the review
// pass you were about to do was simply gone, with nothing to tell you it had existed.
//
// Persisted by clipKey (name__size), NEVER by clipIndex. An index is a position in
// state.scannedFiles — it does not survive a rescan, and restoring by index would silently
// re-attach "is this a new category?" to a completely different clip.
function saveAiQuestions() {
  try {
    window.api.saveAiQueue(aiQuestions.map((q) => {
      const clip = typeof q.clipIndex === 'number' ? state.scannedFiles[q.clipIndex] : null;
      return { type: q.type, clipKey: clip ? clipKeyV2(clip) : '', field: q.field || '', suggested: q.suggested || '', rule: q.rule || '' };   // #8: collision-free key
    }));
  } catch { /* non-fatal — the in-memory queue still drives this session */ }
}

// Rehydrate after a scan, resolving each question back to the clip it was actually about.
// A question whose clip is no longer on the card is DROPPED — it has nothing to ask about.
async function restoreAiQuestions() {
  let saved = [];
  try { saved = await window.api.getAiQueue() || []; } catch { return; }
  // Clear FIRST, and even when nothing is saved. This runs whenever state.scannedFiles has been
  // replaced, so an in-memory queue left over from the previous card is about clips that are no
  // longer loaded — and every question carries a clipIndex INTO that array. "Nothing saved" has to
  // mean "nothing pending", not "keep what you had".
  aiQuestions = [];
  if (!saved.length) { renderAiHazard(); return; }   // refresh the ⚠ badge so it doesn't keep the old count
  // Index BOTH key forms (#8): entries written before the collision-free key carry `name__size`,
  // new ones carry `name__size__mtime`. Resolving only one silently drops half the queue.
  const byKey = new Map();
  state.scannedFiles.forEach((c, i) => { byKey.set(clipKeyV2(c), i); if (!byKey.has(clipKey(c))) byKey.set(clipKey(c), i); });
  for (const q of saved) {
    if (q.clipKey && !byKey.has(q.clipKey)) continue;                     // that clip isn't here any more
    const clipIndex = q.clipKey ? byKey.get(q.clipKey) : undefined;
    addAiQuestion({ type: q.type, clipIndex, field: q.field || undefined, suggested: q.suggested || undefined, rule: q.rule || undefined });
  }
  if (aiQuestions.length) {
    showToast(`${aiQuestions.length} AI question${aiQuestions.length !== 1 ? 's' : ''} still waiting for you.`, 4500);
  }
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
// Has the card been pulled out from under us?
//
// Nothing detected this. Yanking a card mid-analyse left the grid full of clips whose files no
// longer existed, and every remaining one failed on its own — with aiCallGuard reporting each as
// "Took too long — skipped this clip", a confidently wrong diagnosis of a completely different
// problem. We ask the moment a clip fails, so the real cause is reported ONCE, and the run stops
// instead of burning through the rest of the card producing nonsense.
//
// Checked on demand rather than relying on the drive:removed event, because auto-poll is OFF by
// default in this app — the event alone would never fire for most users.
let cardGoneReported = false;
async function cardIsGone() {
  if (!state.scannedDrive || state.scannedDrive === '__phone__') return false;
  try { return !(await window.api.drivePresent(state.scannedDrive)); } catch { return false; }
}

// Stop everything in flight and say why. Idempotent — a run with 60 clips left will hit this
// repeatedly, and the user should hear it once.
function reportCardGone() {
  aiAborted = true;
  faceScanAborted = true;
  if (cardGoneReported) return;
  cardGoneReported = true;
  clearTask('ai'); clearTask('faces');
  clearAllAnalyzing();
  showToast('The card was removed — stopping. Everything named so far is saved; plug it back in and pick up where you left off.', 9000);
  logIssue('Card', `Removed mid-run (${state.scannedDrive}) — analysis stopped.`);
}

// Put the failure ON the card, with its reason in the tooltip. A count in a toast tells you 12
// clips failed; it does not tell you WHICH — and with 100 clips that's the only question you have.
function markClipFailed(i, why) {
  const card = document.querySelector(`.rename-card[data-i="${i}"]`);
  if (!card) return;
  card.classList.toggle('ai-failed', !!why);
  if (why) card.dataset.aiError = why; else delete card.dataset.aiError;
  const prev = card.querySelector('.rename-preview');
  if (prev) { if (why) prev.title = `AI couldn’t analyse this clip — ${why}`; else prev.removeAttribute('title'); }
}

// The clips this run couldn't analyze, in list order.
function aiFailedClips() {
  return state.scannedFiles.map((c, i) => ({ c, i })).filter(({ c }) => c && c._aiFailed);
}

// Offer to retry ONLY the clips that failed.
//
// Before this, a failure was a counter and a line in an in-memory log (capped at 400, gone on
// restart, buried under Help → Activity log). With 100 clips there was no way to see which ones
// failed, why, or to retry just those — the only recourse was re-running the whole batch, which
// re-paid the full vision cost on the ones that had already worked.
async function offerRetryFailed() {
  const failed = aiFailedClips();
  if (!failed.length) return;
  // Group identical reasons so the dialog says something useful rather than listing 12 lines of
  // the same timeout.
  const byReason = {};
  for (const { c } of failed) { const k = c._aiError || 'no response'; byReason[k] = (byReason[k] || 0) + 1; }
  const reasons = Object.entries(byReason).sort((a, b) => b[1] - a[1])
    .map(([why, n]) => `• ${escapeHtml(why)}${n > 1 ? ` — ${n} clips` : ''}`).join('<br>');

  const ok = await confirmDialog(
    `Retry the ${failed.length} clip${failed.length !== 1 ? 's' : ''} that failed?`,
    `The rest were named and are untouched — only these are re-analysed.<br><br>${reasons}`,
    'Retry those', 'Leave them'
  );
  if (!ok) return;

  // Retry EXACTLY the failed clips, then put the user's selection back the way they left it —
  // silently changing what's ticked is how a "helpful" retry loses someone's work.
  const prevSelected = state.scannedFiles.map((c) => !!c.selected);
  state.scannedFiles.forEach((c) => { c.selected = false; });
  for (const { c } of failed) { c.selected = true; delete c._aiFailed; delete c._aiError; }
  syncRowInputs(failed.map(({ i }) => i));
  try {
    // 'all' — a failed clip has no result to preserve. Preset, so the user isn't re-asked about
    // face scanning / the same-shoot offer / the mode they have literally just answered.
    await aiAnalyzeSelected({ mode: 'all' });
  } finally {
    state.scannedFiles.forEach((c, i) => { c.selected = prevSelected[i]; });
    syncRowInputs(state.scannedFiles.map((_, i) => i));
    updateBatchBar();
  }
}

// Was this exact clip already analyzed AND named? The single answer to "is there work left to
// do here", used to resume an interrupted run instead of redoing it.
//
// The observation is what the vision model SAW — it is written to clip-observations.json the
// moment a clip is analyzed (keyed by the stable name__size fingerprint, so it survives a
// replug and a new drive letter). Having one means the expensive part is already paid for.
// Requiring a subject+description too means we never skip a clip whose analysis succeeded but
// whose naming didn't — that one still has work left.
function aiAlreadyAnalyzed(clip) {
  if (!clip) return false;
  const o = clipObsFor(clip);
  return !!(o && o.obs && String(clip.subject || '').trim() && String(clip.description || '').trim());
}

function applyAiResult(i, res, mode = 'all') {
  const clip = state.scannedFiles[i];
  if (!clip || !res) return { ok: false };
  const capWords = (s, n) => slug(s).split('-').filter(Boolean).slice(0, n).join('-');
  const onlyEmpty = mode === 'empty';
  // "Start over — ignore what's there and name from scratch" has to actually DO that.
  //
  // The subject was gated on `aiCfg.updateSubject` (default FALSE: "keep my subjects, AI only
  // fills description/metadata") regardless of the mode the user had just picked. Batch-rename-
  // then-analyze is the normal flow, so every clip already HAS a subject by then — meaning Start
  // over could never change a single subject, in any mode. It silently rewrote descriptions only.
  // An explicit choice in the dialog beats a background default; the default still governs the
  // other modes, where the user has NOT asked for their names to be replaced.
  const startOver = mode === 'all';
  if (res.subject && (startOver || aiCfg.updateSubject || !clip.subject) && (!onlyEmpty || !clip.subject)) {
    const subj = capWords(res.subject, 3);
    // The AI naming a clip with a fresh subject ("snow-walking") is the whole point —
    // just USE it. We used to queue a confirm-question for every subject that wasn't
    // already in your history, which meant hundreds of near-identical "is this a new
    // subject?" prompts on a first import. Now the only cleverness is snapping a new
    // subject onto one you ALREADY use when it's the same thing spelled differently
    // (snow-walking == snow walking == snowwalking) so your vocabulary stays tidy
    // instead of sprouting duplicates. A genuinely new subject is simply accepted.
    if (subj) {
      const finalSubj = matchKnownSubject(subj) || subj;
      clip.subject = finalSubj; clip._aiSubject = finalSubj; rememberSubject(finalSubj);
    }
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
  return { ok: true, newCategory, note: res.note || '', switchedTo: res.switchedTo || '' };
}

// Snap an AI-generated subject onto one you ALREADY use when it's the same thing spelled
// differently (canonical form ignores case/spaces/hyphens: snow-walking == snowwalking).
// Returns the existing spelling to reuse, or '' when the subject is genuinely new (which
// is fine — it's used as-is, no confirmation). Keeps the subject vocabulary from sprouting
// near-duplicates without ever nagging the user about a perfectly good new subject.
function matchKnownSubject(subj) {
  const want = canon(subj);
  if (!want) return '';
  for (const s of subjectsCache) { if (canon(s) === want) return s; }
  return '';
}

// Watchdog: guarantee an AI loop ALWAYS advances even if one call wedges (a model
// reloading, a clip the model chokes on, a stalled HTTP body). Races the IPC call
// against a hard ceiling so we never sit on clip 1 forever — a stuck clip is marked
// failed (with a clear reason) and the loop moves to the next. This is the real fix
// for "stuck on the first clip and doesn't move to the second".
// Hand the GPU back. Ollama sits on a model for 5 minutes after its last request, so a finished run
// used to leave 5+ GB of VRAM occupied while the user walked away to edit video or play a game.
// Nothing needs it once the run is over — and on an older machine, that VRAM is the whole budget.
//
// Called from EVERY path that ends AI work (analyze, improve, auto-enhance), including cancellation.
// Best-effort: failing to unload must never fail a run that otherwise succeeded.
async function releaseGpu() {
  try { await window.api.aiRelease(); } catch { /* non-fatal */ }
}
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
  const obsOf = (c) => (c.observation && c.observation.trim()) || (clipObsFor(c) && clipObsFor(c).obs) || '';
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
  await releaseGpu();
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
// Learn from the USER's naming — never from the AI's own.
//
// This used to send every analyzed clip: the AI's observation paired with the AI's OWN generated
// name, under a prompt that literally read "a system … produced these names … work backwards, what
// rules explain these choices?" — and it auto-saved the answer into memory, which is then injected
// into the next clip's prompt. That is a self-confirmation loop. The AI wrote down what it already
// does, called it Jake's preference, and then followed it harder. It ran after EVERY analyze run of
// ≥2 clips, with `learnFromAnalysis` defaulting to on. It is a large part of "it doesn't learn well".
//
// A clip the user never touched carries no signal — its name IS the AI's output. A clip the user
// CORRECTED is the one piece of ground truth in the entire system, so that's all we learn from.
async function reflectFromClips(idxs, { manual = false } = {}) {
  const obsOf = (c) => (c.observation && c.observation.trim()) || (clipObsFor(c) && clipObsFor(c).obs) || '';
  const samples = (idxs || []).map((i) => {
    const c = state.scannedFiles[i]; if (!c) return null;
    if (!c._userNamed) return null;                 // the AI's own output teaches it nothing
    const obs = obsOf(c);
    return obs && (c.subject || c.description) ? { observation: obs, subject: c.subject || '', description: c.description || '', shotType: c.shotType || '', people: Array.isArray(c.people) ? c.people : [], context: (c.context || '').trim() } : null;
  }).filter(Boolean);
  if (samples.length < 2) {
    if (manual) showToast('Correct the AI on a couple of clips first — this learns from YOUR names, not its own.', 5000);
    return;
  }
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
    return !!((c.observation && c.observation.trim()) || (clipObsFor(c) && clipObsFor(c).obs));
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
  const obsOf = (c) => (c.observation && c.observation.trim()) || (clipObsFor(c) && clipObsFor(c).obs) || '';
  // Counters live OUT here so the closing message can be honest. They used to be trapped inside the
  // try, and the toast below said "AI auto-enhance complete ✓" unconditionally — including when the
  // card was pulled mid-run (reportCardGone breaks the loop), when the whole try threw, when every
  // model call failed, and when there was nothing to name in the first place. It also repeated the
  // claim as a desktop notification. The sibling at :909 already reports "Improved N · M failed" vs
  // "Couldn't improve"; this is that, for the path he actually runs.
  let done = 0; let planned = 0; let threw = false;
  try {
    // 1) name any clips that have no subject yet
    const unnamed = all.filter((i) => !((state.scannedFiles[i].subject || '').trim()));
    planned = unnamed.length;
    setAiRunOrder(unnamed);   // drive the live AI processing stage
    for (const i of unnamed) {
      if (aiAborted) break;
      setTask('ai', aiModelLabel(), done + 1, unnamed.length, 'naming', state.scannedFiles[i].name);
      markClipAnalyzing(i, 'naming');
      // eslint-disable-next-line no-await-in-loop
      // Guarded for the same reason as the other two batch loops (audit #23) — this one runs over
      // every unnamed clip, so an unbounded call here stalls exactly the run it was meant to finish.
      const r = await aiCallGuard(aiSuggestClip(i, 'empty', { quiet: true }), 300000);
      queueQuestions(i, r);
      markClipAnalyzing(i, false); flushDraftSave();
      // THE CARD WAS PULLED. The legacy single-pass loop has always checked this; the batch loops
      // never did — and `batched` is the DEFAULT once a tool model is configured, so the guard was
      // effectively unreachable. Without it every remaining clip fails on its own and pays the full
      // aiCallGuard timeout: on a 200-clip card that is hours of apparent hang, and the honest
      // one-time "your card is gone" is replaced by N bogus "model timeout" entries in the issue
      // log. reportCardGone() is idempotent and sets aiAborted, so this reports once and unwinds any
      // later phase (each opens with `if (aiAborted) break`).
      // eslint-disable-next-line no-await-in-loop
      if (!(r && r.ok) && await cardIsGone()) { reportCardGone(); break; }
      done += 1;
    }
    // 2) learn durable rules from everything analyzed
    const withObs = all.filter((i) => { const c = state.scannedFiles[i]; return obsOf(c) && (c.subject || c.description); });
    if (withObs.length >= 2) await reflectFromClips(withObs);
  } catch { threw = true; }
  clearAllAnalyzing(); clearTask('ai'); maybeFlushEdits(true);
  await releaseGpu();
  autoEnhancing = false;
  // Say what actually happened. "complete ✓" over a run that named nothing is the failure mode that
  // makes him stop trusting the screen — and trusting it is the whole point of the app.
  const missed = Math.max(0, planned - done);
  if (aiAborted) {
    showToast(done ? `Stopped — named ${done} of ${planned}` : 'Stopped before anything was named', 5000);
    pcNotify('AI auto-enhance stopped', done ? `Named ${done} of ${planned} before it stopped.` : 'Nothing was named.');
  } else if (!planned) {
    showToast('Nothing to enhance — every clip already has a subject', 4000);
  } else if (!done) {
    showToast(`Couldn’t name any of the ${planned} clip${planned !== 1 ? 's' : ''}${threw ? ' — the run failed' : ''}`, 6000);
    pcNotify('AI auto-enhance failed', `None of the ${planned} clips could be named.`);
  } else {
    showToast(`AI auto-enhance complete ✓ — named ${done}${missed ? `, ${missed} failed` : ''}`, missed ? 6000 : 4000);
    pcNotify('AI auto-enhance complete', `Named ${done}${missed ? `, ${missed} failed` : ''}.`);
  }
}

// Direction the user typed in the Analyze dialog for THIS run — folded into the
// per-clip context so it steers naming, and optionally saved to memory afterwards.
let aiRunDirection = '';
function runContext(clip) { return [aiRunDirection, clip && clip.context].map((s) => (s || '').trim()).filter(Boolean).join(' — '); }

// PERCEIVE, then CHOOSE.
//
// The old path did both in one call: a giant prompt telling a VISION model to look AND to emit a
// naming JSON blob. That is three jobs at once (see, reason, serialise) and a 7B model gets one of
// them wrong nearly every time — which is where the variability came from.
//
// Split: the vision model only LOOKS (it is good at that, given a good vision model), and a
// tool-capable text model then names it by CHOOSING from the subjects Jake actually uses. The subject
// is a schema-level enum, so it cannot invent `car-door` or a second spelling of `lawn-mowing`.
//
// Falls back to the old single-call path when there is no tool model — never worse than before.
// ASK ONCE PER SHOOT — "or it only ever asks it once and then it knows."
//
// The one clip the pipeline still got wrong on his real footage: twelve minutes of two men sitting on
// the grass repairing a mower, which he calls `lawn-mowing`. Nobody mows. The label is not in the
// pixels and no vision model will ever find it — the subject is what the footage is FOR, not what is
// on screen.
//
// Guessing it is wrong. Asking about it 37 times, once per clip of that shoot, is worse. He shoots in
// BATCHES (20 of his 28 shoot days are a single subject), so one question settles the whole day — and
// the answer is remembered forever, so the shoot is never asked about again.
//
// Deliberately the same grid as the faces popup ("I love the popup for when it asks me who is who in
// faces. That's really good.") — same classes, same yes/no, same feel.
// Takes CLIPS, not indices.
//
// It used to take indices into `state.scannedFiles`, which silently bound it to the card flow — the
// Organize screen builds its list from `finScan.files` and has no such indices, so it could not call
// this at all without passing numbers that mean something else entirely. That is the same
// wrong-context wiring that has produced a confirmed bug three times in this repo (an empty clip
// list collapsing the group-shot sort, twice). Passing the clips themselves makes the function
// independent of which screen is asking, which is the only way a second entry point can share it
// safely.
async function askAboutShoots(clips) {
  // Resolve the tool model on demand rather than trusting a flag another screen's render may not
  // have set yet — see ensureToolModelKnown. Without this, analysing right after launch skipped the
  // shoot question entirely and left his shoot memory empty.
  if (!subjectsCache.length) return;                          // nothing to offer as an answer
  if (!(await ensureToolModelKnown())) return;                // no tool-capable model — health says so

  // Only the shoots we know NOTHING about. Main filters out any he has answered before or already
  // named clips from — re-asking a settled shoot is the app forgetting, which is the one thing he
  // told us never to do.
  const list = (clips || []).filter(Boolean);
  const dates = list.map((c) => c && c.date).filter(Boolean);
  let shoots = [];
  try {
    const r = await window.api.aiShootsToAsk(dates);
    shoots = (r && r.shoots) || [];
  } catch { return; }                                        // never block a run on this
  if (!shoots.length) return;

  // One card per shoot, carrying its clips so we can show a real thumbnail and a real count.
  const groups = shoots.map((date) => {
    const clips = list.filter((c) => c && c.date === date);
    return { date, clips, chosen: '' };
  }).filter((g) => g.clips.length);
  if (!groups.length) return;

  await new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal face-grid">
      <div class="fg-head">
        <div><b>What were you shooting?</b><div class="muted small sh-status"></div></div>
        <button type="button" class="btn fg-done">Done</button>
      </div>
      <div class="face-grid-scroll sh-scroll"></div>
    </div>`;
    document.body.appendChild(ov);
    const scroll = ov.querySelector('.sh-scroll');
    const status = ov.querySelector('.sh-status');

    const close = () => { ov.remove(); resolve(); };
    ov.querySelector('.fg-done').addEventListener('click', close);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });

    const render = () => {
      scroll.innerHTML = groups.map((g, i) => {
        const n = g.clips.length;
        const seen = `${n} clip${n !== 1 ? 's' : ''} · ${g.date}`;
        const thumb = g.poster ? `<img src="${escapeAttr(g.poster)}" alt=""/>` : '<span class="face-ph-icon">🎞</span>';
        if (g.chosen) {
          return `<div class="face-grid-card-item confirmed" data-i="${i}">
            <div class="fgc-photo">${thumb}<span class="fgc-badge">✓</span></div>
            <div class="fgc-name">${escapeHtml(g.chosen)}</div>
            <div class="fgc-sub muted small">${escapeHtml(seen)} · won't ask again</div>
            <button class="fgc-undo" data-i="${i}">Undo</button>
          </div>`;
        }
        const chips = subjectsCache.slice(0, 8)
          .map((sub) => `<button class="fgc-chip" data-i="${i}" data-sub="${escapeAttr(sub)}">${escapeHtml(sub)}</button>`).join('');
        return `<div class="face-grid-card-item" data-i="${i}">
          <div class="fgc-photo">${thumb}</div>
          <div class="fgc-q">What was the <b>${escapeHtml(g.date)}</b> shoot?</div>
          <div class="fgc-sub muted small">${escapeHtml(seen)}</div>
          <div class="fgc-chips compact">${chips}</div>
          <input type="text" class="ai-input fgc-input sh-input" data-i="${i}" placeholder="or type a subject…" autocomplete="off"/>
        </div>`;
      }).join('');
      const left = groups.filter((g) => !g.chosen).length;
      status.textContent = left
        ? `${left} shoot${left !== 1 ? 's' : ''} the AI can't work out from the footage. Answer once and it'll never ask again.`
        : 'All set — the AI will use these for every clip from those days.';
    };

    // Confirming is the moment it LEARNS. His answer is ground truth, so it is persisted immediately
    // rather than at the end — closing the window must not throw away what he already told us.
    const pick = (i, sub) => {
      const v = slug(String(sub || '').trim());
      if (!v) return;
      groups[i].chosen = v;
      try { window.api.aiRememberShoot({ date: groups[i].date, subject: v }); } catch { /* non-fatal */ }
      // APPLY IT TO THE WHOLE DAY (Tier 1 item 20). Remembering the answer only fed the AI's naming
      // context — so on a day the model never got to, or with AI off entirely, he had just told the
      // app what a 37-clip shoot was and still faced 37 empty subject fields. He shoots in batches:
      // 20 of his 28 shoot days are a single subject, which is the whole reason one question can
      // settle a day.
      //
      // ⚠ A DEFAULT, NEVER AN OVERWRITE. Only clips whose subject is still empty are filled — a name
      // he typed himself outranks anything the app infers, and silently replacing it would be the
      // worst possible reward for answering.
      let filled = 0;
      for (const c of groups[i].clips) {
        if (!c || (c.subject || '').trim()) continue;
        c.subject = v;
        filled += 1;
      }
      if (filled) {
        try { refreshNames(); } catch { /* the grid still closes fine */ }
        try { scheduleDraftSave(); } catch { /* saved on the next edit anyway */ }
        showToast(`${filled} clip${filled !== 1 ? 's' : ''} from ${groups[i].date} named “${v}” — change any of them if it is wrong.`, 5000);
      }
      render();
    };

    scroll.addEventListener('click', (e) => {
      const t = e.target;
      const i = Number(t.dataset && t.dataset.i);
      if (t.classList.contains('fgc-chip')) return pick(i, t.dataset.sub);
      if (t.classList.contains('fgc-undo')) { groups[i].chosen = ''; render(); return; }
    });
    scroll.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.classList.contains('sh-input')) return;
      e.preventDefault();
      pick(Number(e.target.dataset.i), e.target.value);
    });

    render();

    // Real thumbnails, filled in as they arrive — a grid of film-strip placeholders is much harder to
    // answer than a grid of actual footage.
    (async () => {
      for (const g of groups) {
        try {
          const src = g.clips[0] && g.clips[0].sourcePath;
          if (src) { const poster = await window.api.getPoster(src); if (poster) { g.poster = poster; render(); } }
        } catch { /* a missing thumbnail is cosmetic */ }
      }
    })();
  });
}

async function aiNameWithTools(i, opts = {}) {
  const clip = state.scannedFiles[i];
  if (!clip) return null;
  if (!aiToolModelReady || !subjectsCache.length) return null;

  // Reuse a cached observation if we have one — re-watching footage we've already seen is the single
  // most expensive thing the app can do.
  let obs = (opts.observation || '').trim() || (clipObsFor(clip) || {}).obs || '';
  if (!obs) {
    // A BATCH RUN MUST NEVER LAND HERE. Perceiving inside the naming step means loading the vision
    // model, then the tool model, then the vision model again — a full VRAM swap PER CLIP. On a
    // single-GPU machine that is minutes of thrash per clip and it is the worst thing the app could
    // possibly do. The batch loop always hands us an observation; `noPerceive` makes that a rule the
    // code enforces rather than a convention someone can quietly break later.
    if (opts.noPerceive) return null;
    await window.api.aiUseOnly(aiCfg.model);                 // vision alone in VRAM
    markClipAnalyzing(i, 'looking');
    const p = await aiCallGuard(window.api.aiPerceive({
      sourcePath: clip.sourcePath, model: aiCfg.model,
      context: runContext(clip), people: Array.isArray(clip.people) ? clip.people : [],
    }), 200000);
    if (!p || !p.ok || !p.observation) return null;          // fall back to the old path
    obs = String(p.observation).trim();
  }
  if (obs) {
    clip.observation = obs;
    noteClipObs(clip, obs);
  }

  markClipAnalyzing(i, 'naming');
  let r = null;
  try {
    await window.api.aiUseOnly(aiToolModelName);   // the reasoning model, alone in VRAM
    r = await window.api.aiNameFromObservation({
      observation: obs,
      context: runContext(clip),
      people: Array.isArray(clip.people) ? clip.people : [],
      subjects: subjectsCache,
      // The shoot. He shoots in batches — 20 of his 28 shoot days are a single subject — so what he
      // called the OTHER clips from this same day is the strongest signal there is about what this one
      // is for. Measured: +20 points of subject accuracy on his real footage. Send both the date and
      // what we have already named in THIS run, so clip 30 of a shoot benefits from clips 1-29.
      date: clip.date || '',
      siblings: state.scannedFiles
        .filter((c) => c !== clip && c.subject && c.date)
        .map((c) => ({ date: c.date, subject: c.subject })),
    });
  } catch { return null; }
  if (!r || !r.ok || !r.subject) return null;                // fall back rather than half-name it

  // Shaped exactly like the old aiSuggest result, so applyAiResult and everything downstream is
  // untouched.
  return {
    ok: true,
    subject: r.subject,
    description: r.description || '',
    shotType: r.shotType || '',
    tags: Array.isArray(r.tags) ? r.tags : [],
    observation: obs,
    category: '',
    newSubject: r.newSubject ? r.subject : '',
  };
}

async function aiSuggestClip(i, mode = 'all', opts = {}) {
  const clip = state.scannedFiles[i];
  if (!clip || !aiReady()) return { ok: false };

  // The tool path first. It only runs when there is a model that can actually call tools AND we know
  // his real subjects — otherwise there is nothing to constrain the choice to, and the old path is
  // genuinely no worse.
  const toolResult = await aiNameWithTools(i, opts);
  if (toolResult) return toolResult;

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
      noteClipObs(clip, obs);
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
// `preset` runs the analysis with the dialogs already answered — used by "Retry failed", which
// has just asked the user everything it needs and must not re-prompt for face scanning, the
// same-shoot offer and the mode all over again.
async function aiAnalyzeSelected(preset = null) {
  if (!requireAi()) return;
  let idxs = state.scannedFiles.map((c, i) => (c.selected ? i : -1)).filter((i) => i >= 0);
  if (!idxs.length) { showToast('Tick the clips you want to analyse first'); return; }
  if (!preset) {
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
  }
  const hasContent = idxs.some((i) => {
    const c = state.scannedFiles[i];
    return c.subject || c.description || organizeFields.some((f) => c[f.id]);
  });
  const cachedCount = idxs.filter((i) => { const o = clipObsFor(state.scannedFiles[i]); return o && o.obs; }).length;
  const dlg = preset
    ? { mode: preset.mode || 'all', direction: preset.direction || aiRunDirection || '', remember: false, reuse: preset.reuse !== false }
    : await showAnalyzeDialog({ count: idxs.length, hasContent, cachedCount });
  if (!dlg) return;
  const mode = dlg.mode;
  // Direction the user typed steers this run (folded into each clip's context)…
  aiRunDirection = dlg.direction || '';
  // …and, if they asked, is remembered so future runs benefit too.
  if (dlg.direction && dlg.remember) {
    // The user ticked a box asking the app to KEEP this. An explicit request deserves an explicit
    // answer: this used to say nothing either way, so a failed save was discovered months later by
    // the AI simply not behaving that way. The in-memory push is gated on the same outcome, so the
    // two can't diverge and leave the app believing it knows something it will forget on restart.
    let kept = false;
    try {
      const rr = await window.api.aiAddMemories([{ text: dlg.direction, example: '' }]);
      kept = !(rr && rr.ok === false);
    } catch (e) { kept = false; logIssue('AI', `Couldn’t remember the direction "${dlg.direction}": ${(e && e.message) || e}`); }
    if (kept) {
      if (!Array.isArray(aiCfg.memories)) aiCfg.memories = [];
      aiCfg.memories.push({ text: dlg.direction, example: '' });
      showToast('Remembered — future runs will use this too', 3500);
    } else {
      showToast('Couldn’t remember that direction — it still applies to this run', 6000);
      logIssue('AI', `aiAddMemories did not persist the remembered direction "${dlg.direction}"`);
    }
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
      // New subjects are auto-accepted now (see applyAiResult) — no confirm flood. Only a
      // genuinely new top-level CATEGORY still asks, since that creates a new root folder.
      if (r.newCategory) addAiQuestion({ type: 'category', clipIndex: i, field: 'category', suggested: r.newCategory });
      const okClip = state.scannedFiles[i];
      if (okClip) { delete okClip._aiFailed; delete okClip._aiError; }   // a retry that worked clears the mark
      markClipFailed(i, '');
    } else {
      failCount += 1;
      const why = (r && r.error) || 'no response';
      if (r && r.error) lastErr = r.error;
      // MARK THE CLIP. A failure used to be a number in a counter and a line in an in-memory log
      // (capped at 400, gone on restart, buried under Help → Activity log). With 100 clips you
      // could not tell WHICH ones failed, WHY, or retry just those — the only move was to re-run
      // the whole batch. The clip now carries its own failure, which is what makes "Retry failed"
      // possible at all.
      const clip = state.scannedFiles[i];
      if (clip) { clip._aiFailed = true; clip._aiError = why; }
      markClipFailed(i, why);
      logIssue('AI analyze', `${(clip || {}).name || 'clip'}: ${why}`);
    }
  };
  cardGoneReported = false;   // a fresh run gets a fresh chance to report a removal

  // RESUME. "Only name blank clips" used to still run the full vision pass on EVERY selected
  // clip and then throw the answer away inside applyAiResult (which gates subject/description/
  // category on being blank). So cancelling at clip 40 of 100 and hitting Analyze again
  // re-watched all 100 — the work was remembered, and then redone anyway.
  //
  // A clip counts as already analyzed when we have the observation we extracted from it AND it
  // got named. Re-running such a clip in `empty` mode can only reproduce the shotType and tags
  // it already carries, so skipping it changes nothing except the time you get back.
  if (mode === 'empty') {
    const before = idxs.length;
    idxs = idxs.filter((i) => !aiAlreadyAnalyzed(state.scannedFiles[i]));
    const skipped = before - idxs.length;
    if (skipped) {
      setAiRunOrder(idxs);   // the live stage must show the work we're ACTUALLY doing
      showToast(`Picking up where you left off — skipping ${skipped} clip${skipped !== 1 ? 's' : ''} already analyzed.`, 4000);
    }
    if (!idxs.length) { showToast('Every selected clip is already analyzed ✓', 3500); return; }
  }

  let done = 0;
  // BATCH, ALWAYS, when the naming model is a different model from the vision model.
  //
  // This machine — and any older machine — cannot hold a vision model and an 8B reasoning model in
  // VRAM at once. The alternative to batching is swapping models on every single clip, which is
  // minutes of pure thrash per clip. So the moment a separate tool model exists, the two-phase path
  // is not an "opt-in quality setting" (which is what multiPass was, and it was OFF by default) —
  // it is the only correct way to run, and the checkbox does not get a say.
  const batched = aiCfg.multiPass || aiToolModelReady;
  if (batched) {
    // PHASE 1 — the vision model "looks" at EVERY clip first (it stays loaded the
    // whole phase, no per-clip reload), producing an observation each.
    await window.api.aiUseOnly(aiCfg.model);   // vision alone in VRAM for the whole phase
    const observations = {};
    for (const i of idxs) {
      if (aiAborted) break;
      const clip = state.scannedFiles[i];
      // Reuse a prior observation of this exact clip when the user opted in — no
      // need to look again, and it keeps results consistent run-to-run.
      const prior = clipObsFor(clip);
      if (dlg.reuse && prior && prior.obs) {
        observations[i] = prior.obs;
        setTask('ai', aiModelLabel(), done + 1, idxs.length, 'reusing', clip.name);
        done += 1; continue;
      }
      setTask('ai', aiModelLabel(), done + 1, idxs.length, 'looking', clip.name);
      markClipAnalyzing(i, 'looking');
      // eslint-disable-next-line no-await-in-loop
      const r = await aiCallGuard(window.api.aiPerceive({ sourcePath: clip.sourcePath, model: aiCfg.model, context: runContext(clip), people: Array.isArray(clip.people) ? clip.people : [] }), 200000);
      if (r && r.ok) {
        observations[i] = r.observation; if (r.note) visionNote = r.note; if (r.switchedTo) aiCfg.model = r.switchedTo;
        noteClipObs(clip, r.observation);   // remember for next time
      } else if (r && r.error) lastErr = r.error;
      markClipAnalyzing(i, false);
      // THE CARD WAS PULLED. The legacy single-pass loop has always checked this; the batch loops
      // never did — and `batched` is the DEFAULT once a tool model is configured, so the guard was
      // effectively unreachable. Without it every remaining clip fails on its own and pays the full
      // aiCallGuard timeout: on a 200-clip card that is hours of apparent hang, and the honest
      // one-time "your card is gone" is replaced by N bogus "model timeout" entries in the issue
      // log. reportCardGone() is idempotent and sets aiAborted, so this reports once and unwinds any
      // later phase (each opens with `if (aiAborted) break`).
      // eslint-disable-next-line no-await-in-loop
      if (!(r && r.ok) && await cardIsGone()) { reportCardGone(); break; }
      done += 1;
    }
    // PHASE 2 — the reasoning model names them all from those observations (it
    // stays loaded for this phase). No swapping vision↔text per clip.
    //
    // ASK ABOUT ANY SHOOT WE STILL DON'T UNDERSTAND — once, before naming anything from it.
    //
    // This sits exactly on the phase boundary on purpose. The vision model is done and the reasoning
    // model is not loaded yet, so the GPU is EMPTY while he answers: on a 6 GB card, a human thinking
    // is the one moment we can afford to hold nothing at all. It also means his answer is in hand
    // before a single clip from that shoot gets named, rather than arriving too late to matter.
    if (!aiAborted) await askAboutShoots(idxs.map((i) => state.scannedFiles[i]));

    // Evicting the vision model here is the load-bearing line. Ollama holds a model for 5 minutes
    // after its last request, so without this the vision model is STILL in VRAM when the reasoning
    // model loads — the phases were separated in time but not in memory, and the second load OOM'd.
    if (!aiAborted) await window.api.aiUseOnly(aiToolModelReady ? aiToolModelName : (aiCfg.textModel || aiCfg.model));
    done = 0;
    for (const i of idxs) {
      if (aiAborted) break;
      setTask('ai', aiModelLabel(), done + 1, idxs.length, 'naming', state.scannedFiles[i].name);
      markClipAnalyzing(i, 'naming');
      // noPerceive: the observation is already in hand. If it somehow isn't, fall back rather than
      // reloading the vision model mid-phase and thrashing the GPU.
      // eslint-disable-next-line no-await-in-loop
      // GUARDED (audit #23). Naming was the one phase with no bound, while perceive and improve both
      // had one. The tool loop is maxSteps:5 with a 120 s per-call timeout, so a wedged clip could hold
      // the batch ~10 min and then fall through to the legacy path for another 180 s — on a 200-clip
      // card that is how a run appears to "just stop". 300 s is deliberately LOOSER than the 200 s
      // perceive guard: naming legitimately takes several tool steps, and a guard that skips clips
      // which would have succeeded is worse than the stall it prevents.
      const r = await aiCallGuard(aiSuggestClip(i, mode, { observation: observations[i] || '', quiet: true, noPerceive: true }), 300000);
      queueQuestions(i, r);
      markClipAnalyzing(i, false);
      flushDraftSave();   // persist each named clip immediately — survives a mid-run crash
      // THE CARD WAS PULLED. The legacy single-pass loop has always checked this; the batch loops
      // never did — and `batched` is the DEFAULT once a tool model is configured, so the guard was
      // effectively unreachable. Without it every remaining clip fails on its own and pays the full
      // aiCallGuard timeout: on a 200-clip card that is hours of apparent hang, and the honest
      // one-time "your card is gone" is replaced by N bogus "model timeout" entries in the issue
      // log. reportCardGone() is idempotent and sets aiAborted, so this reports once and unwinds any
      // later phase (each opens with `if (aiAborted) break`).
      // eslint-disable-next-line no-await-in-loop
      if (!(r && r.ok) && await cardIsGone()) { reportCardGone(); break; }
      done += 1;
    }
  } else {
    for (const i of idxs) {
      if (aiAborted) break;
      const clip = state.scannedFiles[i];
      // Feed back what we already saw in this clip, when the user ticked Reuse. `dlg.reuse`
      // used to be read in exactly ONE place — inside the multiPass branch — and multiPass is
      // OFF by default, so for a default install the "Reuse earlier analysis of N clips
      // (faster)" checkbox did literally nothing. It reuses now in both modes.
      const cached = dlg.reuse ? (clipObsFor(clip) || {}).obs || '' : '';
      setTask('ai', aiModelLabel(), done + 1, idxs.length, cached ? 'reusing' : 'analyzing', clip.name);
      markClipAnalyzing(i, cached ? 'reusing' : 'analyzing');
      // eslint-disable-next-line no-await-in-loop
      // Guarded for the same reason as the multi-pass loop above (audit #23).
      const r = await aiCallGuard(aiSuggestClip(i, mode, { observation: cached, quiet: true }), 300000);
      queueQuestions(i, r);
      markClipAnalyzing(i, false);
      flushDraftSave();   // persist each named clip immediately — survives a mid-run crash
      done += 1;
      // A failure is the moment to ask whether the CARD is still there. If it isn't, stop: every
      // remaining clip would fail too, and each would be misreported as its own model timeout.
      // eslint-disable-next-line no-await-in-loop
      if (!(r && r.ok) && await cardIsGone()) { reportCardGone(); break; }
    }
  }
  clearAllAnalyzing();
  clearTask('ai');
  await releaseGpu();   // give the VRAM back — this also runs on abort, so cancelling frees it too
  const q = aiQuestions.length;
  // A CANCELLED run (aborted before it named anything) used to report "AI analysis done · Named 0
  // clips" — which reads as "it ran and found nothing", not "you stopped it". Say what happened.
  if (aiAborted) showToast(`Analyse cancelled${okCount ? ` — ${okCount} named before you stopped` : ''}${q ? ` · ${q} to review` : ''}`, 4500);
  else if (failCount && !okCount) showToast(`AI couldn't name any clips — ${lastErr || 'check the model in AI settings'}`, 6000);
  else if (failCount) showToast(`AI named ${okCount}, ${failCount} failed${lastErr ? ` (${lastErr})` : ''} · ${q} to review`, 5000);
  else { showToast(`AI analysed ${okCount} clip${okCount !== 1 ? 's' : ''}${q ? ` · ${q} to review` : ''}${mode === 'empty' ? ' (filled empty fields only)' : ''}`); pcNotify('AI analysis done', `Named ${okCount} clip${okCount !== 1 ? 's' : ''}${q ? ` · ${q} to review` : ''}.`); }
  // OFFER THE RETRY. A toast saying "12 failed" is not actionable — it disappears, and the only
  // recourse was re-running the whole batch (re-paying the vision cost on the 88 that worked).
  // The clips carry their own failure now, so we can retry precisely those.
  //
  // `!preset` is what stops this recursing: a run STARTED by offerRetryFailed is itself a preset
  // run, so a retry that fails again reports and stops rather than re-offering forever.
  if (failCount && !aiAborted && !preset) await offerRetryFailed();
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

// Review the AI's pending questions on ONE page — no more clicking Next through
// hundreds of near-identical prompts. Everything the AI is unsure about is grouped and
// shown at once, with sensible defaults already selected, so the common case is a single
// glance + "Apply". Handles all question types:
//  - confirm            : a clip the AI named — tweak subject/description inline (optional)
//  - subject / category : a new value, GROUPED by suggestion so "use 'snow-walking' for
//                         these 12 clips" is one decision, not twelve
//  - rule               : remember a learned preference (checkbox)
// Nothing is committed until you hit Apply; closing/Cancel leaves the questions pending.
let aiReviewDlId = 0;
function showAiReview() {
  const items = aiQuestions.slice();   // snapshot to resolve on Apply
  if (!items.length) { showToast('No AI questions right now'); return; }
  const rules = items.filter((it) => it.type === 'rule');
  const confirms = items.filter((it) => it.type === 'confirm');
  const valueItems = items.filter((it) => it.type === 'subject' || it.type === 'category');
  // Collapse identical new-value suggestions into one row (one decision → many clips).
  const groups = [];
  const groupOf = new Map();
  for (const it of valueItems) {
    const key = `${it.type}|${it.field || ''}|${(it.suggested || '').toLowerCase()}`;
    let g = groupOf.get(key);
    if (!g) { g = { type: it.type, field: it.field, suggested: it.suggested, items: [] }; groupOf.set(key, g); groups.push(g); }
    g.items.push(it);
  }
  const thumbImg = (clip) => (clip && clip.posterUrl ? `<img class="wiz-thumb" src="${escapeAttr(clip.posterUrl)}" alt="" />` : '<span class="wiz-thumb wiz-thumb-ph"></span>');

  // --- Group rows (new subject / category) — radios: use suggestion / type instead / skip.
  const dl = `airev-dl-${(aiReviewDlId += 1)}`;
  const groupsHtml = groups.map((g, gi) => {
    const kind = g.type === 'category' ? 'category' : 'subject';
    const n = g.items.length;
    return `<div class="airev-row" data-group="${gi}">
      <div class="airev-row-hd"><b>${escapeHtml(g.suggested)}</b> <span class="muted small">— new ${kind} · ${n} clip${n !== 1 ? 's' : ''}</span></div>
      <div class="airev-opts">
        <label class="fin-radio"><input type="radio" name="airev-g${gi}" value="use" checked /> <span>Use it</span></label>
        <label class="fin-radio"><input type="radio" name="airev-g${gi}" value="custom" /> <span>Use instead:</span> <input type="text" class="ai-input airev-custom" list="${dl}" placeholder="type a ${kind}" /></label>
        <label class="fin-radio"><input type="radio" name="airev-g${gi}" value="skip" /> <span>Leave blank</span></label>
      </div>
    </div>`;
  }).join('');
  const existingVals = [...new Set([...(subjectsCache || []), ...Object.values(fieldHistoryCache || {}).flat()])].filter(Boolean);
  const datalist = groups.length ? `<datalist id="${dl}">${existingVals.map((o) => `<option value="${escapeAttr(o)}"></option>`).join('')}</datalist>` : '';

  // --- Confirm rows (clips the AI named) — inline subject/description, thumbnail only
  // (a compact grid instead of a one-video-at-a-time carousel).
  const confirmsHtml = confirms.map((it) => {
    const clip = state.scannedFiles[it.clipIndex];
    return `<div class="airev-clip" data-qid="${it.id}">
      ${thumbImg(clip)}
      <div class="airev-clip-fields">
        <div class="airev-clip-name muted small">${escapeHtml(clip ? clip.name : '')}</div>
        <input type="text" class="ai-input airev-cf-subject" value="${escapeAttr(clip ? (clip.subject || '') : '')}" placeholder="subject" />
        <input type="text" class="ai-input airev-cf-desc" value="${escapeAttr(clip ? (clip.description || '') : '')}" placeholder="description" />
      </div>
    </div>`;
  }).join('');

  // --- Rule rows (things it learned) — a checkbox each, editable text.
  const rulesHtml = rules.map((it, ri) => `<div class="airev-rule" data-qid="${it.id}">
      <label class="fin-radio"><input type="checkbox" class="airev-rule-on" data-ri="${ri}" checked /> <span>Remember:</span></label>
      <input type="text" class="ai-input airev-rule-text" value="${escapeAttr(it.rule)}" />
      ${it.example ? `<div class="airev-rule-eg muted small">e.g. ${escapeHtml(it.example)}</div>` : ''}
    </div>`).join('');

  const section = (title, sub, inner) => inner
    ? `<div class="airev-sec"><div class="airev-sec-hd">${title}${sub ? ` <span class="muted small">${sub}</span>` : ''}</div>${inner}</div>`
    : '';

  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal-card ai-wiz airev-card">
    <div class="illo mob-illo">${ILLO_ASK}</div>
    <div class="ai-hd" style="margin-top:2px"><div class="ai-hd-text"><h3>Review AI questions</h3><p class="muted small">Everything the AI wasn't sure about — the defaults are already picked, so you can usually just hit Apply.</p></div></div>
    <div class="airev-body">
      ${section('Confirm clips', confirms.length ? `${confirms.length} named` : '', confirmsHtml)}
      ${section('New values', groups.length ? `${groups.length}` : '', groupsHtml)}
      ${section('Remember', rules.length ? `${rules.length}` : '', rulesHtml)}
    </div>
    ${datalist}
    <div class="modal-actions">
      <button type="button" class="btn primary airev-apply">Apply${items.length > 1 ? ` all (${items.length})` : ''}</button>
      <button type="button" class="btn airev-cancel">Cancel</button>
    </div></div>`;
  document.body.appendChild(ov);
  const $w = (s) => ov.querySelector(s);
  const close = () => ov.remove();

  async function applyAll() {
    const confirmedRules = [];
    // Rules
    rules.forEach((it, ri) => {
      const on = ov.querySelector(`.airev-rule-on[data-ri="${ri}"]`);
      if (on && on.checked) { const box = on.closest('.airev-rule'); const t = (box.querySelector('.airev-rule-text').value || '').trim(); if (t) confirmedRules.push({ text: t, example: it.example || '' }); }
      resolveAiQuestion(it.id);
    });
    // Confirm clips — apply inline edits (corrections teach the AI)
    const touched = [];
    confirms.forEach((it) => {
      const clip = state.scannedFiles[it.clipIndex];
      const box = ov.querySelector(`.airev-clip[data-qid="${it.id}"]`);
      if (clip && box) {
        const ns = slug(box.querySelector('.airev-cf-subject').value);
        const nd = slug(box.querySelector('.airev-cf-desc').value);
        if (ns !== (clip.subject || '')) { recordAiEdit(clip, 'subject', ns); clip.subject = ns; if (ns) rememberSubject(ns); }
        if (nd !== (clip.description || '')) { recordAiEdit(clip, 'description', nd); clip.description = nd; if (nd) rememberDescription(nd); }
        touched.push(it.clipIndex);
      }
      resolveAiQuestion(it.id);
    });
    // New-value groups — one choice fans out to every clip in the group
    groups.forEach((g, gi) => {
      const sel = ov.querySelector(`input[name="airev-g${gi}"]:checked`);
      const choice = sel ? sel.value : 'use';
      let value = '';
      if (choice === 'use') value = g.suggested;
      else if (choice === 'custom') value = slug((ov.querySelector(`.airev-row[data-group="${gi}"] .airev-custom`) || {}).value || '');
      for (const it of g.items) {
        const clip = state.scannedFiles[it.clipIndex];
        if (clip && choice !== 'skip' && value) {
          if (g.type === 'category') { clip[g.field || 'category'] = value; rememberField(g.field || 'category', value); }
          else { clip.subject = value; rememberSubject(value); }
          touched.push(it.clipIndex);
        }
        resolveAiQuestion(it.id);
      }
    });
    if (touched.length) syncRowInputs([...new Set(touched)]);
    refreshNames();
    close();
    if (confirmedRules.length) {
      const r = await window.api.aiAddMemories(confirmedRules);
      if (r && r.ok && Array.isArray(r.memories)) aiCfg.memories = r.memories;
    }
    maybeFlushEdits(true);   // learn from any corrections made here
    showToast('All caught up ✓');
  }
  $w('.airev-apply').addEventListener('click', applyAll);
  $w('.airev-cancel').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  // Typing in a "use instead" field selects its radio (so a typed value isn't ignored).
  ov.querySelectorAll('.airev-custom').forEach((inp) => inp.addEventListener('input', () => {
    const r = inp.closest('.airev-opts').querySelector('input[value="custom"]'); if (r) r.checked = true;
  }));
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
    const btn = q('.me-refine'); q('.me-status').textContent = 'Refining…';
    const r = await withBusyBtn(btn, null, () => window.api.aiRefineMemory(text),
      (msg) => { q('.me-status').textContent = `Couldn’t refine: ${msg}`; });
    if (r && r.ok) { q('.me-text').value = r.text; if (r.example) q('.me-eg').value = r.example; q('.me-status').textContent = 'Refined ✓'; q('.me-revert').classList.remove('hidden'); }
    else if (r) { q('.me-status').textContent = `Couldn’t refine: ${r.error || 'please try again'}`; }
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
    const btn = q('.imp-extract'); q('.imp-status').textContent = 'Reading & extracting…';
    // Reads a file AND calls the LLM — two independent ways to reject.
    const r = await withBusyBtn(btn, null, () => window.api.aiImportDoc(text ? { text } : { path }),
      (msg) => { q('.imp-status').textContent = `Couldn’t extract: ${msg}`; });
    if (!r || !r.ok) { if (r) q('.imp-status').textContent = `Couldn’t extract: ${r.error || 'please try again'}`; return; }
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
  else if (action === 'scan-faces') scanFacesSelected();
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
    // Only propagate fields that are actually FILLED — the same rule applyBatch already follows
    // ("Only apply fields you actually filled — so you can batch-tag one field without wiping each
    // clip's name"). This copied unconditionally, so hitting ⤓ on a row whose description happened
    // to be empty WIPED the description and every custom organize field on all the ticked clips —
    // including AI-generated values the user could not even see, because cleanGrid hides the meta
    // row by default. You'd propagate one subject and silently destroy 40 descriptions.
    if (copyDate && src.date) { c.date = src.date; c.dateLocked = true; }
    if (src.subject) c.subject = src.subject;
    if (src.description) c.description = src.description;
    if (src.location) c.location = src.location;   // was omitted entirely — every other path copies it
    for (const fld of organizeFields) if (src[fld.id]) c[fld.id] = src[fld.id];
  }
  syncRowInputs(targets.map((t) => t.idx));
  if (src.subject) rememberSubject(src.subject);
  if (src.description) rememberDescription(src.description);
  if (src.location) rememberLocation(src.location);
  for (const fld of organizeFields) rememberField(fld.id, src[fld.id]);
  flushDraftSave();                 // this rewrote up to N clips — persist it NOW, not on a debounce
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

