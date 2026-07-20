// ---------------------------------------------------------------------------
// Step 1 — name the clips. Each row has date/subject/description fields and a
// scrubbable FFmpeg-frame preview (works for HEVC). Previews + metadata load
// lazily (IntersectionObserver) so 100s of clips don't all probe up front.
// ---------------------------------------------------------------------------
let previewObserver = null;
let renameMoreObs = null;              // windowed-grid "load more" observer (disconnect on re-render)
let renameEnsureRendered = null;       // (clipIdx) => render chunks until that clip's card exists

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
  // Display ORDER: when grouping by day, lay out every clip of the same day together
  // (newest day first) so the "N clips" header actually shows all N. Indices stay the
  // ORIGINAL positions (data-i), so all per-row editing/handlers are unaffected.
  const order = [];
  if (uiPrefs.dayDividers !== false) {
    const byDay = new Map();
    for (let i = 0; i < n; i += 1) { const d = state.scannedFiles[i].date || ''; if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(i); }
    // BIGGEST SHOOTS FIRST, when he asks for it. Measured on his real library: 4263 unnamed clips
    // across 410 days, median 4 clips a day — but the top 50 days hold 52% of them. Newest-first
    // buries those fifty wins among 410 entries, so a backlog that is actually an afternoon's work
    // reads as a marathon. Naming a whole day is already one click ("Select all" on the divider);
    // this decides WHICH day is in front of him.
    //
    // Newest-first stays the default — recent footage is usually what he came for, and silently
    // reordering it would be its own surprise. Undated clips sort last either way: they are the least
    // useful to bulk-name, so they must never lead.
    const days = [...byDay.keys()].sort((a, b) => {
      const ua = !String(a || '').trim(); const ub = !String(b || '').trim();
      if (ua !== ub) return ua ? 1 : -1;                                  // no-date always last
      if (uiPrefs.dayBiggestFirst) {
        const na = byDay.get(a).length; const nb = byDay.get(b).length;
        if (na !== nb) return nb - na;                                    // most clips first
      }
      return String(b).localeCompare(String(a));                          // newest day first
    });
    for (const d of days) for (const idx of byDay.get(d)) order.push(idx);
  } else {
    for (let i = 0; i < n; i += 1) order.push(i);
  }
  // Build ONE clip card element (heavy inputs/combos are wired later, per chunk).
  const buildCard = (i) => {
    const clip = state.scannedFiles[i];
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
          <!-- Where it will FILE, not just what it will be called. The pill above answers "what is
               this clip"; this answers "where does it end up", which is the question he actually has
               before committing a card (Tier 1 item 8). Filled in asynchronously by
               refreshWillFile() — the folder is decided by main's ladder, never guessed here. -->
          <div class="final-dest" data-dest="${i}" hidden></div>
        </div>
        <div class="clip-people" data-people="${i}">${peopleChipsHTML(clip, i)}</div>
        <div class="clip-tags" data-tags="${i}">${tagChipsHTML(clip, i)}</div>
      </div>`;
    return card;
  };

  // WINDOWED rendering: building + wiring ~3000 cards (each with 6 inputs + comboboxes)
  // at once froze and CRASHED the renderer. Render+wire in chunks; more load as you
  // scroll (a sentinel near the bottom pulls the next chunk). Selection/batch operate on
  // state, not the DOM, so they still cover every clip even if it's not rendered yet.
  let lastDay = null; let rendered = 0;
  const CHUNK = 100;
  const sentinel = document.createElement('div'); sentinel.className = 'rn-sentinel'; sentinel.style.minHeight = '1px';
  if (renameMoreObs) { renameMoreObs.disconnect(); renameMoreObs = null; }   // don't leak across re-renders
  const renderNext = () => {
    if (rendered >= order.length) { sentinel.remove(); if (renameMoreObs) renameMoreObs.disconnect(); return; }
    const frag = document.createDocumentFragment();
    const end = Math.min(order.length, rendered + CHUNK);
    for (; rendered < end; rendered += 1) {
      const i = order[rendered]; const clip = state.scannedFiles[i];
      if (uiPrefs.dayDividers !== false) {
        const day = clip.date || '';
        if (day !== lastDay) {
          const cnt = dayCounts[day] || 0;
          const div = document.createElement('div'); div.className = 'day-divider';
          div.innerHTML = `<span class="day-divider-label">${escapeHtml(day || 'No date')}</span>
            <span class="day-divider-count">${cnt} clip${cnt !== 1 ? 's' : ''}</span>
            <button type="button" class="day-select" title="Select all ${cnt} clips from this day">Select all</button>`;
          div.querySelector('.day-select').addEventListener('click', () => selectDay(day));
          frag.appendChild(div); lastDay = day;
        }
      }
      const card = buildCard(i);
      frag.appendChild(card);
      previewObserver.observe(card);
    }
    wireRowEditing(frag);   // wire ONLY this chunk's rows (per-element; no double-wiring)
    listEl.insertBefore(frag, sentinel);
    applyClipFilter();      // keep any active filter applied to the freshly-added cards
  };
  listEl.appendChild(sentinel);
  renameMoreObs = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) renderNext(); }, { root: listEl, rootMargin: '900px' });
  renameMoreObs.observe(sentinel);
  // Let jump/focus render ahead: build chunks until the target clip's card exists.
  renameEnsureRendered = (clipIdx) => {
    const pos = order.indexOf(clipIdx); if (pos < 0) return;
    let guard = 0;
    while (rendered <= pos && rendered < order.length && guard++ < 100000) renderNext();
  };
  renderNext();   // first chunk
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
// WHERE EACH CLIP WILL FILE, shown while he is still naming it.
//
// Asked of MAIN (`organize:previewDest`), which runs the same ladder `finalize:run` files with. The
// card screen must never compute this itself: a prediction from a second implementation is a promise
// the app does not keep, and that drift is the bug class that cost four separate days here.
//
// Debounced, because it is refreshed on every keystroke through refreshNames().
let _willFileTimer = null;
function scheduleWillFileRefresh() {
  clearTimeout(_willFileTimer);
  _willFileTimer = setTimeout(refreshWillFile, 400);
}
async function refreshWillFile() {
  const cells = [...document.querySelectorAll('[data-dest]')];
  if (!cells.length) return;
  const items = cells.map((el) => {
    const c = state.scannedFiles[Number(el.dataset.dest)];
    return c ? { name: c.name, sourcePath: c.sourcePath, meta: { subject: c.subject || '', date: c.date || '' } } : null;
  }).filter(Boolean);
  if (!items.length) return;
  let dests = [];
  try {
    const r = await window.api.organizePreviewDest({ items, folderLevels: folderLevels });
    dests = (r && r.dests) || [];
  } catch { return; }                       // advisory — naming must work with the AI and main asleep
  const byName = {};
  for (const d of dests) if (d && d.name) byName[d.name] = d.rel;
  // Re-read the cells: a re-render can replace them while this is in flight, and writing a stale
  // destination into a recycled row is a confident wrong answer.
  for (const el of [...document.querySelectorAll('[data-dest]')]) {
    const c = state.scannedFiles[Number(el.dataset.dest)];
    const rel = c && byName[c.name];
    if (!rel) { el.hidden = true; continue; }
    const txt = `→ ${rel}`;
    if (el.textContent !== txt) el.textContent = txt;
    el.hidden = false;
  }
}

function refreshNames() {
  scheduleVersionRecompute();
  scheduleWillFileRefresh();
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
  const auto = new Set(Array.isArray(clip.peopleAuto) ? clip.peopleAuto : []);   // unconfirmed guesses
  return ppl.map((n) => {
    const guess = auto.has(n);   // show a face-guess as "Liam?" with a dashed chip
    return `<span class="clip-person-chip${guess ? ' unconfirmed' : ''}"${guess ? ' title="Auto-detected face — unconfirmed guess. Confirm on the person\'s profile."' : ''}>${escapeHtml(n)}${guess ? '?' : ''}<button type="button" class="cpc-x" data-name="${escapeAttr(n)}" title="Remove ${escapeAttr(n)}">×</button></span>`;
  }).join('');
}
// All the keyword tags that get embedded in the file at Finalize — so the user can SEE
// exactly what metadata will be written. This MUST agree with main's buildEmbedTags
// (main-mod/09-ipc-boot.js), or the preview promises keywords the file never gets.
// It drifted twice: main dedups case-INsensitively via uniqStrings() while this used a
// plain Set (so "Sunset" + "sunset" both showed here but only one was embedded), and main
// spreads m.keywords where this only read clip.tags. Keep the element order identical to
// main's list too — the preview is meant to be a literal readout of the embed.
function clipEmbedKeywords(clip) {
  const fieldVals = organizeFields.map((f) => clip[f.id]).filter(Boolean);
  const date = clip.date || '';
  const year = /^(\d{4})/.test(date) ? date.slice(0, 4) : '';
  // Mirrors main's uniqStrings(): trim, drop empties, dedup case-insensitively, first casing wins.
  const uniq = (arr) => {
    const seen = new Set(); const out = [];
    for (const x of (arr || [])) {
      const v = String(x == null ? '' : x).trim();
      if (v && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
    }
    return out;
  };
  const words = uniq(`${clip.subject || ''} ${clip.description || ''} ${clip.location || ''}`.split(/[\s\-_]+/));
  // clip.tags is what becomes meta.keywords when the clip is saved, so it occupies the
  // same slot main's m.keywords does. A clip loaded from saved metadata already has
  // .keywords — prefer that, since it is literally what main will be handed.
  const extra = Array.isArray(clip.keywords) ? clip.keywords : (Array.isArray(clip.tags) ? clip.tags : []);
  return uniq([
    clip.subject, clip.location, clip.shotType, clip.category, clip.project, ...fieldVals,
    ...extra,
    ...(Array.isArray(clip.people) ? clip.people : []),
    date, year, ...words,
  ]).filter((k) => k.length > 1);
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
  renderClipTags(i); scheduleDraftSave(); applyClipFilter();   // tags are in the filter haystack — keep visibility in sync (like people edits)
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
      renderClipTags(i); scheduleDraftSave(); renderCurrent(); applyClipFilter();   // keep the active filter in sync after a tag change
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
    ${people.length ? `<div class="pp-existing">${people.map((p) => `<button type="button" class="pp-opt" data-name="${escapeAttr(p.name)}"><span class="people-thumb">${personThumbHTML(p.thumb)}</span><span>${escapeHtml(p.name)}</span></button>`).join('')}</div>` : ''}
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
    ${others.length ? `<div class="pp-existing">${others.map((p) => `<button type="button" class="pp-opt" data-name="${escapeAttr(p.name)}"><span class="people-thumb">${personThumbHTML(p.thumb)}</span><span>${escapeHtml(p.name)}</span></button>`).join('')}</div>` : ''}
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
// Does this clip pass the ACTIVE filter? One predicate, so what you can SEE and what a bulk action
// TOUCHES can never disagree.
//
// This logic used to live inline in applyClipFilter, which only set card.style.display — while
// "select all" ticked every clip in state.scannedFiles regardless. So filtering to "Unnamed",
// hitting select-all and applying a subject silently overwrote every NAMED clip too: the ones
// deliberately hidden from view, that the user had already finished. A bulk edit must never reach a
// clip the user cannot see.
function clipMatchesFilter(c) {
  if (!c) return false;
  const q = (clipFilterText || '').trim().toLowerCase();
  const named = !!(c.subject && c.subject.trim());
  let ok = true;
  if (clipFilterMode === 'unnamed') ok = !named;
  else if (clipFilterMode === 'named') ok = named;
  else if (clipFilterMode === 'people') ok = Array.isArray(c.people) && c.people.length > 0;
  else if (clipFilterMode === 'selected') ok = !!c.selected;
  if (ok && q) {
    const hay = [c.name, c.subject, c.description, c.location, c.date, ...(Array.isArray(c.people) ? c.people : []), ...(Array.isArray(c.tags) ? c.tags : [])].filter(Boolean).join(' ').toLowerCase();
    ok = hay.includes(q);
  }
  return ok;
}
// Is a filter actually narrowing anything right now?
function clipFilterActive() { return clipFilterMode !== 'all' || !!(clipFilterText || '').trim(); }

// A new card starts with no filter.
//
// clipFilterMode/clipFilterText are module-level and were never reset, while ensureClipFilterBar()
// early-returns if the bar already exists — so a filter left on from the PREVIOUS card silently hid
// clips on the next one. With mode 'selected' and nothing yet ticked, the rename grid came up
// completely empty and looked like the scan had failed.
function resetClipFilter() {
  clipFilterMode = 'all';
  clipFilterText = '';
  const bar = document.getElementById('clipFilterBar');
  if (!bar) return;
  const input = bar.querySelector('.cf-input');
  if (input) input.value = '';
  bar.querySelectorAll('.cf-chip').forEach((b) => b.classList.toggle('active', b.dataset.f === 'all'));
}

function applyClipFilter() {
  const list = $('renameList'); if (!list) return;
  const q = (clipFilterText || '').trim().toLowerCase();
  const total = state.scannedFiles.length;
  // Count from STATE, not the DOM (audit #50). The list renders in 100-clip chunks, so tallying
  // `.rename-card` elements reported only what had scrolled into view — "2 of 3000" for a filter
  // that actually matched 50. That reads as "your search found nothing", which is the opposite of
  // true and exactly the kind of thing that makes the app not worth trusting.
  // (Visibility below still walks the DOM, because only rendered cards HAVE visibility. Cards
  // rendered later are filtered by the applyClipFilter() call at the end of each chunk.)
  const shown = state.scannedFiles.reduce((n, c) => (c && clipMatchesFilter(c) ? n + 1 : n), 0);
  list.querySelectorAll('.rename-card').forEach((card) => {
    const i = Number(card.dataset.i); const c = state.scannedFiles[i]; if (!c) return;
    const disp = clipMatchesFilter(c) ? '' : 'none';
    if (card.style.display !== disp) card.style.display = disp;   // only write when it changes (avoids layout thrash)
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
  const scoped = clipFilterActive();
  state.scannedFiles.forEach((c, j) => {
    if ((c.date || '') !== day) return;
    if (scoped && !clipMatchesFilter(c)) return;   // same rule as select-all: never tick what's hidden
    c.selected = true; nSel += 1;
    const cb = document.querySelector(`[data-check="${j}"]`); if (cb) cb.checked = true;
    const card = cb && cb.closest('.rename-card'); if (card) card.classList.add('selected');
  });
  updateBatchBar();
  showToast(`Selected ${nSel} clip${nSel !== 1 ? 's' : ''} from ${day || 'no date'}${scoped ? ' matching the filter' : ''} ✓`, 2000);
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

// GOPRO CHAPTERS ARE ONE RECORDING, not several clips.
//
// A GoPro splits a long take at ~4 GB and names the pieces `GX{chapter}{fileid}` — so `GX016817`,
// `GX026817` … `GX066817` are SIX pieces of one continuous shot. Measured on his real card: recording
// 6817 has 6 chapters, two others have 3, and several have 2 — about 13 of 37 raw clips are chapters
// of a take he already named.
//
// Returns the OTHER pieces of the same recording. Deliberately strict: same camera prefix, same
// 4-digit file id, different chapter. Two unrelated clips can share neither, so this cannot bind
// clips that are not literally the same shot.
function chapterSiblings(clip) {
  const m = /^(G[XHP])(\d{2})(\d{4})$/i.exec(String((clip && clip.origBase) || '').trim());
  if (!m) return [];
  const [, prefix, chapter, fileId] = m;
  return (state.scannedFiles || []).filter((c) => {
    if (!c || c === clip) return false;
    const n = /^(G[XHP])(\d{2})(\d{4})$/i.exec(String(c.origBase || '').trim());
    return !!n && n[1].toUpperCase() === prefix.toUpperCase() && n[3] === fileId && n[2] !== chapter;
  });
}

// Give the rest of a chaptered take the name he just typed — filling only what is still empty.
//
// Same rule as the shoot-day fill (2026-07-20af) at a tighter and less arguable scope: a shoot-day
// shares a subject 88% of the time, but chapters of one recording ARE the same shot. Never an
// overwrite: a chapter he has named differently on purpose stays as he left it.
function fillChapterSiblings(clip) {
  const sibs = chapterSiblings(clip);
  if (!sibs.length) return 0;
  let n = 0;
  for (const c of sibs) {
    let touched = false;
    if ((clip.subject || '').trim() && !(c.subject || '').trim()) { c.subject = clip.subject; touched = true; }
    if ((clip.description || '').trim() && !(c.description || '').trim()) { c.description = clip.description; touched = true; }
    if (touched) n += 1;
  }
  if (n) {
    try { refreshNames(); } catch { /* the field still holds what he typed */ }
    try { scheduleDraftSave(); } catch { /* saved on the next edit */ }
    showToast(`Also named ${n} more chapter${n !== 1 ? 's' : ''} of this recording — the camera split one take.`, 4500);
  }
  return n;
}

function wireRowEditing(listEl) {
  // WHERE HE IS. Recorded on focus of any field in a row, so a relaunch can put him back on the clip
  // he was working on rather than the top of a 400-clip list. Focus rather than input: moving through
  // the list to read is also "where he is", and it costs nothing (saveSession is debounced, and one
  // write per row-change is noise next to typing).
  listEl.querySelectorAll('input, textarea').forEach((el) => {
    const idxAttr = el.dataset.subject ?? el.dataset.desc ?? el.dataset.location;
    if (idxAttr === undefined) return;
    el.addEventListener('focus', () => {
      const c = state.scannedFiles[Number(idxAttr)];
      if (typeof noteClipPosition === 'function') noteClipPosition(c);
    });
  });
  listEl.querySelectorAll('[data-date]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openPopover) { closePopover(); return; }
      const i = Number(btn.dataset.date);
      openCalendar(btn, state.scannedFiles[i].date, (ds) => {
        const c = state.scannedFiles[i];
        if (ds) { c.date = ds; c.dateLocked = true; }   // user choice wins over metadata
        else {
          // Clear → back to the file's natural date (phone filename / mtime), UNLOCKED so ffprobe can
          // correct it. Locking to '' (the old always-lock path) is what made a wrong date un-clearable.
          c.date = (typeof phoneDateOf === 'function' && phoneDateOf(c.name)) || toDateStr(c.mtimeMs) || '';
          c.dateLocked = false;
        }
        refreshNames();
      });
    });
  });
  listEl.querySelectorAll('[data-subject]').forEach((inp) => {
    inp.addEventListener('input', () => {
      state.scannedFiles[Number(inp.dataset.subject)].subject = inp.value;
      refreshNames();
    });
    inp.addEventListener('change', () => { const c0 = state.scannedFiles[Number(inp.dataset.subject)]; recordAiEdit(c0, 'subject', inp.value); rememberSubject(inp.value); fillChapterSiblings(c0); });
    wireEditPlay(inp, Number(inp.dataset.subject));
    attachSubjectCombo(inp);
  });
  listEl.querySelectorAll('[data-desc]').forEach((inp) => {
    inp.addEventListener('input', () => {
      state.scannedFiles[Number(inp.dataset.desc)].description = inp.value;
      refreshNames();
    });
    inp.addEventListener('change', () => { const c0 = state.scannedFiles[Number(inp.dataset.desc)]; recordAiEdit(c0, 'description', inp.value); rememberDescription(inp.value); fillChapterSiblings(c0); });
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
// Find & replace across names (audit #73)
// ---------------------------------------------------------------------------
// The filter finds clips; nothing could CHANGE them in bulk. On a corpus of thousands that made a
// whole class of edit impractical — you misspell a subject on a 400-clip shoot, or a project gets
// renamed, and the only route was retyping it clip by clip or re-running the AI over the batch.
//
// Deliberately narrow: it edits the TEXT FIELDS the user owns (subject, description, location, and
// any custom organize fields), never filenames on disk. Nothing here touches a file — the rename is
// applied later by the existing copy path, so a bad replace is undone with the restore point below
// rather than by moving footage back.
const FR_FIELDS = [
  { id: 'subject', label: 'Subject' },
  { id: 'description', label: 'Description' },
  { id: 'location', label: 'Location' },
];
function frTargetFields() {
  // Custom organize fields are user-defined text too — excluding them would make this feel arbitrary
  // on a setup that renamed "project" to something else.
  const extra = (organizeFields || []).filter((f) => f && f.id && !FR_FIELDS.some((k) => k.id === f.id));
  return [...FR_FIELDS, ...extra.map((f) => ({ id: f.id, label: f.label || f.id }))];
}
/** Clips this replace would touch, plus a per-field preview count. Pure — used for the live preview. */
function frMatches(find, { fields, selectedOnly, matchCase, wholeWord }) {
  const needle = String(find || '');
  if (!needle) return { clips: [], hits: 0 };
  const re = frRegex(needle, { matchCase, wholeWord });
  const clips = []; let hits = 0;
  for (const clip of state.scannedFiles) {
    if (!clip) continue;
    if (selectedOnly && !clip.selected) continue;
    let n = 0;
    for (const f of fields) {
      const v = clip[f];
      if (typeof v !== 'string' || !v) continue;
      const m = v.match(re);
      if (m) n += m.length;
    }
    if (n) { clips.push(clip); hits += n; }
  }
  return { clips, hits };
}
function frRegex(needle, { matchCase, wholeWord }) {
  // Escape everything: this is a literal find, not a regex box. Users type things like "GX01" and
  // "C:\Projects" — treating those as patterns would be a footgun, and a bad pattern could silently
  // match nothing (or everything) across thousands of clips.
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = wholeWord ? `\\b${esc}\\b` : esc;
  return new RegExp(body, matchCase ? 'g' : 'gi');
}
async function applyFindReplace(find, replace, opts) {
  const { clips } = frMatches(find, opts);
  if (!clips.length) return 0;
  // Same protection as batch-apply (#34): a replace across a big batch is exactly the irreversible
  // bulk edit that restore points exist for. Honours the same auto-version preference.
  if (clips.length >= 8 && uiPrefs.autoVersionOnAi !== false) {
    await saveVersionPoint(`Before find & replace · ${clips.length} clips`, true);
  }
  const re = frRegex(find, opts);
  const indices = [];
  for (const clip of clips) {
    for (const f of opts.fields) {
      const v = clip[f];
      if (typeof v !== 'string' || !v) continue;
      clip[f] = v.replace(re, replace);
    }
    const i = state.scannedFiles.indexOf(clip);
    if (i >= 0) indices.push(i);
  }
  syncRowInputs(indices);
  refreshNames();
  scheduleDraftSave();
  return clips.length;
}
