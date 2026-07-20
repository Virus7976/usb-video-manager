// SEARCHING THE WHOLE LIBRARY — FEATURES.md item 91, described there as "the single biggest gap for
// a phone client", and it is just as big on the desktop.
//
// ---------------------------------------------------------------------------------------------
// WHAT WAS ACTUALLY WRONG
// ---------------------------------------------------------------------------------------------
// Ctrl+K already offered "Type a command or clip name…" and already listed clips. It listed
// `state.scannedFiles` — the clips on the CURRENT SCREEN. Measured on his real store that is the
// difference between a few hundred clips and **4,594**, and nothing in the UI said so. A search box
// that silently searches 4% of the library is worse than no search box: it answers "not found" with
// total confidence.
//
// ---------------------------------------------------------------------------------------------
// WHERE HIS LIBRARY ACTUALLY LIVES (measured 2026-07-20, not assumed)
// ---------------------------------------------------------------------------------------------
//   drafts.json      4,594 records · 206 carry a subject   ← this IS the library
//   final-meta.json  1 record                              ← filed clips; there is currently one
//
// So a search that only covered filed clips would find one clip. Drafts are the primary source and
// finalMeta is folded in beside them.
//
// A draft record is rich — subject, description, observation, tags, people, location, category,
// project — and he types into all of them. Searching only the filename would miss
// "corgi-puppies-playing-inside-crate", which is exactly the kind of thing he would type.
//
// ---------------------------------------------------------------------------------------------
// STATELESS, like every core/ module (see core/clip-key.js for the three rules). The desktop app and
// a future phone backend must give the SAME answer to the same query, and the only way to guarantee
// that is one function both call.
'use strict';

// ⚠ NOT clipKeyFileName — that lower-cases, which is right for MATCHING and wrong for DISPLAY. His
// footage is `GX010042.MP4` and `VID_20250820_110511.mp4`; showing him `gx010042.mp4` in a result
// list is showing him a filename that is not on his disk. Matching is case-insensitive anyway
// because every comparison lower-cases both sides.
function displayName(key) {
  const s = String(key || '');
  const i = s.indexOf('__');
  return i < 0 ? s : s.slice(0, i);
}

// Fields worth searching, in descending order of how much a hit in them means. A subject match is
// what he is almost always looking for; a tag match is a weak signal that still beats nothing.
const FIELDS = [
  { key: 'subject', weight: 100 },
  { key: 'description', weight: 60 },
  { key: 'observation', weight: 40 },
  { key: 'location', weight: 40 },
  { key: 'project', weight: 40 },
  { key: 'category', weight: 30 },
  { key: 'context', weight: 20 },
];
// Array-valued fields, searched element by element.
const LIST_FIELDS = [
  { key: 'people', weight: 70 },
  { key: 'tags', weight: 25 },
];

const norm = (s) => String(s == null ? '' : s).toLowerCase();

// Score one string against the query. Substring only — deliberately NOT fuzzy.
//
// ⚠ The command palette's fuzzy matcher is right for a list of ~40 command labels and wrong here.
// Subsequence matching across 4,594 records returns something for almost any query ("lmn" matches
// "lawn-mowing-dennis"), so the result list stops meaning anything. A search over a big library has
// to be able to say "nothing".
function fieldScore(text, q) {
  const t = norm(text);
  if (!t) return 0;
  const at = t.indexOf(q);
  if (at < 0) return 0;
  let s = 10;
  if (t === q) s += 40;                                        // exact
  else if (at === 0) s += 25;                                  // starts with
  else if (t[at - 1] === '-' || t[at - 1] === ' ' || t[at - 1] === '_') s += 15;   // word start
  return s;
}

// Score one record. Returns { score, matched } — `matched` names the fields that hit, so the UI can
// say WHY a clip is in the list. "It matched" without "on what" is the thing that makes a user
// distrust a search.
function scoreRecord(name, rec, q) {
  let score = 0;
  const matched = [];
  const nameScore = fieldScore(name, q);
  if (nameScore) { score += nameScore * 8; matched.push('name'); }
  for (const f of FIELDS) {
    const s = fieldScore(rec && rec[f.key], q);
    if (s) { score += (s * f.weight) / 10; matched.push(f.key); }
  }
  for (const f of LIST_FIELDS) {
    const arr = (rec && Array.isArray(rec[f.key])) ? rec[f.key] : [];
    let best = 0;
    for (const v of arr) best = Math.max(best, fieldScore(v, q));
    if (best) { score += (best * f.weight) / 10; matched.push(f.key); }
  }
  return { score, matched };
}

// A one-line human summary of a record, for the result row. Built from what he actually typed rather
// than from a template, so a clip with only an observation still reads as something.
function summarize(rec) {
  if (!rec) return '';
  const bits = [];
  if (rec.subject) bits.push(rec.subject);
  if (rec.description) bits.push(rec.description);
  else if (rec.observation) bits.push(rec.observation);
  if (rec.date) bits.push(rec.date);
  return bits.join(' · ');
}

// THE SEARCH.
//
// `limit` bounds what is RETURNED, never what is searched — `total` counts every match, so the caller
// can say "showing 40 of 312" instead of silently truncating. A search that quietly drops results is
// the same defect as one that only covers the loaded screen.
function searchLibrary(stores, query, opts) {
  const q = norm(query).trim();
  const limit = Math.max(1, Number((opts && opts.limit) || 40));
  if (!q) return { ok: true, query: '', total: 0, results: [], searched: 0 };

  const drafts = (stores && stores.drafts) || {};
  const finalMeta = (stores && stores.finalMeta) || {};
  const hits = [];

  for (const key of Object.keys(drafts)) {
    const rec = drafts[key];
    if (!rec || typeof rec !== 'object') continue;
    const name = displayName(key);
    const { score, matched } = scoreRecord(name, rec, q);
    if (score > 0) hits.push({ key, name, score, matched, summary: summarize(rec), subject: rec.subject || '', where: 'named', filed: false });
  }

  for (const key of Object.keys(finalMeta)) {
    const rec = finalMeta[key];
    if (!rec || typeof rec !== 'object') continue;
    const { score, matched } = scoreRecord(key, rec, q);
    if (score > 0) {
      // A filed clip is the more useful answer of the two — it is findable on disk — so it outranks
      // an otherwise equal draft.
      const rel = [rec.category, rec.project].filter(Boolean).join(' / ');
      hits.push({ key, name: key, score: score + 5, matched, summary: summarize(rec), subject: rec.subject || '', where: rel || 'filed', filed: true });
    }
  }

  // ⚠ A clip can appear in BOTH stores — a draft key carries the source filename and a finalMeta key
  // carries the final one, and after a rename those can be the same string. Prefer the filed record:
  // it is the one that says where the footage actually is.
  const byName = new Map();
  for (const h of hits) {
    const k = norm(h.name);
    const prev = byName.get(k);
    if (!prev || (h.filed && !prev.filed) || h.score > prev.score) byName.set(k, prev && prev.filed && !h.filed ? prev : h);
  }
  const merged = [...byName.values()];
  merged.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return {
    ok: true,
    query: q,
    total: merged.length,
    results: merged.slice(0, limit),
    searched: Object.keys(drafts).length + Object.keys(finalMeta).length,
  };
}

module.exports = { searchLibrary, scoreRecord, summarize, fieldScore, displayName };
