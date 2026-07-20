// THE SUBJECT VOCABULARY — the unblock.
//
// Fifth module in `core/` (see core/clip-key.js for the three rules: packaging allowlist, `./core/`
// not `../core/`, STATELESS).
//
// ⚠⚠ WHY THIS EXISTS, MEASURED ON HIS REAL STORE (2026-07-20):
//
//     4,594 clips · 331 named · **1 filed**
//     112 distinct subjects across 206 named clips
//       · 46% describe the SHOT, not the job: talking-head, talking-head-young,
//         talking-head-person, person-sitting-couch, vlog-young-man
//       · 20 pairs are fragments of each other: car / car-driving / car-driving-down / car-parked,
//         b-roll / b-roll-living / b-roll-time, vlog / bedtime-vlog
//
// Filing groups clips by subject. With 112 subjects for 206 clips and no two agreeing, **nothing
// groups** — so the destination ladder falls through to `_unsorted` and he files nothing. The project
// ledger has 0 entries because nothing was ever filed for it to learn from.
//
// Every filing capability in this app is correct and tested and produces nothing, because of this.
// That is why a vocabulary is not feature-work: it is the precondition.
//
// ⚠ WHAT THIS MODULE DOES NOT DO: it never silently rewrites what he typed. It CANONICALISES (maps a
// variant onto a name he already uses) and it FLAGS (says "that describes the shot, not the job").
// Both are advisory, and the caller decides whether to ask him. Quietly renaming his subjects would
// be the same class of mistake as an AI that decides instead of proposes.
'use strict';

// Words that describe what is ON SCREEN rather than what the footage is FOR. Drawn from his actual
// data, not invented: every one of these appears in his store as part of an AI-generated "subject".
//
// His own note, from the project memory: *the subject is what the footage is FOR, not what is in
// frame.* A shoot is "dennis-lawn" or "gourgess-promo"; "talking-head" is a shot type, and filing by
// it produces a folder full of unrelated jobs.
const SHOT_WORDS = new Set([
  'talking', 'head', 'talkinghead', 'person', 'people', 'man', 'woman', 'boy', 'girl', 'child',
  'young', 'adult', 'guy', 'lady', 'sitting', 'standing', 'walking', 'holding', 'wearing',
  'couch', 'sofa', 'chair', 'indoor', 'indoors', 'outdoor', 'outdoors',
  'closeup', 'close', 'wide', 'shot', 'angle', 'footage', 'clip', 'video', 'scene',
  'misc', 'generic', 'unknown', 'untitled', 'various', 'random', 'stuff', 'thing', 'things',
]);

// Words too generic to distinguish one shoot from another when they stand alone.
const WEAK_ALONE = new Set(['vlog', 'b-roll', 'broll', 'clip', 'video', 'footage', 'misc']);

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// The stored form: lowercase, hyphenated, trimmed. Matches what `slug()` produces in the app, so a
// vocabulary entry and a typed subject compare equal.
function normalizeSubject(s) {
  return tokens(s).join('-');
}

// Does this name describe the SHOT rather than the JOB?
//
// Returns { shotLike, why } rather than a bare boolean, because the caller has to be able to tell him
// WHICH part is the problem — "talking-head-young: 'talking', 'head' and 'young' describe the shot"
// is actionable; "invalid" is not.
function classifySubject(s) {
  const t = tokens(s);
  if (!t.length) return { shotLike: false, weak: false, why: '', tokens: t };
  const hits = t.filter((w) => SHOT_WORDS.has(w));
  // Every token is a shot word → it says nothing about the job at all.
  const allShot = hits.length === t.length;
  // Majority are shot words → still describing the frame.
  const mostlyShot = hits.length >= Math.ceil(t.length / 2);
  const weak = t.length === 1 && WEAK_ALONE.has(t[0]);
  return {
    shotLike: allShot || mostlyShot,
    weak,
    why: hits.length ? `${hits.map((w) => `“${w}”`).join(', ')} describe${hits.length === 1 ? 's' : ''} what is on screen, not what the footage is for` : '',
    tokens: t,
  };
}

// How close are two subjects? 0..1.
//
// Deliberately token-based rather than edit-distance: `car-parked` and `car-driving-down` are 60%
// different as strings but obviously the same subject, while `curling` and `curlers-ice-rink` share
// no whole token yet are related. Containment is what catches his actual fragmentation — every one of
// his 20 duplicate pairs is one name's tokens being a subset of another's.
// Do two tokens mean the same word? `butcher`/`butchering`, `mow`/`mowing`, `curler`/`curlers`.
//
// Deliberately CONSERVATIVE: one must be a prefix of the other, the shorter must be at least 4
// characters, and the remainder must be a common English inflection. That is enough for his real
// variants and short of a real stemmer, which would start matching `car`/`cargo` and `plan`/`plant`.
const INFLECTIONS = ['s', 'es', 'ing', 'ed', 'er', 'ers', 'ings', 'd', 'ly'];
function sameWord(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 4 || !long.startsWith(short)) return false;
  let rest = long.slice(short.length);
  // Handle a doubled final consonant before the suffix: mop -> mopping.
  if (rest.length > 1 && rest[0] === short[short.length - 1]) rest = rest.slice(1);
  return INFLECTIONS.includes(rest);
}

