// Canonicalize a string to alnum-lowercase for loose comparison (distinct from slug()
// which keeps hyphens). Single source — was declared identically inside two functions.
const canon = (s) => String(s).replace(/[^a-z0-9]/gi, '').toLowerCase();

// ---------------------------------------------------------------------------
// Destination map — a clickable mock file-explorer showing where every clip will
// be filed in your real Projects tree. Base placement comes from the filename/
// metadata; "Suggest with AI" reads the real tree + clip content to refine it;
// you can move clips and create folders, then Apply files them (editable mode).
// ---------------------------------------------------------------------------

// THE PLAN — published so the Organize "Run" step files exactly where the map says.
//
// There used to be two filing systems that disagreed. The map (which the user actually
// interacts with, inline in Organize step 2) filed via projects:move into the Projects tree.
// The step-3 "Run" button called finalize:run, which ignored the map entirely and filed by
// [category, project] into the Compressed folder — and those two fields are normally EMPTY
// (the rename grid hides them by default, and the AI only sets a category that already
// exists). So subdirParts() returned [], organizeMove() found the file already in place, and
// Run reported "N skipped, 0 moved". The user planned a whole tree and Run did nothing.
//
// Now there is one plan. The map is the source of truth; Run just executes it (and adds the
// embed / NAS mirror / Resolve CSV on top).
// How many clips have no REAL home in this plan (audit #40).
//
// The Apply dialog used to count only clips with no placement at all — but recomputeAuto ALWAYS
// assigns one: a clip it can't place gets `<category>/_Unsorted`. So the count was permanently 0,
// the warning never rendered, and low-confidence clips filed silently into real _Unsorted folders
// in his tree. Count what actually happens.
//
// The `_Unsorted` test is ANCHORED to the trailing leaf: a genuine project called "Unsorted Beach
// Day" is a real home and must not be swept into the warning — a warning that cries wolf on normal
// runs stops being read, which would be worse than the silence it replaced.
function unplacedCounts(clips, placement) {
  let misc = 0; let unsorted = 0;
  for (const c of (clips || [])) {
    const rel = placement && placement[c.key];
    if (!rel) { misc += 1; continue; }
    if (/(^|\/)_Unsorted$/i.test(String(rel))) unsorted += 1;
  }
  return { misc, unsorted, total: misc + unsorted };
}

