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
      // Returns TRUE when Enter moved us to another field — i.e. this handler CONSUMED it.
      //
      // That return value is the fix for a real bug. This keydown is on the <input>; the batch
      // dialog's own keydown is on the overlay, an ancestor, in the bubble phase. Every Enter path
      // here ends in advance() → closePopover(), so by the time the overlay's handler ran, its guard
      // (`if (openPopover && openPopover._comboInput && openPopover._navigated) return;`) was checking
      // an openPopover that was ALWAYS null. The guard could never fire. So Enter in the batch
      // dialog's subject field advanced to the description AND applied the batch, closing the dialog
      // with description/location/context still empty — the whole subject→desc→location→context chain
      // wired into buildBatchDialog was dead code. Arrow-down + Enter did the same: it accepted the
      // suggestion and immediately applied.
      //
      // Enter on the LAST field (no getNext) still bubbles, so it submits the dialog — which is what
      // you'd want there.
      const advance = () => {
        ghost.innerHTML = ''; ghost.dataset.match = '';
        closePopover();
        const next = getNext && getNext();
        if (next) { next.focus(); return true; }
        input.blur();
        return false;
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
          e.stopPropagation();   // handled here — don't let an ancestor also act on it
        } else {
          // Just typing → keep what's typed (ignore the suggestion) and advance.
          if (advance()) e.stopPropagation();
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
      if (advance()) e.stopPropagation();
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

  // Walk the DOM, not the array index.
  //
  // This used to look for `.rename-card[data-i="${i + 1}"]` — the next clip by ARRAY POSITION. But
  // buildRenameStep renders GROUPED BY DAY, newest day first (dayDividers is on by default). With
  // clips 0-9 on the older day and 10-19 on the newer, the grid shows 10-19 first: Enter on the
  // visually-last card of that group (index 19) looked for index 20, found nothing, and blurred —
  // the sweep dead-ended in the middle of the list. And Enter on index 9 (the visually LAST card)
  // jumped to index 10, scrolling all the way back to the TOP.
  //
  // It also ignored two other things: cards past the 100-card render window don't exist in the DOM
  // yet (focusClip calls renameEnsureRendered for exactly this reason), and cards hidden by the
  // active filter are display:none — .focus() on them silently does nothing, so the sweep just lost
  // focus into a hidden row.
  //
  // Next-in-the-DOM, skipping hidden cards, is what the user actually means by "next clip".
  const visible = (el) => el.offsetParent !== null || el.style.display !== 'none';
  let nextCard = null;
  for (let el = card.nextElementSibling; el; el = el.nextElementSibling) {
    if (!el.classList || !el.classList.contains('rename-card')) continue;   // skip day dividers
    if (!visible(el)) continue;                                             // skip filtered-out clips
    nextCard = el;
    break;
  }
  // Nothing left in the DOM — but the list is windowed, so there may simply be another chunk to
  // render. Build it, then look again.
  if (!nextCard) {
    const i = Number(card.dataset.i);
    try { if (typeof renameEnsureRendered === 'function') renameEnsureRendered(i + 1); } catch { /* ignore */ }
    for (let el = card.nextElementSibling; el; el = el.nextElementSibling) {
      if (!el.classList || !el.classList.contains('rename-card')) continue;
      if (!visible(el)) continue;
      nextCard = el;
      break;
    }
  }
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

// SINGLE source of truth for field suggestions: what you've used THIS session (so the
// dropdown is useful immediately, even with no saved history) PLUS your saved history.
// EVERY subject/description/location combo — per-clip rows, the command bar, and the
// batch dialog — uses these, so they can never drift apart. Change suggestions in ONE
// place and it applies everywhere.
function sessionValues(field) {
  const out = [];
  for (const c of (state.scannedFiles || [])) { const v = String(c[field] || '').trim(); if (v && !out.includes(v)) out.push(v); }
  return out;
}
function subjectSuggestions() { return [...new Set([...sessionValues('subject'), ...subjectsCache])]; }
function descriptionSuggestions() { return [...new Set([...sessionValues('description'), ...descriptionsCache])]; }
function locationSuggestions() { return [...new Set([...sessionValues('location'), ...locationsCache])]; }

function attachSubjectCombo(input) {
  attachCombo(input, subjectSuggestions, () => nextDescField(input));
}
function attachDescriptionCombo(input) {
  attachCombo(input, descriptionSuggestions, () => afterDescription(input));
}
function attachLocationCombo(input) {
  attachCombo(input, locationSuggestions, () => afterLocation(input));
}
function attachFieldCombo(input, fieldId) {
  attachCombo(input, () => fieldHistoryCache[fieldId] || [], () => metaFieldNext(input));
}