function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if ([...B].some((x) => sameWord(w, x))) shared += 1;
  if (!shared) return 0;

  // ⚠ A SINGLE GENERIC TOKEN MUST NOT ACT AS A MAGNET. Measured on his real data: with plain
  // containment, `vlog` absorbed TEN variants — kitchen-vlog, bedtime-vlog, vlog-david-googins — 
  // because every one of them contains all of `vlog`'s single token. Those are plausibly different
  // SHOOTS, and merging them would destroy exactly the distinction filing needs. Over-merging is
  // worse than not merging: fragmentation leaves clips unfiled, but a bad merge files a personal
  // vlog into a client job, which is the failure already seen and reverted here on 2026-07-20.
  //
  // So a one-token overlap only counts when that token is distinctive. `curlers` ⊂ `curlers-ice-rink`
  // is a real match; `vlog` ⊂ `kitchen-vlog` is not.
  const smaller = A.size <= B.size ? A : B;
  const onlySharedTokenIsWeak = shared === 1 && smaller.size === 1
    && [...smaller].every((w) => WEAK_ALONE.has(w) || SHOT_WORDS.has(w));
  if (onlySharedTokenIsWeak) return 0;

  // Containment: all of the shorter one's tokens appear in the longer one.
  const containment = shared / Math.min(A.size, B.size);
  const jaccard = shared / (A.size + B.size - shared);
  // Weighted toward containment, because that is the shape of his fragmentation.
  return (containment * 0.7) + (jaccard * 0.3);
}

// Build a vocabulary from subjects he has ALREADY used.
//
// The canonical name for a cluster is the one he used MOST, tie-broken by the SHORTEST — `car` beats
// `car-driving-down` because the shorter name is the one that generalises across a shoot. Everything
// else in the cluster becomes an alias pointing at it.
//
// `counts` is { subject: timesUsed }.
function buildVocabulary(counts, { threshold = 0.7 } = {}) {
  const entries = Object.entries(counts || {})
    .map(([s, n]) => [normalizeSubject(s), Number(n) || 0])
    .filter(([s]) => s);
  // Most-used first, so the busiest name tends to become the canonical one.
  entries.sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);

  const clusters = [];
  for (const [name, n] of entries) {
    let best = null; let bestScore = 0;
    for (const c of clusters) {
      const score = similarity(name, c.canonical);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (best && bestScore >= threshold) {
      best.members.push({ name, count: n });
      best.count += n;
      // The canonical name can change if a member is both more used and shorter.
      // ⚠ PREFER THE SHORTER, MORE GENERAL NAME. `car` is a better canonical than `car-driving-down`
      // even when the longer one was typed more often — the point of a canonical is that it covers
      // the whole shoot, and the extra tokens are describing individual shots. A longer name only
      // wins when it is used much more (2x), which means he has genuinely settled on it.
      const cur = best.members.find((m) => m.name === best.canonical);
      const curCount = cur ? cur.count : 0;
      const shorter = tokens(name).length < tokens(best.canonical).length;
      const muchMoreUsed = n >= curCount * 2 && n > curCount;
      if ((shorter && n * 2 >= curCount) || muchMoreUsed) best.canonical = name;
    } else {
      clusters.push({ canonical: name, count: n, members: [{ name, count: n }] });
    }
  }

  const aliases = {};
  for (const c of clusters) {
    for (const m of c.members) if (m.name !== c.canonical) aliases[m.name] = c.canonical;
  }
  return {
    subjects: clusters.map((c) => ({ name: c.canonical, count: c.count, variants: c.members.length })).sort((a, b) => b.count - a.count),
    aliases,
    clusters,
  };
}

// Map a proposed subject onto the vocabulary.
//
// Returns { subject, canonical, matched, score, shotLike, why }. The caller decides what to do:
// snapping an AI suggestion silently is fine; snapping something HE typed should ask first.
function canonicalize(proposed, vocab, { threshold = 0.7 } = {}) {
  const s = normalizeSubject(proposed);
  const cls = classifySubject(s);
  const out = { subject: s, canonical: s, matched: false, score: 0, shotLike: cls.shotLike, weak: cls.weak, why: cls.why };
  if (!s || !vocab) return out;
  if (vocab.aliases && vocab.aliases[s]) {
    return { ...out, canonical: vocab.aliases[s], matched: true, score: 1 };
  }
  let best = ''; let bestScore = 0;
  for (const entry of (vocab.subjects || [])) {
    if (entry.name === s) return { ...out, canonical: s, matched: true, score: 1 };
    const score = similarity(s, entry.name);
    if (score > bestScore) { bestScore = score; best = entry.name; }
  }
  if (best && bestScore >= threshold) return { ...out, canonical: best, matched: true, score: bestScore };
  return out;
}

module.exports = { normalizeSubject, classifySubject, similarity, buildVocabulary, canonicalize, sameWord, SHOT_WORDS };