let lastDestPlan = null;   // { root, byPath: { [sourcePath]: 'Client/Alps-2026/2026-07-12' } }
function currentDestPlan() { return lastDestPlan; }
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
  // Say that the project MEMORY is reversed too, not just the files. Undo used to leave the
  // ledger behind, so an undone run kept matching future imports — the user needs to know
  // that's no longer the case, because "forget what it learned" is the point of undoing.
  const ok = await confirmDialog('Undo last organize?', `Move the ${info.count} filed clip${info.count !== 1 ? 's' : ''} back out of your Projects tree to where they came from, and forget what this run added to your project memory?`, 'Undo', 'Cancel');
  if (!ok) return;
  showToast('Undoing…', 2000);
  let r; try { r = await window.api.organizeUndo(); } catch (e) { r = { ok: false, error: e.message }; }
  if (r && r.ok) showToast(`Moved ${r.undone} clip${r.undone !== 1 ? 's' : ''} back${r.failed ? ` · ${r.failed} couldn’t be moved (already gone/renamed)` : ''}${r.ledgerReversed ? ` · ${r.ledgerReversed} project${r.ledgerReversed !== 1 ? 's' : ''} forgotten` : ''} ✓`, 5500);
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
  // Every recompute and every manual move funnels through render(), so this is the one place
  // that keeps the published plan in step with what the user is actually looking at.
  function publishPlan() {
    lastDestPlan = { root: String(root || '').replace(/[\\/]+$/, ''), byPath: { ...placement } };
  }
  function render() { publishPlan(); if (viewMode === 'tree') renderTreeView(); else renderPlan(); }
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
    if (remember) {
      // #42: "Remember" needs a subject/location to build a match rule from. On the Organize stage
      // those are usually still empty, so learnRouteFromGroup silently returned false — the user
      // ticked Remember and got NO rule and NO word about why. Tell them, instead of no-op-ing.
      if (await learnRouteFromGroup(g.keys, clean)) showToast('Got it — I’ll auto-file these next time ✓', 3800);
      else showToast('Can’t remember this one yet — these clips have no subject/keywords for me to match future footage on. Name them first, then tick Remember.', 5200);
    }
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
    if (!aiReady()) { if (!opts.silent) requireAi(); return 0; }
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
    // SEEDED, and this matters: an un-seeded array here was silent data loss. When the review grid
    // renders it calls schedulePendingSave(clusters) -> faces:savePending, which REPLACES the whole
    // pending store. So starting from [] meant an Analyze run quietly deleted every unconfirmed face
    // from an earlier scan. scanFacesForClips has always seeded this way ("a scan merges, never
    // replaces"); these callers just never got the same treatment.
    const faceClusters = await loadPendingFaces();
    await ensureFaceScenes();
    const faceAutoByName = new Map(); let faceAuto = 0;   // → "Review faces" popup at the end
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
    // Persist BEFORE the grid opens (or doesn't). An analyze run that found faces and was then
    // aborted, or whose grid the user never opened, previously lost every cluster it had built
    // while the clips stayed marked as scanned — so a re-scan skipped them and the faces were gone.
    try { savePendingNow(faceClusters); saveFaceScenesNow(); } catch { /* best-effort */ }
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
    if (!requireAi()) return;
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
        const res = await withBusyBtn(mk, 'Thinking…', () => window.api.aiParseRules({ text, folders: folderPaths }));
        if (res && res.ok && res.rules.length) { closeW(); showRoutingRules(folderPaths, () => { recomputeAuto(); renderTree(); }, clips.map((c) => ({ name: c.name, subject: c.subject, location: c.location, description: c.description, date: c.date })), res.rules); }
        else if (res) showToast(res.error ? res.error : 'No rules to propose from those answers');
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
        <div class="sc2-actions"><button type="button" class="btn sc2-back" ${idx === 0 ? 'disabled' : ''}>Back</button><button type="button" class="btn sc2-skip">Skip</button><button type="button" class="btn primary sc2-file" disabled>Pick or type a folder</button></div>`;
      const inp = body.querySelector('.sc2-input'); const fileBtn = body.querySelector('.sc2-file');
      const sync = (d) => { const has = !!d.trim(); body.querySelectorAll('.sc2-chip').forEach((b) => b.classList.toggle('on', b.dataset.dest === d.trim())); fileBtn.disabled = !has; fileBtn.textContent = has ? 'File here →' : 'Pick or type a folder'; };
      const doFile = async () => { await fileGroup(g, inp.value, body.querySelector('.sc2-rem').checked); idx += 1; show(); };
      body.querySelectorAll('.sc2-chip').forEach((b) => b.addEventListener('click', () => { inp.value = b.dataset.dest; sync(inp.value); }));
      inp.addEventListener('input', () => sync(inp.value));
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.value.trim()) { e.preventDefault(); doFile(); } });
      fileBtn.addEventListener('click', doFile);
      sync(inp.value);   // reflect any prefilled value in the button state/label on open
      body.querySelector('.sc2-skip').addEventListener('click', () => { idx += 1; show(); });
      body.querySelector('.sc2-back').addEventListener('click', () => { if (idx > 0) { idx -= 1; show(); } });
    }
    show();
  }

  // Primary action: analyze anything unseen (so the AI isn't guessing from a bare
  // label), then run the placement pass inline — no separate wizard to wade through.
  async function aiPlanFlow() {
    if (!requireAi()) return;
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
      // CONFIRM FIRST. Apply MOVES every clip on the map — including anything still sitting in
      // "Needs you"/_Unsorted, which lands in `misc`. It went straight through with no confirmation
      // at all, which is a lot of file movement to trigger with one click. Say what will happen,
      // and call out the clips that have no real home yet, since those are the ones you'd regret.
      // Count what will ACTUALLY happen — including the _Unsorted placements the old check was blind
      // to (audit #40). Name the real destination too: saying "misc" when the clips land in
      // `<category>/_Unsorted` sent people looking for a folder that was never created.
      const { misc: miscN, unsorted: unsortedN, total: homelessN } = unplacedCounts(clips, placement);
      const folders = new Set(moves.map((m) => m.rel)); folders.delete('misc');
      const where = (miscN && unsortedN) ? '<b>misc</b> and <b>_Unsorted</b>'
        : (miscN ? '<b>misc</b>' : '<b>_Unsorted</b>');
      const ok = await confirmDialog(
        `File ${moves.length} clip${moves.length !== 1 ? 's' : ''} into your Projects tree?`,
        `They move into ${escapeHtml(rootClean)} across ${folders.size} folder${folders.size !== 1 ? 's' : ''}${embed ? ', with their metadata embedded' : ''}.`
        + (homelessN ? `<br><br>⚠ ${homelessN} clip${homelessN !== 1 ? 's have' : ' has'} no real home on the map and will go into ${where} — go back and place ${homelessN !== 1 ? 'them' : 'it'} if that's not what you want.` : '')
        + `<br><br>You can undo this straight afterwards.`,
        'File them', 'Cancel'
      );
      if (!ok) return;
      const btn = q('.dmap-apply'); btn.disabled = true; btn.textContent = embed ? 'Embedding & filing…' : 'Filing…';
      aiActivity(embed ? 'Embedding metadata and filing clips…' : 'Filing clips…', '');
      // Bulk moves + exiftool embedding: this REJECTS in the real world (locked file, EPERM).
      // Without the finally, Apply stayed disabled reading "Filing…" and the aiActivity
      // spinner span forever — the dialog was dead with no way back.
      let r = null;
      // Honor "Keep the originals" — Apply used to always MOVE, deleting the L: archive source. Default
      // to copy (safe) when the toggle isn't in the DOM.
      const copy = $('finKeepSource') ? !!$('finKeepSource').checked : true;
      try {
        r = await window.api.projectsMove({ moves, embed, copy, root: rootClean });
      } catch (e) {
        const msg = (e && e.message) || String(e);
        aiActivityDone(`Filing failed — ${msg}`);
        showToast(`Filing failed — ${msg}`, 6000);
        logIssue('Organize', msg);
        return;
      } finally {
        btn.disabled = false; btn.textContent = 'Apply — file clips';
      }
      const okN = (r && r.results || []).filter((x) => x.ok).length;
      const failN = (r && r.results || []).length - okN;
      // Remember every filed clip in the project ledger (powers same-shoot detection
      // + the per-project AI summary), then refresh summaries for touched projects.
      try { recordToLedger(clips, placement, r.results || []); } catch (e) { /* non-fatal */ }
      aiActivityDone(`Filed ${okN}${failN ? `, ${failN} failed` : ''} into your Projects tree ✓`);
      // Offer the undo RIGHT HERE. projects:move already records everything needed to reverse the
      // run (config.lastOrganize, main-mod/02-media.js:427) and undoLastOrganize() has always
      // worked — it was just buried in a menu, so at the one moment you'd want it (having watched
      // 200 clips move somewhere you didn't intend) you had no idea it existed.
      if (okN) showToastAction(`Filed ${okN}${failN ? `, ${failN} failed` : ''} ✓`, 'Undo', () => undoLastOrganize(), failN ? 10000 : 8000);
      else showToast(`Nothing was filed${failN ? ` — ${failN} failed` : ''}`, 6000);
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
    // scroll-reset-ok: this list is the RESULT OF A SEARCH — a new query should start at the top.
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
        if (!requireAi()) return;
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
    // _ledgerRel — the same-shoot project the user already confirmed. The inline map (renderFinMap)
    // carries it; this second entry point did not, so opening the map from HERE quietly lost the
    // decision and dropped those clips into _Unsorted. Two call sites, one had the bug.
    showDestinationMap(sel.map((f) => ({ name: f.name, sourcePath: f.sourcePath, subject: f.meta && f.meta.subject, description: f.meta && f.meta.description, location: f.meta && f.meta.location, date: f.meta && f.meta.date, people: (f.meta && f.meta.people) || [], shotType: f.meta && f.meta.shotType, tags: (f.meta && f.meta.tags) || [], _ledgerRel: (f.meta && f.meta.ledgerRel) || '', _ref: f })), {
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
    // Deleting or editing a rule re-renders the whole list — don't lose the user's place.
    const keepTop = list ? list.scrollTop : 0;
    if (list) setTimeout(() => { list.scrollTop = keepTop; }, 0);
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
        <button type="button" class="re-kindbtn ${kind === 'descriptor' ? 'sel' : ''}" data-k="descriptor">It's just a label (vlog, timelapse…) — not its own folder</button>
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
      if (!requireAi()) return;
      const btn = pq('.re-interpret');
      const res = await withBusyBtn(btn, '…', () => window.api.aiParseRules({ text, folders: folderPaths }));
      if (res && res.ok && res.rules.length) { closeP(false); verifyRules(res.rules); }
      else if (res) showToast(res.error ? res.error : 'Could not interpret that');
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
// PLACEMENT REVIEW — the face-confirm grid, for projects.
//
// The face-review grid is the best interaction in this app: it SHOWS you the thing, makes a
// confident suggestion ("Is this Jake?"), gives you tap-chips of the people you already have, and
// batches the whole lot onto one page so confirming is one tap. This is that, for filing.
//
// It is one card per SUBJECT GROUP, not per clip. Grouping clips by subject needs no model at all —
// it's deterministic — so a card of 309 clips becomes ~15 decisions instead of 309, and every clip
// in a shoot is guaranteed to land together. The old per-clip approach could scatter one shoot
// across three projects.
//
// Every card's suggestion comes from ai:placeGroup, where the model SEARCHED the real tree and READ
// what's actually inside the candidate projects. When it genuinely can't tell, it calls ask_user and
// the card simply arrives with no suggestion and the candidates as chips — which is exactly the
// "Who is this?" state of the face grid.
// ---------------------------------------------------------------------------

// Group clips deterministically: same subject (and same date, when the project files by day).
// A group is a SHOOT, not a subject.
//
// This grouped by subject alone, so every lawn-mowing clip he has ever shot — June 1st at Josiah's,
// June 12th somewhere else, May 16th — collapsed into ONE card and was filed into ONE project. Two
// different jobs, one answer, and no way to tell them apart. Different shoots are different projects,
// so they are different questions.
function groupClipsForPlacement(clips) {
  const groups = new Map();
  for (const c of (clips || [])) {
    const subj = slug(c.subject || '') || '_unnamed';
    const day = String(c.date || '').slice(0, 10);
    const key = `${day}|${subj}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        subject: c.subject || '',
        description: c.description || '',
        location: c.location || '',
        date: day,
        observation: c.observation || '',
        people: [],
        clips: [],
      });
    }
    const g = groups.get(key);
    g.clips.push(c);
    for (const p of (Array.isArray(c.people) ? c.people : [])) if (!g.people.includes(p)) g.people.push(p);
    if (!g.observation && c.observation) g.observation = c.observation;
    if (!g.location && c.location) g.location = c.location;
  }
  return [...groups.values()];
}

async function showPlacementReview(clips, opts = {}) {
  const groups = groupClipsForPlacement(clips);
  if (!groups.length) { showToast('Nothing to file'); return null; }

  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal face-grid">
      <div class="fg-head">
        <div><b>Where should these go?</b><div class="muted small pr-status">Asking the AI — it's searching your Projects tree…</div></div>
        <button type="button" class="btn fg-done">Done</button>
      </div>
      <div class="face-grid-scroll pr-scroll"></div>
    </div>`;
    document.body.appendChild(ov);
    const scroll = ov.querySelector('.pr-scroll');
    const status = ov.querySelector('.pr-status');

    const close = () => {
      ov.remove();
      resolve(groups.filter((g) => g.chosen).map((g) => ({ clips: g.clips, path: g.chosen })));
    };
    ov.querySelector('.fg-done').addEventListener('click', close);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });

    const render = () => {
      scroll.innerHTML = groups.map((g, i) => {
        const n = g.clips.length;
        const seen = `${n} clip${n !== 1 ? 's' : ''}${g.date ? ` · ${g.date}` : ''}`;
        const thumb = g.poster
          ? `<img src="${escapeAttr(g.poster)}" alt=""/>`
          : '<span class="face-ph-icon">🎞</span>';

        if (g.chosen) {
          const why = g.recalled ? 'you filed this here before' : (g.suggest ? '' : 'you chose this');
          return `<div class="face-grid-card-item confirmed" data-i="${i}">
            <div class="fgc-photo">${thumb}<span class="fgc-badge">✓</span></div>
            <div class="fgc-name">${escapeHtml([g.date, g.subject || 'unnamed'].filter(Boolean).join(' '))}</div>
            <div class="fgc-sub muted small">→ ${escapeHtml(g.chosen)}${why ? ` · ${escapeHtml(why)}` : ''}</div>
            <button class="fgc-undo" data-i="${i}">Undo</button>
          </div>`;
        }
        if (g.pending) {
          return `<div class="face-grid-card-item" data-i="${i}">
            <div class="fgc-photo">${thumb}</div>
            <div class="fgc-name">${escapeHtml(g.subject || 'unnamed')}</div>
            <div class="fgc-sub muted small">${seen}</div>
            <div class="fgc-sub muted small">Thinking…</div>
          </div>`;
        }

        const chips = (g.options || []).slice(0, 6)
          .map((o) => `<button class="fgc-chip" data-i="${i}" data-path="${escapeAttr(o)}">${escapeHtml(o.split('/').pop())}</button>`).join('');

        // A confident suggestion → the "Is this Jake?" state. No suggestion → the "Who is this?" state.
        if (g.suggest) {
          const leaf = g.suggest.split('/').pop();
          const parent = g.suggest.split('/').slice(0, -1).join(' / ');
          return `<div class="face-grid-card-item suggested${g.isNew ? ' is-new' : ''}" data-i="${i}">
            <div class="fgc-photo">${thumb}</div>
            <div class="fgc-q">${g.isNew ? 'Create' : 'File into'} <b>${escapeHtml(leaf)}</b>?</div>
            ${parent ? `<div class="fgc-sub muted small fgc-parent">in ${escapeHtml(parent)}</div>` : ''}
            <div class="fgc-sub muted small">${seen}${g.why ? ` · ${escapeHtml(g.why)}` : ''}</div>
            <div class="fgc-btns"><button class="fgc-yes pr-yes" data-i="${i}">✓ ${g.isNew ? 'Create it' : 'Yes'}</button><button class="fgc-no pr-no" data-i="${i}">✗ Somewhere else</button></div>
            <input type="text" class="ai-input fgc-input pr-input" data-i="${i}" placeholder="${g.isNew ? 'or rename it…' : 'or type a project name…'}" autocomplete="off"/>
            ${chips ? `<div class="fgc-chips compact">${chips}</div>` : ''}
          </div>`;
        }
        const shootLabel = [g.date, g.subject || 'this'].filter(Boolean).join(' ');
        return `<div class="face-grid-card-item" data-i="${i}">
          <div class="fgc-photo">${thumb}</div>
          <div class="fgc-q">Where does the <b>${escapeHtml(shootLabel)}</b> shoot go?</div>
          <div class="fgc-sub muted small">${seen}${g.question ? ` · ${escapeHtml(g.question)}` : ''}</div>
          <input type="text" class="ai-input fgc-input pr-input" data-i="${i}" placeholder="type a project name…" autocomplete="off"/>
          ${chips ? `<div class="fgc-chips compact">${chips}</div>` : ''}
        </div>`;
      }).join('');

      const left = groups.filter((g) => !g.chosen && !g.pending).length;
      status.textContent = left
        ? `${left} to confirm — tick the ones it got right.`
        : (groups.some((g) => g.pending) ? 'Asking the AI…' : 'All set — press Done to file them.');
    };

    // Confirming is the moment the app LEARNS. The user's answer is the ground truth — not the
    // model's suggestion — so it is remembered permanently, and the same footage is never asked about
    // again. This is the whole of "it only ever asks it once and then it knows".
    //
    // Remember and forget both WRITE the same record, so they are chained rather than fired loose: a
    // pick immediately followed by an undo must not land in the other order and leave the memory set.
    let memWrites = Promise.resolve();
    const learn = (fn) => { memWrites = memWrites.then(fn).catch(() => {}); };   // never blocks the UI

    const pick = (i, path) => {
      const p = String(path || '').trim();
      if (!p) return;
      const g = groups[i];
      g.chosen = p;
      learn(() => window.api.aiRememberPlacement({ date: g.date, subject: g.subject, people: g.people, location: g.location, path: p }));
      render();
    };

    // And UNDO HAS TO ACTUALLY UNDO. An `exact` recall auto-files a shoot with no card and no
    // question, so this button is the only way he can ever correct a placement the app got wrong.
    // Clearing `g.chosen` alone left the memory that CAUSED the auto-file in config — undo it, close
    // the review, and the same wrong project is chosen again next time, silently, forever.
    //
    // Then ASK again, rather than dropping him on an empty text box: `g.options` (the one-click chips)
    // is only ever filled from the model's own search trace, and a recalled group never had one — so
    // an undo with nothing behind it means typing a project path from memory to fix the app's mistake.
    // Re-asking AFTER forgetting is what makes it honest: the model calls recall_decision first, and
    // now correctly finds nothing to recall.
    const undo = (i) => {
      const g = groups[i];
      g.chosen = '';
      g.recalled = 0;
      g.suggest = '';
      learn(() => window.api.aiForgetPlacement({ date: g.date, subject: g.subject, people: g.people }));
      render();
      // Only worth a model call if we have nothing else to show him. An undone SUGGESTION already has
      // its chips from the search that produced it.
      //
      // Queued on `learn` so the FORGET lands first (or the model's recall_decision would hand back
      // the very record we are deleting), and via queueAsk so it waits for the initial pass instead of
      // racing it onto the GPU.
      if (!g.options || !g.options.length) learn(() => queueAsk(g));
    };

    scroll.addEventListener('click', (e) => {
      const t = e.target;
      const i = Number(t.dataset && t.dataset.i);
      if (t.classList.contains('pr-yes')) return pick(i, groups[i].suggest);
      if (t.classList.contains('pr-no')) { groups[i].suggest = ''; render(); return; }
      if (t.classList.contains('fgc-chip')) return pick(i, t.dataset.path);
      if (t.classList.contains('fgc-undo')) return undo(i);
    });
    scroll.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.classList.contains('pr-input')) return;
      e.preventDefault();
      pick(Number(e.target.dataset.i), e.target.value);
    });

    render();

    // Ask the model where ONE group goes. Extracted so `undo` can re-ask: without it, undoing a wrong
    // auto-file left him with a bare text box and no chips (`g.options` is only ever filled from the
    // model's own search trace), i.e. typing a project path from memory to fix the app's mistake.
    // Forgetting BEFORE we re-ask is what makes this honest — the model calls recall_decision first,
    // and now correctly finds nothing.
    const askModel = async (g) => {
      g.pending = true; render();
      try {
        const poster = g.clips[0] && g.clips[0].sourcePath ? await window.api.getPoster(g.clips[0].sourcePath) : '';
        if (poster) g.poster = poster;
      } catch { /* a missing thumbnail is cosmetic */ }
      let r = null;
      try {
        r = await window.api.aiPlaceGroup({
          subject: g.subject, description: g.description, observation: g.observation,
          people: g.people, location: g.location, date: g.date, count: g.clips.length,
        });
      } catch (e) { r = { ok: false, error: (e && e.message) || String(e) }; }
      g.pending = false;

      if (!r || !r.ok) {
        g.question = (r && r.error) || 'the AI could not answer';
        g.options = [];
      } else if (r.action === 'suggest') {
        // A familiar subject on a DIFFERENT shoot. The model was never asked — the app decided this
        // is his call, because handed the choice the model files into the old project every time.
        g.suggest = r.path;
        g.why = r.why || '';
      } else if (r.action === 'place' || r.action === 'create') {
        g.suggest = r.path;
        // "AI proposes a folder, you confirm" — so SAY it is a new folder, and say why nothing
        // existing fitted. A card that looks identical whether it files into a project he has had
        // for a year or creates one out of thin air is not a confirmation, it is a rubber stamp.
        g.isNew = r.action === 'create';
        g.why = r.action === 'create' ? (r.why || "nothing you have fits this") : '';
        g.options = (r.trace || [])
          .filter((t) => t.tool === 'search_projects' && t.result && t.result.matches)
          .flatMap((t) => t.result.matches.map((m) => m.path))
          .filter((p) => p !== r.path).slice(0, 6);
      } else {
        // ask_user — exactly the face grid's "Who is this?" card.
        g.question = r.question || '';
        g.options = r.options && r.options.length ? r.options : (r.trace || [])
          .filter((t) => t.tool === 'search_projects' && t.result && t.result.matches)
          .flatMap((t) => t.result.matches.map((m) => m.path)).slice(0, 6);
      }
      render();
    };

    // ⚠ EVERY model call goes through this ONE queue — the initial pass AND a re-ask from undo.
    //
    // `for (const g of groups) { await … }` looks like it already guarantees one-at-a-time, and on its
    // own it did. It does NOT survive `undo` re-asking: that fires from a click handler, OUTSIDE the
    // loop, so it would run straight into the middle of it and put two tool loops on the GPU at once.
    // Same model, so it does not OOM the way vision-plus-text does — it doubles the KV cache on a 6 GB
    // card instead, and both crawl. The rule is one model call in flight, and it has to hold for calls
    // the USER starts, not just the ones the loop starts.
    let modelQueue = Promise.resolve();
    const queueAsk = (g) => {
      modelQueue = modelQueue.then(() => askModel(g)).catch(() => {});
      return modelQueue;
    };

    // Ask about each group — one at a time, so the GPU only ever holds one model, and the cards fill
    // in as answers arrive rather than making the user stare at a spinner.
    (async () => {
      for (const g of groups) {
        // Already told us? Then it is not a question. No model call, no card to confirm — it is just
        // done, with a note saying why, so the user can still see (and undo) what it did.
        try {
          const known = await window.api.aiRecallPlacement({
            date: g.date, subject: g.subject, people: g.people, location: g.location,
          });
          if (known && known.path && known.confidence === 'exact') {
            // The SAME shoot, already decided. This is the only case that may skip the question.
            g.chosen = known.path;
            g.recalled = known.told_before || 1;
            render();
            continue;
          }
          if (known && known.path && known.confidence === 'likely') {
            // A different shoot that looks familiar. Offer it — one click — but never file it silently.
            g.suggest = known.path;
            g.why = known.from_shoot
              ? `you filed the ${known.from_shoot} ${g.subject} shoot here`
              : `you filed ${g.subject} here before`;
            render();
            continue;   // a good suggestion he can accept in one click beats a model call
          }
        } catch { /* fall through to asking the model */ }

        await queueAsk(g);
      }
    })();
  });
}
