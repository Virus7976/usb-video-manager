// ---------------------------------------------------------------------------
// PROJECT LEDGER — persistent memory of every project footage is filed into.
// Built automatically as clips are filed (projects:move via the destination map).
// Powers: (1) recognizing a later import from the same shoot and offering the same
// project, and (2) an AI summary per project for indexing/search later.
// ---------------------------------------------------------------------------
// The project-level key. The tree is YEAR / YEAR-Category / Project / Day…, so the
// project is the first THREE segments — day folders and inner layout (…/Day 3/
// Footage) collapse into the one project record. Shorter rels use what's there.
function ledgerKeyFromRel(rel) {
  const segs = String(rel || '').replace(/\\/g, '/').split('/').map((s) => s.trim()).filter(Boolean);
  if (!segs.length) return '';
  return segs.slice(0, Math.min(3, segs.length)).join('/');
}
function ledgerFind(key) { return (config.projectLedger || []).find((p) => p.rel === key) || null; }
function ledgerMerge(arr, vals, cap) {
  const set = new Set((arr || []).filter(Boolean));
  for (const v of (Array.isArray(vals) ? vals : [vals])) { const s = String(v || '').trim(); if (s) set.add(s); }
  return [...set].slice(-(cap || 200));
}
// Merge into rec[field], and remember on the undo-delta exactly which values were NEW.
// Tracking the ADDITIONS (rather than snapshotting the record) is what lets undo take back
// this run's contribution without stripping a date/subject an earlier clip also justifies.
function ledgerMergeTracked(rec, d, field, vals, cap) {
  const had = new Set(rec[field] || []);
  rec[field] = ledgerMerge(rec[field], vals, cap);
  for (const v of rec[field]) if (!had.has(v) && !d[field].includes(v)) d[field].push(v);
}
// Reverse the ledger additions made by the organize run being undone (audit #37).
// Undo used to move the FILES back and leave the ledger untouched, so an undone run left a
// phantom project behind — a record still carrying the clip counts, dates and subjects of
// footage that is no longer filed there. `ledger:matchDates` / `search_projects` keep scoring
// FUTURE imports against those phantoms, so one bad Organize permanently poisoned placement.
//
// This is a PRECISE DIFF, never a snapshot-restore: `ledger:summarize` writes summary/keywords
// onto the same record after filing, and rolling back to a pre-filing snapshot would silently
// throw that summary away.
function reverseLastLedger(runTs) {
  const ll = config.lastLedger;
  if (!ll || !Array.isArray(ll.delta) || !ll.delta.length) return 0;
  // Only reverse a delta recorded as part of THIS run. A run that filed nothing into the
  // ledger must not reach back and undo an earlier run's memory.
  if (runTs && ll.ts < runTs) return 0;
  let n = 0;
  for (const d of ll.delta) {
    const idx = (config.projectLedger || []).findIndex((p) => p.rel === d.key);
    if (idx < 0) continue;
    // The run is the only reason this project exists — remove it outright.
    if (d.created) { config.projectLedger.splice(idx, 1); n += 1; continue; }
    const rec = config.projectLedger[idx];
    const drop = (field) => {
      const kill = new Set(d[field] || []);
      if (kill.size) rec[field] = (rec[field] || []).filter((v) => !kill.has(v));
    };
    drop('dates'); drop('subjects'); drop('locations'); drop('people');
    const killNames = new Set(d.clipNames || []);
    if (killNames.size) rec.clipNames = (rec.clipNames || []).filter((v) => !killNames.has(v));
    // Clamp at 0: the 8000-name cap can already have evicted some of what this run added,
    // and a negative clip count would read as corruption everywhere downstream.
    rec.clips = Math.max(0, (rec.clips || 0) - (d.clips || 0));
    // Samples are appended then tail-capped, so this run's are the last ones on the list.
    if (d.samples) rec.samples = (rec.samples || []).slice(0, Math.max(0, (rec.samples || []).length - d.samples));
    if (d.prevLastSeen) rec.lastSeen = d.prevLastSeen;
    n += 1;
  }
  // Consume the delta so a repeated undo can't reverse the same additions twice.
  config.lastLedger = null;
  saveStore('projectLedger'); saveConfig();
  return n;
}
ipcMain.handle('ledger:get', () => {
  const list = Array.isArray(config.projectLedger) ? config.projectLedger.slice() : [];
  list.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  return list;
});
// Record filed clips into their project records (called after a successful file).
// THE ledger write. Owned by one function so BOTH filing paths record identically — the map's
// "Apply" (via the ledger:record IPC) and step-3 "Run" (finalize:run, which calls this directly).
// Run used to record NOTHING, so filing that way silently lost all same-shoot placement learning:
// the ledger is what makes a later import from the same shoot offer the same project, and the shoot
// DATE is the strongest signal this app has (see usb-app-shoots-in-batches).
function recordLedgerEntries(list) {
  const entries = Array.isArray(list) ? list : [];
  if (!Array.isArray(config.projectLedger)) config.projectLedger = [];
  const now = Date.now();
  const touched = new Set();
  // What this call ADDS, so organize:undo can take it back (audit #37 — see reverseLastLedger).
  const delta = new Map();
  const deltaFor = (key, rec, created) => {
    let d = delta.get(key);
    if (!d) {
      d = { key, created, prevLastSeen: created ? 0 : (rec.lastSeen || 0), clips: 0, clipNames: [], dates: [], subjects: [], locations: [], people: [], samples: 0 };
      delta.set(key, d);
    }
    return d;
  };
  for (const en of entries) {
    const key = ledgerKeyFromRel(en && en.rel);
    if (!key) continue;
    // _Unsorted / misc are holding pens, not projects. Recording them made "_Unsorted" a first-class
    // ledger project that polluted search_projects and date-matching — so future footage could be
    // "matched" into _Unsorted. Never record them.
    if (/(^|\/)(_?unsorted|misc)$/i.test(key)) continue;
    let rec = ledgerFind(key);
    const createdNow = !rec;
    if (!rec) {
      const segs = key.split('/');
      const category = segs.slice(0, Math.min(2, segs.length)).join('/');   // YEAR/YEAR - Category
      rec = { id: newMemId(), rel: key, name: segs[segs.length - 1], category, dates: [], subjects: [], locations: [], people: [], samples: [], clips: 0, clipNames: [], summary: '', summaryClips: 0, firstSeen: now, lastSeen: now };
      config.projectLedger.push(rec);
    }
    const d = deltaFor(key, rec, createdNow);
    rec.lastSeen = now;
    if (en.date) ledgerMergeTracked(rec, d, 'dates', en.date, 400);
    if (en.subject) ledgerMergeTracked(rec, d, 'subjects', en.subject, 200);
    if (en.location) ledgerMergeTracked(rec, d, 'locations', en.location, 80);
    if (Array.isArray(en.people) && en.people.length) ledgerMergeTracked(rec, d, 'people', en.people, 80);
    // Count each clip ONCE per project (identity = the filed name). A retry or an undo-then-reapply
    // refiles the same clips; `rec.clips += 1` per entry used to inflate the count every time. Dedupe
    // against the names already counted for this project.
    const cname = String(en.name || '').toLowerCase();
    if (cname) {
      if (!Array.isArray(rec.clipNames)) rec.clipNames = [];
      if (!rec.clipNames.includes(cname)) {
        rec.clipNames.push(cname);
        if (rec.clipNames.length > 8000) rec.clipNames = rec.clipNames.slice(-8000);
        rec.clips = (rec.clips || 0) + 1;
        d.clipNames.push(cname); d.clips += 1;
      }
    } else {
      rec.clips = (rec.clips || 0) + 1;   // no name to dedupe on → keep the old behavior
      d.clips += 1;
    }
    // Keep a rolling sample of the richest detail for the AI summary (cap 60).
    if (en.subject || en.description || en.observation) {
      rec.samples = (rec.samples || []).concat([{ subject: en.subject || '', description: en.description || '', observation: (en.observation || '').slice(0, 240), people: Array.isArray(en.people) ? en.people : [], date: en.date || '' }]).slice(-60);
      d.samples += 1;
    }
    touched.add(key);
  }
  // Cap the ledger so config.json can't grow without bound — keep the most recently
  // seen projects (every other store in config is capped; this was the one that wasn't).
  if (config.projectLedger.length > 4000) {
    config.projectLedger.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    config.projectLedger = config.projectLedger.slice(0, 4000);
  }
  if (touched.size) {
    // Stash the reversal delta beside the run itself. Keeping this MAIN-side means BOTH filing
    // paths (projects:move and finalize:run) get a reversible ledger for free — the renderer
    // already calls ledger:record after each of them, so neither has to thread anything back.
    config.lastLedger = { ts: Date.now(), delta: [...delta.values()] };
    saveStore('projectLedger'); saveConfig();
  }
  return { ok: true, projects: [...touched] };
}
ipcMain.handle('ledger:record', (_e, payload) => recordLedgerEntries(payload && payload.entries));
// Find ledger projects whose dates overlap the given dates (a later import from the
// same shoot). Returns light records the renderer uses to offer "add to this project".
ipcMain.handle('ledger:matchDates', (_e, payload) => {
  const want = new Set((payload && Array.isArray(payload.dates) ? payload.dates : []).map((d) => String(d || '').trim()).filter(Boolean));
  if (!want.size) return [];
  // Score relatedness by CONTENT (subject / people / location overlap), not just a
  // shared date — so unrelated footage shot the same day isn't pulled into a project.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const tokenSet = (arr) => { const s = new Set(); for (const x of (arr || [])) for (const t of norm(x).split(' ')) if (t && t.length > 1) s.add(t); return s; };
  const overlap = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n += 1; return n; };
  const wantSubj = tokenSet(payload && payload.subjects);
  const wantPpl = new Set(((payload && payload.people) || []).map(norm).filter(Boolean));
  const wantLoc = tokenSet(payload && payload.locations);
  const out = [];
  for (const rec of (config.projectLedger || [])) {
    if (!rec || !rec.clips) continue;
    const shared = (rec.dates || []).filter((d) => want.has(d));
    if (!shared.length) continue;
    const subjOv = overlap(wantSubj, tokenSet(rec.subjects));
    const pplOv = overlap(wantPpl, new Set((rec.people || []).map(norm).filter(Boolean)));
    const locOv = overlap(wantLoc, tokenSet(rec.locations));
    const contentOverlap = subjOv + pplOv + locOv;
    const score = pplOv * 3 + subjOv * 2 + locOv * 2 + shared.length * 0.4;
    out.push({ rel: rec.rel, name: rec.name, category: rec.category, dates: rec.dates, sharedDates: shared, clips: rec.clips, summary: rec.summary || '', people: rec.people || [], subjects: (rec.subjects || []).slice(0, 12), score, related: contentOverlap > 0 });
  }
  // Surface genuinely-related projects first; date-only matches rank last (and the
  // renderer can choose to ignore them).
  out.sort((a, b) => Number(b.related) - Number(a.related) || b.score - a.score || b.clips - a.clips);
  return out;
});
// Generate (or refresh) the AI summary for one project from its accumulated detail.
ipcMain.handle('ledger:summarize', async (_e, payload) => {
  const key = ledgerKeyFromRel(payload && payload.rel);
  const rec = ledgerFind(key);
  if (!rec) return { ok: false, error: 'Unknown project' };
  const model = aiTextModel();
  if (!model) return { ok: false, error: 'No model selected' };
  const samples = (rec.samples || []).slice(-40);
  const lines = samples.map((s, i) => `${i + 1}. ${[s.subject, s.description].filter(Boolean).join(' / ')}${s.observation ? ` — seen: ${s.observation}` : ''}${(s.people || []).length ? ` [people: ${s.people.join(', ')}]` : ''}${s.date ? ` (${s.date})` : ''}`).join('\n');
  const dateSpan = (() => { const ds = (rec.dates || []).filter(Boolean).sort(); return ds.length ? (ds[0] === ds[ds.length - 1] ? ds[0] : `${ds[0]} – ${ds[ds.length - 1]}`) : ''; })();
  const prompt = `Write a SHORT factual summary of one video project so it can be found later by search. Project folder: "${rec.name}". ${dateSpan ? `Filmed: ${dateSpan}. ` : ''}${(rec.people || []).length ? `People: ${rec.people.join(', ')}. ` : ''}${(rec.locations || []).length ? `Places: ${rec.locations.join(', ')}. ` : ''}\nClips filed here so far (${rec.clips}):\n${lines || '(no detail yet)'}\n\nReturn STRICT JSON only: {"summary":"2-3 sentences, what this project is, who/what's in it, where & when — concrete and searchable, no fluff","keywords":["6-12 lowercase search keywords"]}`;
  try {
    const o = parseJsonLoose(await ollamaGenerate(model, prompt, { format: 'json', temperature: 0.3, timeout: 120000, think: false }));
    const summary = String((o && o.summary) || '').trim();
    if (!summary) return { ok: false, error: 'Empty summary' };
    rec.summary = summary;
    rec.keywords = Array.isArray(o && o.keywords) ? o.keywords.map((k) => String(k || '').trim().toLowerCase()).filter(Boolean).slice(0, 12) : (rec.keywords || []);
    rec.summaryClips = rec.clips;
    rec.summaryAt = Date.now();
    saveStore('projectLedger');
    return { ok: true, summary, keywords: rec.keywords };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Discover the COMMON subfolder layout inside the existing project folders under
// `rel` — e.g. if every "Day N" folder contains a "Footage" subfolder (or
// "Footage/Selects"), return that path so new day folders mirror it and the clips
// land where the others keep theirs. Returns '' when there's no shared structure.
ipcMain.handle('projects:innerLayout', async (_e, payload) => {
  const root = config.projectsRoot || defaultProjectsRoot();
  const rel = String((payload && payload.rel) || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!rel) return { ok: true, inner: '' };
  const base = path.join(root, ...rel.split('/'));
  const dirs = async (d) => {
    try { const es = await fsp.readdir(d, { withFileTypes: true }); return es.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$') && !JUNK_FOLDER.test(e.name.trim())).map((e) => e.name); }
    catch { return []; }
  };
  const commonChild = async (parents) => {
    if (!parents.length) return null;
    const cnt = {}; const orig = {};
    for (const p of parents) { const subs = await dirs(p); const seen = new Set(); for (const s of subs) { const lk = s.toLowerCase(); if (!seen.has(lk)) { seen.add(lk); cnt[lk] = (cnt[lk] || 0) + 1; orig[lk] = orig[lk] || s; } } }
    let best = null; let bn = 0; for (const [lk, n] of Object.entries(cnt)) if (n > bn) { bn = n; best = lk; }
    return (best && bn >= Math.ceil(parents.length / 2)) ? orig[best] : null;
  };
  try {
    const dayFolders = await dirs(base);
    if (!dayFolders.length) return { ok: true, inner: '' };
    let parents = dayFolders.map((d) => path.join(base, d));
    let inner = ''; let guard = 0;
    while (guard++ < 3) {
      // eslint-disable-next-line no-await-in-loop
      const c = await commonChild(parents);
      if (!c) break;
      inner = inner ? `${inner}/${c}` : c;
      const next = []; for (const p of parents) { const cp = path.join(p, c); try { await fsp.access(cp); next.push(cp); } catch { /* skip */ } }
      parents = next; if (!parents.length) break;
    }
    return { ok: true, inner };
  } catch (err) { return { ok: false, error: err.message || String(err), inner: '' }; }
});

// Discover how each existing project is organized INSIDE — its real subfolders —
// so the AI places clips AWARE of each folder's actual structure and continues
// whatever pattern it finds (Day N, dates, "NN - desc", "Shoot 03", …). This is
// what keeps placement VARIABLE/discovered, not hardcoded to any one scheme.
function structureDigest(folders) {
  const kids = {};
  for (const f of folders) {
    const segs = String(f || '').split('/').filter(Boolean);
    if (segs.length < 2) continue;
    const parent = segs.slice(0, -1).join('/');
    (kids[parent] = kids[parent] || new Set()).add(segs[segs.length - 1]);
  }
  const lines = [];
  for (const [parent, set] of Object.entries(kids)) {
    const names = [...set];
    // Only worth showing projects that actually have a subfolder series to learn from.
    if (names.length < 2) continue;
    lines.push(`- "${parent}" is organized inside as: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''}`);
  }
  if (!lines.length) return '';
  return `\nHOW THE EXISTING PROJECTS ARE ORGANIZED INSIDE — read each one and CONTINUE its own pattern, never impose a different scheme:\n${lines.slice(0, 50).join('\n')}\n`;
}
// ---- Placement-brain helpers (pure — unit-testable without Ollama) ----
// Normalize a string to a space-joined lowercase token string.
function pbNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
// Meaningful tokens (≥3 chars) from a string.
function pbToks(s) { return pbNorm(s).split(' ').filter((w) => w.length > 2); }
// Strip leading/trailing slashes + backslashes → a comparable relative path.
// The value comes straight from an LLM reply and is later joined to the library root
// (the renderer hands it back as `mv.toDir` to projects:move, which path.joins it), so
// `.` and `..` segments are DROPPED, not preserved: a reply of `../../etc` must never be
// able to walk out of the projects root. No legitimate folder suggestion contains them.
function pbCleanPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

// CANDIDATE SELECTION — rank the existing folder tree toward THIS batch so the
// genuinely-relevant project is always visible to the model (and distractors that
// drive mis-placement are dropped). Scores each folder by token overlap with the
// batch's people (weighted highest) / subjects / locations, a nudge for matching the
// batch's top-level category, and a strong boost for any standing-route destination
// (which must never be hidden). Small trees are shown whole — hiding helps nothing.
// Returns { shown:[paths], hiddenCount, ranked }. Pure.
function rankCandidateFolders(folders, clips, categories, routeRules, opts) {
  const MAX = (opts && opts.max) || 80;
  const list = (folders || []).map(pbCleanPath).filter(Boolean);
  if (list.length <= MAX) return { shown: list, hiddenCount: 0, ranked: false };
  const subj = new Set(); const ppl = new Set(); const loc = new Set();
  for (const c of (clips || [])) {
    pbToks(c && c.subject).forEach((t) => subj.add(t));
    pbToks(c && c.description).forEach((t) => subj.add(t));
    pbToks(c && c.location).forEach((t) => loc.add(t));
    (Array.isArray(c && c.people) ? c.people : []).forEach((p) => pbToks(p).forEach((t) => ppl.add(t)));
  }
  const hasSignal = subj.size || ppl.size || loc.size;
  const cats = (categories || []).map(pbNorm).filter(Boolean);
  const routeDests = new Set((routeRules || []).map((r) => pbCleanPath(r && r.dest)).filter(Boolean));
  const score = (f) => {
    const segs = f.split('/').filter(Boolean);
    const ft = new Set(); segs.forEach((s) => pbToks(s).forEach((t) => ft.add(t)));
    let s = 0;
    ft.forEach((t) => { if (ppl.has(t)) s += 3; if (subj.has(t)) s += 2; if (loc.has(t)) s += 2; });
    if (cats.length && cats.includes(pbNorm(segs[0] || ''))) s += 1;
    if (routeDests.has(f)) s += 6;
    return s;
  };
  const scored = list.map((f, idx) => ({ f, s: score(f), idx }));
  const anyHit = scored.some((x) => x.s > 0);
  // No usable signal/overlap → keep the original (recent-first) order, just truncated.
  if (!hasSignal || !anyHit) return { shown: list.slice(0, MAX), hiddenCount: list.length - MAX, ranked: false };
  const chosen = scored.slice().sort((a, b) => b.s - a.s || a.idx - b.idx).slice(0, MAX).map((x) => x.f);
  // Guarantee every standing-route destination is present even if it scored out.
  for (const d of routeDests) { if (d && list.includes(d) && !chosen.includes(d)) chosen.push(d); }
  return { shown: chosen, hiddenCount: Math.max(0, list.length - chosen.length), ranked: true };
}

// CONFIDENCE CALIBRATION + same-subject grouping. The model's self-reported
// confidence is unreliable, but the renderer's "Needs you" review split depends on
// it, so we calibrate deterministically from what the destination actually IS:
//   - _Unsorted               → capped low (≤0.3)
//   - brand-new folder/project (neither an existing folder, a child of one, nor a
//     route dest) → capped (≤0.5) — a guess, not a known match
//   - existing project / route dest → trust the model's value (it was told to be high
//     only for sure matches); fill a sensible default when it omitted one.
// Then force clips that share a (non-empty) subject onto ONE destination — the one the
// most-confident, most-grounded member got — so a subject is never split. Pure.
function calibratePlacements(placements, clips, ctx) {
  const folderSet = new Set(((ctx && ctx.folders) || []).map(pbCleanPath).filter(Boolean));
  const routeDests = new Set(((ctx && ctx.routeRules) || []).map((r) => pbCleanPath(r && r.dest)).filter(Boolean));
  const isUnsorted = (p) => /(^|\/)_unsorted(\/|$)/i.test(p);
  const round2 = (n) => Math.round(n * 100) / 100;
  const out = (placements || []).map((p) => {
    const path = pbCleanPath(p.path);
    const existing = folderSet.has(path);
    const parent = path.split('/').slice(0, -1).join('/');
    const underExisting = !!parent && folderSet.has(parent);
    const known = existing || routeDests.has(path);
    const unsorted = isUnsorted(path);
    let conf = (p.confidence == null || !isFinite(p.confidence)) ? null : Math.max(0, Math.min(1, p.confidence));
    if (conf == null) conf = unsorted ? 0.25 : (known ? 0.7 : (underExisting ? 0.6 : 0.4));
    if (unsorted) conf = Math.min(conf, 0.3);
    else if (!known && !underExisting) conf = Math.min(conf, 0.5);
    return { i: p.i, path, why: p.why, confidence: round2(conf), _known: known ? 1 : 0, _unsorted: unsorted ? 1 : 0 };
  });
  // Same-subject grouping.
  const subjOf = {}; (clips || []).forEach((c, idx) => { subjOf[idx] = pbNorm(c && c.subject); });
  const groups = {};
  for (const p of out) { const sj = subjOf[p.i]; if (!sj) continue; (groups[sj] = groups[sj] || []).push(p); }
  for (const sj of Object.keys(groups)) {
    const g = groups[sj]; if (g.length < 2) continue;
    const winner = g.slice().sort((a, b) => (b._known - a._known) || (a._unsorted - b._unsorted) || (b.confidence - a.confidence))[0];
    for (const p of g) { if (p.path !== winner.path) { p.path = winner.path; p.why = winner.why; p.confidence = Math.min(p.confidence, winner.confidence); } }
  }
  return out.map((p) => ({ i: p.i, path: p.path, why: p.why, confidence: p.confidence }));
}

// AI: given the real folder list + clip metadata, propose a destination folder
// path per clip (existing or new), grouping related clips together.
ipcMain.handle('ai:suggestProjects', async (_e, payload) => {
  const clips = (payload && payload.clips) || [];
  const folders = (payload && payload.folders) || [];
  const categories = (payload && payload.categories) || [];
  const context = String((payload && payload.context) || '').trim();
  const feedback = String((payload && payload.feedback) || '').trim();
  const routes = aiRoutes();
  if (!clips.length) return { ok: true, placements: [] };
  if (!aiTextModel()) return { ok: false, error: 'No model selected (set one in AI settings)' };
  const routeRules = routes.filter((r) => r.kind !== 'descriptor');
  // CANDIDATE SELECTION: rank the folder tree toward THIS batch so the genuinely
  // relevant project is always visible and distractor folders that cause mis-placement
  // are dropped (standing-route dests are always kept; small trees shown whole).
  const cand = rankCandidateFolders(folders, clips, categories, routeRules, { max: 80 });
  const folderList = cand.shown.join('\n') || '(no existing folders)';
  const omittedLine = cand.hiddenCount
    ? `\n(${cand.hiddenCount} less-relevant folder(s) are hidden — ranked unlikely for this batch. If NONE of the projects above genuinely fits a clip, file it to "<its category>/_Unsorted" rather than inventing or forcing a project.)`
    : '';
  const clipList = clips.map((c, i) => {
    const saw = c.observation ? ` saw="${String(c.observation).replace(/"/g, "'").slice(0, 400)}"` : '';
    const ppl = (Array.isArray(c.people) && c.people.length) ? ` people="${c.people.join(', ')}"` : '';
    return `${i}: subject="${c.subject || ''}" desc="${c.description || ''}" location="${c.location || ''}" date="${c.date || ''}"${saw}${ppl} file="${c.name || ''}"`;
  }).join('\n');
  // PAST FILING MEMORY — the single strongest signal. The app remembers every
  // project footage was filed into (people, subjects, places, an AI summary). Score
  // each remembered project against THIS batch's tokens and feed the model the most
  // relevant ones so it reuses the EXACT existing project instead of re-guessing.
  const ledgerBlock = suggestLedgerMemory(clips);
  const ctxLine = context ? `\nWhat the videographer told us about this batch (use it to identify the subjects/people/shoot and group correctly): "${context}"\n` : '';
  const catLine = categories.length ? `EVERY clip MUST be filed under exactly one of these top-level categories (use the path that starts with it): ${categories.join(' | ')}.` : '';
  const routeLine = routeRules.length ? `\nThe user has STANDING filing rules — obey them when a clip matches:\n${routeRules.map((r) => `- if it's about [${(r.match || []).join(', ')}] → "${r.dest}"${r.byDay ? ' (return just this project path; the app adds the day folder)' : ''}`).join('\n')}` : '';
  const fbLine = feedback ? `\nTHE USER REVIEWED YOUR LAST PLAN AND WANTS THESE CORRECTIONS — obey them above all other rules:\n"${feedback}"\n` : '';
  const structDigest = structureDigest(folders);
  const prompt = `A videographer files video clips into this project-folder tree (relative paths), ranked with the most relevant projects for this batch first:\n${folderList}${omittedLine}\n${structDigest}${ledgerBlock}\nClips to place:\n${clipList}\n${ctxLine}${fbLine}\n${catLine}${routeLine}\n\nRULES — choose each clip's destination folder PATH (relative, "/" separators):\n1. PAST FILING MEMORY WINS. If a clip's subject / people / place matches a remembered project above, reuse that EXACT path. This beats folder-name guessing.\n2. MATCH BY CONTENT, NOT DATE. Place a clip by what it IS (subject / description / people), never merely because it shares a date with other clips.\n3. PREFER AN EXISTING PROJECT when the clip genuinely belongs there — reuse the exact existing path shown above.\n4. GROUP SAME SUBJECT TOGETHER. Every clip with the same subject/shoot goes to the SAME project path. Never split one subject across folders.\n5. CONTINUE EACH PROJECT'S OWN INTERNAL PATTERN (see the "organized inside" list above): "Day 1/Day 2…" → the next "Day N"; dates → a date (YYYY-MM-DD); "01 - desc" / "Shoot 03" → the next in that series. Do NOT impose a different scheme; only fall back to the clip's date when a project has no consistent pattern. If unsure of the exact subfolder, return just the project path. NEVER nest one date folder inside another.\n6. WHEN GENUINELY UNSURE, DO NOT GUESS. File the clip to "<its category>/_Unsorted" with LOW confidence. A wrong existing-project guess is worse than _Unsorted.\n\nCONFIDENCE (0-1) — be honest; the app sends low-confidence clips to a human review queue:\n- 0.85-1.0 ONLY for an exact existing-project match, a past-filing-memory match, or a standing-rule match.\n- 0.5-0.8 for a plausible existing project you are not certain about.\n- 0.4 or less for a brand-new project or anything ambiguous; 0.3 or less for _Unsorted.\n\nFor EACH clip also give a SHORT "why" (≤8 words, e.g. "matches your Lawn Mowing shoot", "new project", "unsorted — unclear subject").\n\nWORKED EXAMPLE (shows format + grouping + an unsure clip; do not copy its values):\nClips 0 and 1 are both subject="lawn mowing" for an existing "2026/Clients/Gourgess Lawns" project; clip 2 is an unclear drone test.\n{"placements":[{"i":0,"path":"2026/Clients/Gourgess Lawns/2026-06-27","why":"matches Gourgess Lawns shoot","confidence":0.9},{"i":1,"path":"2026/Clients/Gourgess Lawns/2026-06-27","why":"same lawn mowing subject","confidence":0.9},{"i":2,"path":"2026/_Unsorted","why":"unsorted — unclear subject","confidence":0.25}]}\n\nReply STRICT JSON only, no prose: {"placements":[{"i":0,"path":"...","why":"...","confidence":0.9}]}.`;
  try {
    const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.2, timeout: 180000 }));
    const arr = Array.isArray(o.placements) ? o.placements : (Array.isArray(o) ? o : []);
    const placements = arr.map((p) => {
      const conf = Number(p.confidence != null ? p.confidence : p.conf);
      return {
        i: Number(p.i != null ? p.i : (p.I != null ? p.I : p.index)),
        path: String(p.path || p.Path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim(),
        why: String(p.why || p.reason || '').trim().slice(0, 60),
        confidence: isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null
      };
    }).filter((p) => isFinite(p.i) && p.path);
    // Deterministically calibrate confidence + enforce same-subject grouping.
    const calibrated = calibratePlacements(placements, clips, { folders, routeRules });
    return { ok: true, placements: calibrated };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Build the "PAST FILING MEMORY" prompt block: the remembered projects (ledger)
// most relevant to THIS batch, scored by shared people / subject / location tokens
// (people weighted highest, mirroring ledger:matchDates). Returns '' when there's
// no useful memory so the prompt stays lean.
function suggestLedgerMemory(clips) {
  const ledger = Array.isArray(config.projectLedger) ? config.projectLedger : [];
  if (!ledger.length) return '';
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const toks = (s) => norm(s).split(' ').filter((w) => w.length > 2);
  const batchSubj = new Set(); const batchPeople = new Set(); const batchLoc = new Set();
  for (const c of clips) {
    toks(c.subject).forEach((t) => batchSubj.add(t));
    toks(c.description).forEach((t) => batchSubj.add(t));
    toks(c.location).forEach((t) => batchLoc.add(t));
    (Array.isArray(c.people) ? c.people : []).forEach((p) => batchPeople.add(norm(p)));
  }
  const scored = ledger.map((m) => {
    let s = 0;
    (m.people || []).forEach((p) => { if (batchPeople.has(norm(p))) s += 3; });
    (m.subjects || []).forEach((x) => { if (toks(x).some((t) => batchSubj.has(t))) s += 2; });
    (m.keywords || []).forEach((k) => { if (toks(k).some((t) => batchSubj.has(t) || batchLoc.has(t))) s += 1.5; });
    (m.locations || []).forEach((l) => { if (toks(l).some((t) => batchLoc.has(t))) s += 2; });
    return { m, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 24);
  if (!scored.length) return '';
  const lines = scored.map(({ m }) => {
    const ppl = (m.people || []).slice(0, 6).join(', ');
    const subj = (m.subjects || []).slice(0, 6).join(', ');
    const sum = m.summary ? ` — ${String(m.summary).slice(0, 160)}` : '';
    return `- "${m.rel}"${ppl ? ` [people: ${ppl}]` : ''}${subj ? ` [about: ${subj}]` : ''}${sum}`;
  }).join('\n');
  return `\nPAST FILING MEMORY (projects you've already filed similar footage into — reuse the EXACT path when a clip matches one):\n${lines}\n`;
}

// (`ai:batchQuestions` lived here: an LLM that invented clarifying questions to ask before filing.
// It was DEAD — the renderer replaced it with a plain loop over the real subjects, which is both
// cheaper and better, because the questions worth asking are the ones the DATA raises, not the ones
// a 7B model can think of. Placement now asks per-SHOOT and remembers the answer forever, so the
// question that survives is the one the app cannot answer itself. Deleted rather than left to rot.)

// Analyze the batch's subjects and SUGGEST an answer for each (which folder, or
// "descriptor" / "delete" / "unsorted") — used to pre-fill the wizard's per-subject
// questions so the AI does the first pass and the user just confirms.
ipcMain.handle('ai:answerSubjects', async (_e, payload) => {
  const subjects = (payload && payload.subjects) || [];
  const folders = (payload && payload.folders) || [];
  const categories = (payload && payload.categories) || [];
  if (!subjects.length) return { ok: true, answers: {} };
  if (!aiTextModel()) return { ok: false, error: 'No model selected' };
  const folderList = folders.slice(0, 250).join('\n') || '(none)';
  const subjLines = subjects.map((s) => `- "${s.subject}" (${s.count} clips)`).join('\n');
  const prompt = `A videographer is filing these subjects:\n${subjLines}\n\nTop-level categories: ${categories.join(' | ') || '(none)'}\n\nExisting project folders:\n${folderList}\n\nFor EACH subject, suggest the single best SHORT answer for where it goes:\n- If the subject is a TYPE OF SHOT rather than a project — vlog, pov, timelapse, b-roll, montage, cutaway, slow-mo, interview, talking-head — answer EXACTLY "descriptor".\n- Else an EXISTING project folder NAME from the list (the bare folder NAME, e.g. "Gourgess Lawns" — NOT a full path and NOT a dated/day subfolder), when it clearly belongs there,\n- or one of the category names,\n- or "delete" if it's clearly trash (named delete/junk),\n- or "unsorted" if it's unnamed/unclear.\nOnly name an existing folder when the subject CLEARLY belongs there — a confident, specific match. When in doubt, answer "unsorted": a weak guess that mis-files footage is worse than leaving it for the user. Do not stretch to fit a folder.\nReply STRICT JSON only mapping each subject to its short answer: {"answers":{"<subject>":"<answer>"}}.`;
  try {
    const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.2, timeout: 120000 }));
    const raw = (o && o.answers && typeof o.answers === 'object') ? o.answers : (o && typeof o === 'object' ? o : {});
    const answers = {};
    for (const [k, v] of Object.entries(raw)) { const a = String(v == null ? '' : v).trim(); if (a) answers[String(k).toLowerCase()] = a; }
    return { ok: true, answers };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// --- Standing filing rules ("routes"): subject keywords → a destination folder,
// optionally one subfolder per day. The user teaches these (plain-English or the
// editor) and they're remembered + applied on every Destination map.
function aiRoutes() { return (config.ai && Array.isArray(config.ai.routes)) ? config.ai.routes : []; }
ipcMain.handle('routes:get', () => aiRoutes());
ipcMain.handle('routes:save', (_e, list) => {
  config.ai = config.ai || {};
  config.ai.routes = (Array.isArray(list) ? list : []).map((r) => {
    const kind = r.kind === 'descriptor' ? 'descriptor' : 'route';
    const base = {
      id: String(r.id || `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`),
      name: String(r.name || '').slice(0, 80),
      kind,
      match: (Array.isArray(r.match) ? r.match : String(r.match || '').split(',')).map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 20),
      byDay: !!r.byDay
    };
    if (kind === 'descriptor') {
      // A descriptor word (vlog, timelapse, b-roll…) is NOT a project. joinProject:
      // true = file each clip into the project/day it was shot with; false = each
      // shooting DAY becomes its own separate project folder.
      base.joinProject = !!r.joinProject;
      base.category = String(r.category || '').trim();   // optional: client|personal|social
    } else {
      base.dest = String(r.dest || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/\d{4}-\d{2}-\d{2}$/, '').trim();
    }
    return base;
  }).filter((r) => r.match.length && (r.kind === 'descriptor' || r.dest));
  saveConfig();
  return config.ai.routes;
});
// Words that name a TYPE of shot (a "descriptor"), never a project on their own.
// Used to robustly reclassify a rule the model mislabelled as a route when it has
// no destination — a bare descriptor word can't be a project folder.
const DESCRIPTOR_WORDS = new Set([
  'vlog', 'vlogs', 'pov', 'timelapse', 'time-lapse', 'hyperlapse', 'b-roll', 'broll',
  'interview', 'montage', 'cutaway', 'slow-mo', 'slowmo', 'slow-motion', 'talking-head',
  'establishing', 'drone', 'aerial', 'gimbal', 'handheld'
]);

// (`ai:parseRoute` lived here: parse ONE plain-English filing rule. Dead — `ai:parseRules` below
// supersedes it, parsing one or more rules and telling routes apart from descriptors. Two parsers for
// the same sentence is one too many, and the unused one is the one that drifts.)

// Parse a plain-English instruction into ONE OR MORE rules, telling apart real
// PROJECT keywords (route → a folder) from DESCRIPTORS (vlog/timelapse/b-roll —
// not a project; group by day or file with the day's project).
ipcMain.handle('ai:parseRules', async (_e, payload) => {
  const text = String((payload && payload.text) || '').trim();
  const folders = (payload && payload.folders) || [];
  if (!text) return { ok: false, error: 'Nothing to parse' };
  if (!aiTextModel()) return { ok: false, error: 'No model selected (set one in AI settings)' };
  const folderList = folders.slice(0, 250).join('\n') || '(no existing folders)';
  const prompt = `You turn a videographer's plain-English filing instruction into ONE OR MORE rules.

Two KINDS of rule:
- "route": a real PROJECT/subject keyword that files into a specific folder. Fields: match (keywords), dest (use an EXISTING folder path from the list when the user names one, else a sensible new path under the right category), byDay (does each day get its own dated subfolder?).
- "descriptor": a word that describes the TYPE of shot, NOT a project — e.g. vlog, timelapse, b-roll, interview, montage, slow-mo, cutaway. Clips tagged with it must NOT all be lumped into one folder.

Decide KIND from meaning: if the user gives a word a destination folder → route. If a word is "not its own project", "separate projects", "belongs with", "goes in the project it was taken in", or is "just a label" → descriptor.

For a DESCRIPTOR, choose "placement" — how its clips are organised. Pick EXACTLY ONE of these two strings (each option spells out exactly what it means, so you cannot get it backwards):
- "separate"  → the clips are their OWN separate projects; EACH shooting DAY becomes its own project folder. Choose this for: "X is its own project", "X are separate projects", "each X is separate", "not part of another shoot". Example: "vlogs are separate projects" → "separate".
- "with_day"  → the clip BELONGS WITH the main footage shot that day; file it INTO that day's existing project. Choose this for: "X goes in the project it was taken in", "X belongs with the shoot", "X is a side-shot of the bigger project". Example: "timelapse goes with the day's project" → "with_day".

One instruction may describe SEVERAL behaviors — output one rule per distinct behavior (e.g. "vlogs are separate but timelapses go with the shoot" = two descriptor rules).

Existing folders:
${folderList}

Instruction (derive everything from THIS — do not copy the placeholders):
"${text}"

Reply STRICT JSON only: {"rules":[{"kind":"<route|descriptor>","name":"<short label>","match":["<word>"],"dest":"<folder path — route only>","byDay":<true|false>,"placement":"<separate|with_day — descriptor only>"}]}`;
  try {
    const o = parseJsonLoose(await ollamaGenerate(aiTextModel(), prompt, { format: 'json', temperature: 0.1, timeout: 120000 }));
    const arr = Array.isArray(o.rules) ? o.rules : (Array.isArray(o) ? o : []);
    const rules = arr.map((r) => normalizeParsedRule(r)).filter((r) => r && r.match.length && (r.kind === 'descriptor' || r.dest));
    if (!rules.length) return { ok: false, error: 'Could not understand that — try naming the subject(s) and where they go.' };
    return { ok: true, rules };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// Normalise one raw parsed rule into the canonical rule shape the rest of the app
// uses ({kind,name,match[],dest?,byDay,joinProject?}). The model now returns an
// explicit "placement" enum for descriptors (separate | with_day) which CANNOT be
// flipped like the old joinProject boolean — we still emit joinProject (derived)
// for backward compatibility with stored rules + the renderer.
function descriptorPlacement(r) {
  // Prefer the explicit enum; fall back to a legacy joinProject boolean if that's
  // all the model returned. Default 'separate' (each day its own project).
  const p = String((r && (r.placement || r.Placement)) || '').toLowerCase().replace(/[^a-z]/g, '');
  if (p === 'withday' || p === 'joinday' || p === 'join' || p === 'withproject') return 'with_day';
  if (p === 'separate' || p === 'separateprojects' || p === 'own' || p === 'perday') return 'separate';
  if (r && (r.joinProject != null || r.joinproject != null || r.join != null)) return (r.joinProject || r.joinproject || r.join) ? 'with_day' : 'separate';
  return 'separate';
}
function normalizeParsedRule(r) {
  if (!r || typeof r !== 'object') return null;
  let kind = (String(r.kind || '').toLowerCase() === 'descriptor') ? 'descriptor' : 'route';
  const match = (Array.isArray(r.match) ? r.match : String(r.match || '').split(',')).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const dest = String(r.dest || r.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/\d{4}-\d{2}-\d{2}$/, '').trim();
  // Route-vs-descriptor safety net: a rule the model called a "route" but that has
  // NO destination and whose keywords are ALL known shot-type words can't really be
  // a project folder — treat it as a descriptor so it isn't lumped into one folder.
  if (kind === 'route' && !dest && match.length && match.every((m) => DESCRIPTOR_WORDS.has(m))) kind = 'descriptor';
  const out = { kind, name: String(r.name || (match[0] || '')).slice(0, 80), match };
  if (kind === 'descriptor') {
    const placement = descriptorPlacement(r);
    out.placement = placement;                 // explicit, unambiguous
    out.joinProject = placement === 'with_day'; // derived — kept for back-compat
    out.byDay = true;
  } else {
    out.dest = dest;
    out.byDay = !!(r.byDay || r.byday);
  }
  return out;
}

// --- Per-clip analysis memory: cache each clip's vision observation keyed by its
// file fingerprint, so re-analyzing reuses prior work instead of looking again.
// Lazy store (LAZY_STORES in 01-core.js): clip-observations.json is not read at boot.
// Every read/write of the observation cache goes through here, so ensureStore() can pull the
// sidecar in on first touch without ever landing on top of an in-memory mutation.
function clipObsStore() { ensureStore('ai.clipObs'); config.ai = config.ai || {}; if (!config.ai.clipObs || typeof config.ai.clipObs !== 'object') config.ai.clipObs = {}; return config.ai.clipObs; }
ipcMain.handle('clipObs:get', () => clipObsStore());
ipcMain.handle('clipObs:save', (_e, payload) => {
  const key = String((payload && payload.key) || '').trim();
  const obs = String((payload && payload.obs) || '').trim();
  if (!key || !obs) return false;
  const store = clipObsStore();
  store[key] = { obs, ts: Date.now() };
  // Cap to 4000 most-recent observations.
  const keys = Object.keys(store);
  if (keys.length > 4000) { keys.sort((a, b) => (store[a].ts || 0) - (store[b].ts || 0)); for (const k of keys.slice(0, keys.length - 4000)) delete store[k]; }
  saveStore('ai.clipObs');
  return true;
});

