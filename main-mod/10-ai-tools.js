// ---------------------------------------------------------------------------
// AI TOOLS — deterministic functions the model CHOOSES BETWEEN.
//
// The old design asked a 7B model to hold a folder tree, a memory blob, a rules list, a confidence
// rubric and a hand-written worked example in its head, and then emit one correct JSON object. It
// was doing the reasoning, the retrieval, the arithmetic AND the serialisation, and a 7B model gets
// at least one of those wrong nearly every time. That is where the variability came from.
//
// Here, the model does exactly one thing: pick a tool. Everything else is ORDINARY CODE that runs
// the same way every time —
//   • searching the projects tree                 → real fs + real ledger, scored deterministically
//   • reading what is actually inside a project   → real files on disk
//   • slugging a name, versioning it, validating  → the same functions the rest of the app uses
//   • building the destination path               → code, not a model
// so the model's answer is a CHOICE from a list, not a computation. A choice is something a small
// local model is genuinely good at. And because the tools enforce their own schema, a malformed
// answer is impossible rather than merely unlikely.
//
// Learning still feeds in — but as tool RESULTS (your style examples, your known subjects, where you
// filed this before) rather than as 300 lines of English rules crammed into the prompt.
// ---------------------------------------------------------------------------

const AI_TOOLS = {};

/**
 * @param terminal  A tool that ENDS the loop — it is the decision, not a lookup. Everything else
 *                  feeds its result back and the model chooses again.
 * @param requires  Tool names that MUST have been called first. Enforced by the loop, in code.
 *
 * `requires` exists because of a real result from a real model. Given a clip it couldn't identify
 * ("a close-up of an unidentifiable grey object"), qwen3:8b did NOT ask — it invented a project
 * called "Client - Grey Object" and justified it confidently. A model will always rather act than
 * admit it doesn't know, and no amount of "only create a project as a last resort" in a prompt
 * reliably stops that. So the protocol is enforced by the loop instead: you cannot create a project
 * you never looked for. Structure beats instruction.
 */
function defineTool(name, { description, parameters, terminal = false, requires = [], requiresAny = [], run }) {
  AI_TOOLS[name] = { name, description, parameters, terminal, requires, requiresAny, run };
}

// Ollama/OpenAI-style function schemas for the tools named.
//
// `enums` narrows a parameter to the values that actually exist for THIS user — their real subjects,
// their real projects. A schema-level enum is enforced by the runtime, so the model cannot invent a
// value at all; it is the difference between "please reuse an existing subject" (advice a 7B model
// ignores) and "there is no other option" (a fact).
function toolSchemas(names, enums = {}) {
  return (names || [])
    .map((n) => AI_TOOLS[n])
    .filter(Boolean)
    .map((t) => {
      let params = t.parameters;
      const forTool = enums[t.name];
      if (forTool) {
        params = JSON.parse(JSON.stringify(params));
        for (const [param, values] of Object.entries(forTool)) {
          if (params.properties && params.properties[param] && Array.isArray(values) && values.length) {
            params.properties[param].enum = values;
          }
        }
      }
      return { type: 'function', function: { name: t.name, description: t.description, parameters: params } };
    });
}

/**
 * The agent loop: ask → run the chosen tool → feed the result back → ask again, until the model
 * calls a terminal tool.
 *
 * Three deliberate properties:
 *  • NO TOOL CALL is a real answer, not an error to be parsed around. A model given tools that
 *    replies in prose is telling you it doesn't know — the old parseJsonLoose could never express
 *    that, because it always returned an object.
 *  • A HALLUCINATED TOOL NAME is corrected in-band (we tell it what actually exists and let it try
 *    again) rather than crashing the run.
 *  • MAX STEPS is a hard stop. A local model that keeps searching and never decides must not spin.
 */
async function runToolLoop({ model, system, user, tools, ctx = {}, enums = {}, maxSteps = 6, temperature = 0.1, timeout = 120000 }) {
  const schemas = toolSchemas(tools, enums);
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const trace = [];

  for (let step = 0; step < maxSteps; step += 1) {
    let r;
    try {
      // eslint-disable-next-line no-await-in-loop
      r = await ollamaChat(model, messages, { tools: schemas, temperature, timeout });
    } catch (err) {
      // A transient transport failure (a 400 context blowout, a 500 during a model reload, a dropped
      // socket) used to throw straight OUT of this loop and abort the whole batch — even though every
      // other failure in here degrades gracefully, and the doc comment above promises exactly that.
      // Return the trace built so far so the caller can fall back to asking the user, and so the
      // reasoning already established isn't thrown away over one blip (audit #22).
      return { ok: false, reason: 'transport_error', error: (err && err.message) || String(err), trace };
    }

    if (!r.toolCalls.length) {
      return { ok: false, reason: 'no_tool_call', content: r.content, trace };
    }

    const call = r.toolCalls[0];
    const tool = AI_TOOLS[call.name];
    const assistantTurn = { role: 'assistant', content: '', tool_calls: [{ function: { name: call.name, arguments: call.args } }] };

    if (!tool || !tools.includes(call.name)) {
      messages.push(assistantTurn);
      messages.push({ role: 'tool', content: `There is no tool called "${call.name}". Available: ${tools.join(', ')}. Call one of those.` });
      trace.push({ tool: call.name, args: call.args, error: 'unknown tool' });
      continue;
    }

    // PROTOCOL, enforced in code. A model that skips straight to "create a project" for footage it
    // never searched for is guessing, and it will do that confidently every time (observed: qwen3:8b
    // invented "Client - Grey Object" for a clip it could not identify). Refuse and tell it why —
    // it then searches, and either finds the right home or asks.
    const ran = (n) => trace.some((t) => t.tool === n && !t.error);
    const missing = (tool.requires || []).filter((req) => !ran(req));
    const anyList = tool.requiresAny || [];
    const anyUnmet = anyList.length > 0 && !anyList.some(ran);
    if (missing.length || anyUnmet) {
      const need = missing.length ? missing.join(' and ') : anyList.join(' or ');
      messages.push(assistantTurn);
      messages.push({ role: 'tool', content: `You must call ${need} before ${call.name}. Do that first — and if nothing suitable comes back, ask_user rather than inventing something.` });
      trace.push({ tool: call.name, args: call.args, error: `requires ${need}` });
      continue;
    }

    let result;
    // eslint-disable-next-line no-await-in-loop
    try { result = await tool.run(call.args || {}, ctx); }
    catch (e) { result = { error: (e && e.message) || String(e) }; }
    trace.push({ tool: call.name, args: call.args, result });

    if (tool.terminal) return { ok: !(result && result.error), tool: call.name, args: call.args, result, trace };

    messages.push(assistantTurn);
    // Cap what we feed back: a huge tool result just re-creates the giant-prompt problem.
    messages.push({ role: 'tool', content: JSON.stringify(result).slice(0, 3000) });
  }
  return { ok: false, reason: 'max_steps', trace };
}

// --- shared helpers ---------------------------------------------------------------------

const aiWords = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);

// The same slug the renderer names every clip with (src/mod/01-core.js). `slug()` itself lives only
// in the renderer, and main has only `slugFolder` (which additionally guards Windows reserved names,
// wrong for a name FRAGMENT). Keeping the format identical is the point: the model supplies meaning,
// this supplies the form, and the form is then the same whether a human or a tool produced it.
function aiSlug(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Does a query word match a project word? NOT exact equality.
//
// This was exact-match, and a live run against the real qwen3:8b showed exactly why that is fatal:
// footage described as "two people SKINNING up a snowy ridge, ALPINE" scored ZERO against a project
// called "Alps 2026" whose subjects are "skiing, ski touring" — because "alpine" != "alps" and
// "skinning" != "skiing". The search found nothing, so the model dutifully created a new project
// called "Alpine Skinning Ridge". The model was not being stupid; the TOOL was, and the model could
// only be as good as what the tool told it.
//
// A shared prefix is enough here. This is a SEARCH — it returns candidates for the model to choose
// between, so a loose match that surfaces the right project costs nothing, while a strict one that
// hides it costs a wrongly-created project. Prefer recall.
function aiTokenMatch(a, b) {
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;

  // A TRUE PREFIX is a match even for a short word: mow/mowing, ski/skiing, garden/gardening. The
  // user types "mow" one day and "mowing" the next; re-asking over a suffix is exactly the "it
  // forgot" feeling this is meant to eliminate.
  if (short.length >= 3 && long.startsWith(short)) return true;

  // Otherwise both words must be substantial and share their first THREE characters. Three, not
  // four: the two cases that actually broke a live run both share exactly three —
  //   alpine / alps      -> "alp"
  //   skinning / skiing  -> "ski"
  // A 4-char threshold would have left the bug exactly where it was. This number is measured against
  // the words that really failed, not picked because it looked safe.
  if (a.length < 4 || b.length < 4) return false;          // no 3-letter noise (cat/car stays a miss)
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i >= 3;
}

// Slug, then keep only the first N words. The filename has to stay usable.
// Function words that must never START or END a description.
//
// MEASURED against the real qwen3:8b: handed a rich observation, it answers with an English SENTENCE,
// and capping that at 8 words just truncates it — `two-men-sit-on-a-cut-lawn-beside`. Severed at a
// preposition, stuffed with articles, and nothing like his own `wood-cleanup-fairview`.
//
// Only the EDGES are stripped, deliberately. Interior function words are left alone: his own
// `headcam-getting-into-truck-and-checking-trailer` needs its `into` and its `and`, and a blanket
// stopword strip would rewrite his style rather than enforce it. Leading filler is dropped BEFORE the
// cap so the cap is not spent on "a"; trailing filler AFTER it, because that is where truncation
// leaves the dangling preposition.
const EDGE_FILLER = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'of', 'on', 'in', 'at', 'to', 'for', 'with',
  'and', 'or', 'by', 'from', 'into', 'near', 'beside', 'over', 'under', 'as', 'but', 'it', 'its',
  'his', 'her', 'their', 'this', 'that', 'there',
]);

function aiCapWords(s, n) {
  const w = aiSlug(s).split('-').filter(Boolean);
  while (w.length && EDGE_FILLER.has(w[0])) w.shift();
  const cut = w.slice(0, n);
  while (cut.length && EDGE_FILLER.has(cut[cut.length - 1])) cut.pop();
  return cut.join('-');
}

// How well does a candidate match a query? Weighted so a matched PERSON or DATE counts for more than
// a generic word — the same intuition the deterministic ledger matcher already uses, in one place.
// A DATED FOLDER IS THE HOME OF THAT SHOOT — AND NO OTHER.
//
// Some of his project folders ARE shoots: `2026-05-30_vlog_water-park_v1`, `2026-06-11_vlog_footage-
// from-gopros_v1`. He names them exactly like clips. Which means the folder name contains the SUBJECT
// word `vlog` — so every vlog shoot he ever films matches it lexically, forever.
//
// Measured on his real tree with the real qwen3: a wedding for a NEW client got filed into
// `2026 - Personal/2026-06-11_vlog_footage-from-gopros_v1`, three runs out of three. The search
// returned it as a hit, and the model trusts hits. It was never a hit; it was a word collision.
//
// The rule his tree actually encodes:
//   dateless folder  (`Gourgess Lawns`, `Calisthetics Journey`) → an ONGOING project. New shoots welcome.
//   dated folder     (`2026-05-30_vlog_water-park_v1`)          → the home of THAT shoot, and no other.
//
// So a candidate carrying a date that is not this shoot's date is not a candidate. Better prompting
// would not have fixed this — the tool was handing the model a wrong answer and calling it a match.
const DATE_IN_NAME = /(\d{4}-\d{2}-\d{2})/;
function folderIsOtherShoot(rel, shootDate) {
  const m = DATE_IN_NAME.exec(String(rel || '').split('/').pop() || '');
  if (!m) return false;                                   // no date → an ongoing project
  const day = String(shootDate || '').slice(0, 10);
  return m[1] !== day;                                    // dated, and not OUR shoot
}

function aiScore(queryTokens, cand) {
  const q = queryTokens;
  const hit = (field, weight) => {
    let n = 0;
    for (const t of aiWords(field)) if (q.some((qt) => aiTokenMatch(qt, t))) n += weight;
    return n;
  };
  let s = 0;
  s += hit(cand.name, 2);
  s += hit((cand.subjects || []).join(' '), 2);
  s += hit((cand.people || []).join(' '), 3);
  s += hit((cand.locations || []).join(' '), 2);
  s += hit(cand.rel, 1);
  for (const d of (cand.dates || [])) if (q.includes(d)) s += 3;
  return s;
}

// --- PROJECT PLACEMENT tools ------------------------------------------------------------
//
// The old placement prompt handed the model up to 80 bare FOLDER NAME strings and told it "PAST
// FILING MEMORY WINS" — about a ledger that is only written after this app files something, so for
// anyone with an existing library it was an instruction about an empty list. The model was never
// shown what is actually INSIDE any project. It was being asked to group things it could not see.

defineTool('search_projects', {
  description: 'Search the user\'s existing projects. Returns real projects with what is actually in them (how many clips, which subjects, which people, when they were last filed). ALWAYS search before deciding — an existing project almost always fits.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What the footage is about — subject, people, place, date. e.g. "mowing the back garden, summer"' },
    },
    required: ['query'],
  },
  run: async ({ query }, ctx) => {
    const q = aiWords(query);
    const cands = [];

    // 1. Projects we have actually filed into before — these carry real content.
    for (const p of (config.projectLedger || [])) {
      cands.push({
        path: p.rel,
        name: p.name,
        clips: p.clips || 0,
        subjects: (p.subjects || []).slice(0, 6),
        people: (p.people || []).slice(0, 6),
        locations: (p.locations || []).slice(0, 4),
        dates: (p.dates || []).slice(-4),
        last_filed: p.lastSeen ? new Date(p.lastSeen).toISOString().slice(0, 10) : '',
        _score: aiScore(q, { name: p.name, rel: p.rel, subjects: p.subjects, people: p.people, locations: p.locations, dates: p.dates }),
      });
    }

    // 2. Folders that exist on disk but we have never filed into (an existing library!). The ledger
    //    knows nothing about these, which is exactly the case the old prompt was blind to.
    const known = new Set(cands.map((c) => c.path));
    for (const rel of (ctx.folders || [])) {
      if (known.has(rel)) continue;
      const name = rel.split('/').pop();
      cands.push({
        path: rel, name, clips: null, subjects: [], people: [], locations: [], dates: [], last_filed: '',
        _score: aiScore(q, { name, rel }),
      });
    }

    const hits = cands
      .filter((c) => c._score > 0)
      .filter((c) => !folderIsOtherShoot(c.path, ctx.date))   // someone else's shoot is not a home for ours
      .sort((a, b) => b._score - a._score).slice(0, 8);
    if (!hits.length) {
      // A zero-match search is where a model invents a project. Give it the retry FIRST — a different
      // query (the place, a person, a broader word) very often finds the right home — and make asking
      // the next option after that. Creating is last.
      return {
        matches: [],
        note: 'Nothing matched THAT query. Search again with different words first — try the place, a person in it, or a broader term. If a second search still finds nothing and you cannot confidently say what this footage is, call ask_user. Only create a project when you are sure it genuinely belongs somewhere new.',
      };
    }
    return { matches: hits.map(({ _score, ...rest }) => rest) };
  },
});

defineTool('inspect_project', {
  description: 'Look INSIDE a project: its subfolders and the clips actually filed there. Use this when you are unsure whether footage belongs in a project you found.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Project path exactly as returned by search_projects' } },
    required: ['path'],
  },
  run: async ({ path: rel }, ctx) => {
    const root = String(ctx.root || '').replace(/[\\/]+$/, '');
    if (!root) return { error: 'No projects root is set.' };
    const clean = String(rel || '').replace(/^[\\/]+|[\\/]+$/g, '');
    if (!clean || clean.includes('..')) return { error: 'Invalid path.' };

    const abs = path.join(root, ...clean.split('/'));
    let entries = [];
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); }
    catch { return { error: `"${clean}" does not exist on disk.` }; }

    const subfolders = entries.filter((e) => e.isDirectory()).map((e) => e.name).slice(0, 20);
    const clips = entries.filter((e) => e.isFile() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name).slice(0, 15);

    const led = (config.projectLedger || []).find((p) => p.rel === clean);
    return {
      path: clean,
      subfolders,
      clips_here: clips,
      total_clips_filed: led ? (led.clips || 0) : null,
      subjects_filed_here: led ? (led.subjects || []).slice(0, 8) : [],
      people_filed_here: led ? (led.people || []).slice(0, 8) : [],
      summary: led ? (led.summary || '') : '',
    };
  },
});

defineTool('place_in_project', {
  description: 'FILE this footage into an existing project. This is the decision — prefer it whenever a project reasonably fits.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Project path exactly as returned by search_projects or inspect_project' },
      by_day: { type: 'boolean', description: 'true to put the clips in a dated subfolder inside the project (use when the project already has per-day subfolders)' },
    },
    required: ['path'],
  },
  terminal: true,
  // A path the model neither FOUND nor was TOLD is a path it made up. Either is enough: a remembered
  // decision is the user's own answer, and re-searching for something they already told us would be
  // exactly the busywork this whole design exists to remove.
  requiresAny: ['search_projects', 'recall_decision'],
  run: async ({ path: rel, by_day }, ctx) => {
    const clean = String(rel || '').replace(/^[\\/]+|[\\/]+$/g, '');
    if (!clean || clean.includes('..')) return { error: 'Invalid path.' };
    // The model chose the project; the PATH is built by code, from the clip's own date. It never has
    // to construct a path string, so it can never construct a wrong one.
    const dest = (by_day && ctx.date) ? `${clean}/${ctx.date}` : clean;
    return { action: 'place', path: dest };
  },
});

defineTool('create_project', {
  description: 'Create a NEW project. ONLY after search_projects came back with nothing suitable. If you cannot tell what the footage even IS, call ask_user instead — never invent a project for footage you do not understand.',
  parameters: {
    type: 'object',
    properties: {
      parent: { type: 'string', description: 'Existing category/folder to create it under, e.g. "2026/2026 - Personal". Use "" for the top level.' },
      name: { type: 'string', description: 'Short project name, in the user\'s existing naming style' },
      why: { type: 'string', description: 'One line: why nothing existing fits' },
    },
    required: ['name'],
  },
  terminal: true,
  requires: ['search_projects'],   // you cannot create what you never looked for — see defineTool
  run: async ({ parent, name, why }, ctx) => {
    // safeFolderName, NOT slugFolder — the same function the rest of the app files with. His tree is
    // `2026 - Client Work / Gourgess Lawns`: Title Case, spaces. A proposed `charles-wedding` would sit
    // in there looking like it came from a different program, and slugging the PARENT would create
    // `2026-client-work` beside the real folder and fork the tree. Windows-illegal characters and
    // reserved names are handled here, once, not hoped for in a prompt.
    const leaf = safeFolderName(name);
    if (!leaf) return { error: 'That name is empty once cleaned up. Give a real name.' };

    const parts = String(parent || '').split('/').map((x) => safeFolderName(x)).filter(Boolean);

    // THE PARENT MUST BE A CATEGORY HE ACTUALLY HAS.
    //
    // A new PROJECT is a reasonable thing to invent. A new CATEGORY is not — his are `2026 - Client
    // Work`, `2026 - Personal`, `2026 - Social Media`, and a model that answers `Client Work` (dropping
    // the year) would have us create a second category folder beside the real one and split his tree in
    // half. Creating a project is allowed; creating the shelf it sits on is not.
    const known = (ctx.folders || []).map((f) => String(f.path || f));
    // Enforce against what we actually KNOW, never against ignorance. If we could not read the tree at
    // all, refusing every parent would block the one path he has left.
    if (parts.length && known.length) {
      const want = parts.join('/').toLowerCase();
      const hit = known.find((k) => k.toLowerCase() === want);
      if (!hit) {
        const top = [...new Set(known.map((k) => k.split('/')[0]))].slice(0, 12);
        return {
          error: `"${parts.join('/')}" is not a folder he has. Put the new project inside one of these: ${top.join(', ')}.`,
        };
      }
      return { action: 'create', path: `${hit}/${leaf}`, why: String(why || '') };   // HIS spelling
    }
    return { action: 'create', path: [...parts, leaf].join('/'), why: String(why || '') };
  },
});

defineTool('ask_user', {
  description: 'Ask the user. Use this whenever you are not confident: the footage is unrecognisable, or two projects fit equally well. Asking is ALWAYS better than guessing — a wrong new project is far more annoying to the user than a question. Only asking without having searched first is bad.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'One short, specific question' },
      options: { type: 'array', items: { type: 'string' }, description: '2-4 concrete answers to choose from' },
    },
    required: ['question'],
  },
  terminal: true,
  run: async ({ question, options }) => ({
    action: 'ask',
    question: String(question || '').slice(0, 200),
    options: (Array.isArray(options) ? options : []).map((o) => String(o).slice(0, 60)).slice(0, 4),
  }),
});

// --- NAMING tools -----------------------------------------------------------------------
//
// Vision models mostly cannot call tools, so this is deliberately split: the VISION model looks and
// produces an observation (no decisions), and the TOOL model turns that observation into a name by
// calling set_clip_name. The learning arrives as tool RESULTS the model can ask for, instead of as a
// wall of English rules stapled to the front of every prompt.

// MEASURED ON HIS REAL LIBRARY (310 clips he named himself), and this is the single biggest accuracy
// win in the naming loop — worth +20 percentage points on real footage (60% -> 80% subject match):
//
//   HE SHOOTS IN BATCHES. 20 of his 28 shoot days are ENTIRELY one subject. 2026-06-01 is 37
//   lawn-mowing clips and 14 vlog. Knowing only the DATE and guessing that day's dominant subject
//   scores 88% on its own — better than the whole vision pipeline managed.
//
// And it explains the failure the vision model could never fix: `2026-06-01_lawn-mowing_josiah_v23`
// is twelve minutes of two men SITTING ON THE GRASS repairing a mower. Nobody mows. No number of
// frames recovers "lawn-mowing" from those pixels, because the subject is what the footage is FOR —
// the job, the shoot — not the action on screen. That lives in the sibling clips, not in the frame.
//
// Deliberately returns the COUNTS rather than a single verdict, so the model weighs this against what
// it actually saw instead of parroting the majority. Verified on the adversarial case: on 2026-05-11
// (timelapse 13, pov 2) it still correctly answered `pov`, because the observation said so.
defineTool('get_shoot_context', {
  description: 'What the user already called the OTHER clips from this same shoot (same day). They shoot '
    + 'in batches, so this is usually the strongest signal about what a clip is FOR — which is not always '
    + 'the action visible in the frame. Weigh it against what you saw; a day can hold more than one subject.',
  parameters: { type: 'object', properties: {} },
  run: async (_args, ctx) => {
    const date = String(ctx.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { note: 'This clip has no date, so there is no shoot to compare it to.' };

    // He may have TOLD us what this shoot is. That outranks any amount of inference — it is not a
    // signal to weigh, it is the answer. Still returned alongside the counts rather than short-
    // circuiting the model, because a day can hold more than one subject (2026-06-01 is 37
    // lawn-mowing AND 14 vlog) and the observation still has to be able to disagree.
    const confirmed = recallShoot(date);

    const counts = {};
    const bump = (sub) => { const k = aiSlug(sub); if (k) counts[k] = (counts[k] || 0) + 1; };

    // 1) Clips named EARLIER IN THIS RUN. The batch names in order, so by the time we reach clip 30 of
    //    a shoot we already know what the first 29 were — use it.
    for (const sib of (ctx.siblings || [])) {
      if (String(sib.date || '').slice(0, 10) === date) bump(sib.subject);
    }
    // 2) …and everything he has ALREADY named on disk from that day. This is what makes it work on the
    //    very first clip of a re-visited shoot, where the run itself knows nothing yet.
    //    currentFinalMeta(), NOT config.finalMeta — the latter is an in-memory copy that goes stale,
    //    which is the whole reason freshStore() exists.
    for (const rec of Object.values(currentFinalMeta() || {})) {
      if (rec && String(rec.date || '').slice(0, 10) === date) bump(rec.subject);
    }

    // ⚠ THESE EXACT STRINGS ARE LOAD-BEARING. MEASURED, DO NOT "TIDY".
    //
    // I renamed this key and reworded the note — a purely cosmetic change, same data — and it flipped
    // `2026-05-11_pov_wood-cleanup-fairview` from `pov` (correct) to `vlog` (wrong), deterministically,
    // 4 runs out of 4 each way, at temperature 0.1. A rename cost 20 points of subject accuracy.
    //
    // On an 8B model the phrasing of a tool RESULT is not decoration, it is input. "for the same day"
    // + "a day can STILL contain more than one subject" keeps the counts as evidence to weigh. Calling
    // the day a "shoot" frames it as one thing and the model starts answering with the day instead of
    // with the footage. If you change these words, re-measure — there is a test pinning them.
    if (!Object.keys(counts).length) {
      return confirmed
        ? { date, he_told_you_this_shoot_is: confirmed, note: 'He answered this himself. Use it unless what you saw plainly contradicts it.' }
        : { date, note: 'Nothing else from this day has been named yet — go on what you saw.' };
    }
    return {
      date,
      ...(confirmed ? { he_told_you_this_shoot_is: confirmed } : {}),
      clips_you_already_named_from_this_shoot: counts,
      note: 'These are his own names for the same day. Weigh them against the observation — a day can still contain more than one subject.',
    };
  },
});

defineTool('get_naming_style', {
  description: 'Get real examples of how the user names their own footage, plus the subjects they already use and who face recognition identified in THIS clip. Call this FIRST — matching their existing style matters more than being descriptive.',
  parameters: { type: 'object', properties: {} },
  run: async (_args, ctx) => {
    const ai = config.ai || {};
    const people = (ctx.people || []).filter(Boolean);
    return {
      examples: styleFewShot(12),          // his CORRECTIONS first, then the mined archive — see styleFewShot
      known_subjects: (ctx.subjects || []).slice(0, 30),
      preferences: selectMemories(ai.memories, ctx.clipText || '', 12).map((m) => m.text),

      // ⚠ FACE RECOGNITION BELONGS IN THE NAME. Owner, on reading the output: "I don't like those
      // descriptions. It should also be using the face recognition."
      //
      // The app already runs face recognition and already hands the names to this loop — and the model
      // still wrote `men-working-on-mower`. Of course it did: the VISION model cannot know that man is
      // Josiah, so nothing in the observation ever says so, and nothing told the reasoning model that
      // the name it was given outranks what the camera saw. His own archive is `josiah-front-lawn`,
      // `liam-mowing-front-lawn`, `josiah-cleanroom-timelapse` — THE PERSON'S NAME IS THE DESCRIPTION.
      //
      // It goes in the TOOL RESULT, not just the system prompt, because on an 8B model a tool result is
      // input and a system prompt is a suggestion — the same lesson get_shoot_context already taught us
      // the hard way. Only when there is someone to name: an empty list invites "no people visible".
      // ALL of them, not just the first. He shoots his family: two and three people in a shot is the
      // normal case, and his own names say so (`vloghead-owenpack-josiahpack-insidehouse`). A note that
      // said "use their NAMES" while the model only ever wrote one was half a feature.
      ...(people.length ? {
        people_recognised_in_this_clip: people,
        people_note: people.length > 1
          ? `Face recognition identified all ${people.length} of them — the camera could not. Name EVERY one of them in the description, in this order (${people.join(', ')}), exactly as he does (josiah-liam-building-treehouse). Never "men", "two people" or "someone" when you have been told who they are.`
          : 'Face recognition identified them — the camera could not. Use their NAME in the description, exactly as he does (josiah-front-lawn). Never "a man", "a boy" or "someone" when you have been told who it is.',
      } : {}),
    };
  },
});

// The subject is CONSTRAINED, not suggested.
//
// Measured on Jake's real archive and his real models: with a good vision model the naming loop still
// produced `car-door`, `computertime` and `skateboarding` as SUBJECTS — because a vision model
// describes OBJECTS, while his subjects are kinds of SHOOT (`vlog`, `pov`, `lawn-mowing`,
// `calisthenics`). Asking nicely in a description does not fix that; his archive already contains
// `lawn-mowing` (68 clips) AND `lawnmowing` (15) as separate subjects, which is precisely this bug
// having already happened to him.
//
// So when we know his subjects, the schema is an ENUM. Ollama enforces enums in tool schemas, so an
// invented subject becomes IMPOSSIBLE rather than merely discouraged — and a genuinely new subject
// has to go through propose_new_subject, which is a deliberate, visible act. Structure beats
// instruction, again.
defineTool('set_clip_name', {
  description: 'Name the clip using one of the user\'s EXISTING subjects. The subject is the KIND OF SHOOT (e.g. vlog, pov, lawn-mowing) — not the objects in frame. Put what is actually happening in the description. If truly none of the existing subjects fit, call propose_new_subject instead.',
  parameters: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'One of the user\'s existing subjects — the KIND of shoot, not what is in frame.' },
      // ⚠ MEASURED. This field said only "What is HAPPENING — concrete and specific. This is where the
      // detail goes." Handed a rich observation the real qwen3:8b answered with an English SENTENCE,
      // which the word-cap then truncated into `two-men-sit-on-a-cut-lawn-beside` — an unusable
      // filename. The rules below are not new: they are the ones the LEGACY giant prompt already had
      // and this tool path dropped, so on this one field the redesign was WORSE than what it replaced.
      // Keywords, a word count, and real examples of his — re-measure if you touch them.
      description: { type: 'string', description: '2-6 keywords for WHAT IS HAPPENING — the action plus the setting or object, joined by hyphens. Good: "pushups-on-grass", "liam-mowing-front-lawn", "chainsaw-stump-removal". If get_naming_style named the people recognised in this clip, LEAD with their name ("josiah-repairing-mower", not "men-repairing-mower") — never "men", "a boy" or "someone" when you know who it is. The filename ALREADY contains the subject, so do not just restate it ("josiah-lawn-mowing" adds nothing) — say what makes THIS clip different from the others in the shoot. NEVER a sentence: no articles or filler ("a", "the", "is", "of", "on", "with"). Match the style of the user\'s own examples.' },
      shot_type: { type: 'string', description: 'e.g. wide, close-up, handheld, static, pan, follow. "" if unclear.' },
      tags: { type: 'array', items: { type: 'string' }, description: '3-8 short lowercase keywords visible in the footage' },
    },
    required: ['subject', 'description'],
  },
  terminal: true,
  // ⚠ THE SHOOT CONTEXT IS NOT OPTIONAL — and asking nicely stopped working.
  //
  // get_shoot_context is the single biggest naming win there is (measured: subject accuracy 60% → 80%,
  // and 100% once he answers the shoot). The system prompt merely ASKED for it, which held right up
  // until get_naming_style started returning the recognised people too — the richer result made the
  // model feel it had enough, and it went straight to naming. Measured, 4 runs of 4: the protocol
  // collapsed from `get_naming_style → get_shoot_context → set_clip_name` to two calls.
  //
  // It got the subject right anyway, by luck: the word "lawn" was in the observation. The clips that
  // NEED this tool are exactly the ones where it is not — men sitting on the grass repairing a mower
  // is a lawn-mowing shoot, and nothing in the pixels says so. So the loop refuses to name a clip until
  // the shoot has been looked at. Structure beats instruction, again.
  requires: ['get_shoot_context'],
  run: async ({ subject, description, shot_type, tags }) => {
    // The model supplies MEANING; the format is not its problem. The subject is slugged here (it is an
    // identity — `lawn-mowing` and `Lawn Mowing` must never become two subjects). The description is
    // only word-capped here and left as prose: composeBase() in the renderer slugs it when it builds
    // the actual filename, so `people working outside` lands on disk as `people-working-outside`
    // either way. Slugging it twice would be harmless but the single owner is composeBase().
    const subj = aiSlug(String(subject || ''));
    if (!subj) return { error: 'subject came back empty. Give the actual subject of the footage.' };
    return {
      action: 'name',
      subject: subj,
      // Measured against Jake's real archive: his descriptions are 1-7 words
      // ("josiah-cleanroom-timelapse", "headcam-getting-into-truck-and-checking-trailer", "josiah").
      // A model handed a rich observation writes 20+ ("a-young-boy-moving-through-his-cluttered-
      // bedroom-standing-near-the-bed-sitting-on-the-floor-and-standing-again"), which makes an
      // unusable filename. Asking for brevity in a prompt is unreliable; capping it here is not.
      description: aiCapWords(description, 8),
      shotType: aiSlug(String(shot_type || '')),
      tags: (Array.isArray(tags) ? tags : []).map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 8),
    };
  },
});

defineTool('propose_new_subject', {
  description: 'Only if NONE of the user\'s existing subjects fit this kind of shoot. This is rare — a near-duplicate subject ("lawnmowing" next to "lawn-mowing") permanently fragments their archive, which has already happened to them. Say why nothing existing fits.',
  parameters: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'The new subject — the KIND of shoot, 1-3 words' },
      why: { type: 'string', description: 'Why none of the existing subjects fit' },
      description: { type: 'string', description: 'What is happening in this clip' },
    },
    required: ['subject', 'why', 'description'],
  },
  terminal: true,
  run: async ({ subject, why, description }, ctx) => {
    const subj = aiSlug(subject || '');
    if (!subj) return { error: 'That subject is empty once cleaned up.' };

    // Last-line guard, in CODE. Even with an enum on set_clip_name, the model can route around it by
    // coming here — so anything that is merely a rewording of an existing subject is REFUSED and sent
    // back. This is the check that would have stopped "lawnmowing" ever being created alongside
    // "lawn-mowing", which is a real, permanent split in Jake's archive today.
    const known = (ctx.subjects || []).map((x) => aiSlug(x)).filter(Boolean);
    const clash = known.find((k) => aiTokenMatch(k, subj) || k.replace(/-/g, '') === subj.replace(/-/g, ''));
    if (clash) {
      return { error: `"${subj}" is the same subject as the existing "${clash}". Call set_clip_name with subject "${clash}" instead — a near-duplicate permanently splits the archive.` };
    }
    return { action: 'name', subject: subj, description: aiCapWords(description, 8), shotType: '', tags: [], newSubject: true, why: String(why || '') };
  },
});

// --- LEDGER BACKFILL --------------------------------------------------------------------
//
// The ledger is only written AFTER this app files a clip (`ledger:record`). So for anyone with an
// existing library — say 200 projects filed by hand over years — it is completely empty, and the old
// placement prompt cheerfully instructed the model that "PAST FILING MEMORY WINS" about a list with
// nothing in it. The model was reduced to guessing from bare folder names.
//
// This reads what is ALREADY on disk and builds the memory that should have been there: for each
// project folder, the clips in it, and the subjects/dates/people their filenames encode. It is
// idempotent (a project already in the ledger is only enriched, never duplicated) and it is pure
// reading — nothing is moved, renamed or written to the user's tree.
async function backfillLedgerFromTree(root, onProgress) {
  const base = String(root || config.projectsRoot || defaultProjectsRoot()).replace(/[\\/]+$/, '');
  if (!base) return { ok: false, error: 'No projects root set' };
  try { await fsp.access(base); } catch { return { ok: false, error: `Folder not found: ${base}` }; }

  const tree = await readProjectTree(base, 4);
  const rels = [];
  const walk = (nodes, prefix) => {
    for (const n of nodes) {
      const rel = prefix ? `${prefix}/${n.name}` : n.name;
      rels.push(rel);
      if (n.children && n.children.length) walk(n.children, rel);
    }
  };
  walk(tree, '');

  if (!Array.isArray(config.projectLedger)) config.projectLedger = [];
  let learned = 0; let scanned = 0;

  for (const rel of rels) {
    scanned += 1;
    if (onProgress && scanned % 10 === 0) { try { onProgress(scanned, rels.length, rel); } catch { /* ignore */ } }

    const abs = path.join(base, ...rel.split('/'));
    // eslint-disable-next-line no-await-in-loop
    // PHOTOS COUNT AS FOOTAGE HERE. A folder holding only stills is a real project — measured, his
    // 203 intake photos file into 10 dated folders — but a video-only listing sees it as empty and
    // the `!clips.length` guard below then skips it as "a container folder". The importer whose whole
    // job is to learn what is already on disk would silently omit every photo shoot he has.
    const clips = [...await listVideosShallow(abs), ...await listImagesShallow(abs)];
    if (!clips.length) continue;   // a container folder, not a project

    // What do the filenames actually say? parseNamedClip understands this app's own naming scheme,
    // and returns nothing for a file that doesn't follow it — which is fine, the clip count alone is
    // still real information.
    const subjects = new Set(); const dates = new Set(); const samples = [];
    for (const c of clips) {
      const meta = parseNamedClip(c.name);
      if (meta && meta.subject) subjects.add(meta.subject);
      if (meta && meta.date) dates.add(meta.date);
      if (samples.length < 6) samples.push(c.name);
    }

    const key = rel;
    let rec = (config.projectLedger || []).find((p) => p.rel === key);
    if (!rec) {
      const segs = key.split('/');
      rec = {
        id: newMemId(), rel: key, name: segs[segs.length - 1],
        category: segs.slice(0, Math.min(2, segs.length)).join('/'),
        dates: [], subjects: [], locations: [], people: [], samples: [],
        clips: 0, summary: '', summaryClips: 0,
        firstSeen: Date.now(), lastSeen: Date.now(), backfilled: true,
      };
      config.projectLedger.push(rec);
      learned += 1;
    }
    // ENRICH, never clobber: a project we have really filed into knows more than a filename parse.
    rec.clips = Math.max(rec.clips || 0, clips.length);
    rec.subjects = [...new Set([...(rec.subjects || []), ...subjects])].slice(0, 24);
    rec.dates = [...new Set([...(rec.dates || []), ...dates])].sort().slice(-24);
    rec.samples = [...new Set([...(rec.samples || []), ...samples])].slice(0, 8);
  }

  // projectLedger is a SIDECAR store, and saveConfig() runs stripStoresForWrite(), which deletes
  // every key whose sidecar exists on disk. Saving config ALONE therefore discarded this entire
  // import at the next launch — silently, after reading a whole library. Every other ledger writer
  // pairs these two; this one did not.
  saveStore('projectLedger');
  saveConfig();
  return { ok: true, projects: (config.projectLedger || []).length, learned, scanned: rels.length };
}

ipcMain.handle('ai:backfillLedger', async (evt, root) => {
  const send = (n, total, rel) => { try { evt.sender.send('ai:pull-progress', { status: `Reading ${rel}`, percent: Math.round((n / Math.max(1, total)) * 100) }); } catch { /* ignore */ } };
  try { return await backfillLedgerFromTree(root, send); }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

// --- the two things the model is actually FOR --------------------------------------------

// Where does this footage belong? One tool loop per SUBJECT GROUP, not per clip.
//
// Grouping the clips by subject is deterministic — it needs no model at all — so we do it in code and
// ask the model exactly one question per group. A card of 309 clips is usually ~15 subjects, so this
// is ~15 decisions instead of 309, and every clip in a group is guaranteed to land together (the old
// per-clip approach could scatter the same shoot across three projects).
ipcMain.handle('ai:placeGroup', async (_evt, payload) => {
  const model = await aiToolModel();
  if (!model) {
    return { ok: false, error: 'No tool-capable reasoning model. Install one (e.g. `ollama pull qwen3:8b`) — a vision model cannot do this.' };
  }
  const g = payload || {};

  // ASK ONCE, THEN KNOW. If he has already told us where THIS SHOOT goes, that is the answer — no
  // model call, no prompt, no variability, no latency. The model is only ever consulted about footage
  // he has genuinely never ruled on, which is the only place a model belongs.
  //
  // `date` is what makes that safe. Without it, recall matched on subject alone and a NEW lawn-mowing
  // shoot was silently filed into the project of an OLD one — no card, no question. Only the same
  // shoot may skip the question; a familiar-looking different shoot falls through to the model (and
  // the grid offers the old path as a one-click suggestion).
  const known = recallPlacement({ date: g.date, subject: g.subject, people: g.people, location: g.location });
  if (known && known.confidence === 'exact') {
    return { ok: true, action: 'place', path: known.path, recalled: true, told_before: known.told_before, trace: [] };
  }

  // A FAMILIAR SUBJECT ON A DIFFERENT SHOOT IS NOT THE MODEL'S CALL TO MAKE.
  //
  // Measured on the real qwen3:8b: handed a `likely` recall from an earlier shoot — with a note
  // spelling out "this may be a new job that happens to look the same; if you cannot tell, ask_user,
  // do not assume" — it filed into the old project anyway, 4 runs out of 4. It never once asked.
  //
  // Which is the whole lesson of this codebase again: the prompt asks, the code decides. So the code
  // decides. This comes back as a SUGGESTION — a one-click yes/no card in the review grid, showing
  // which shoot the project came from — and the model is never consulted. He can accept it in a click,
  // and a new job never lands in an old job's project without him seeing it.
  if (known && known.confidence === 'likely') {
    return {
      ok: true,
      action: 'suggest',
      path: known.path,
      why: known.from_shoot ? `you filed the ${known.from_shoot} ${aiSlug(g.subject || '')} shoot here` : 'you filed this kind of footage here before',
      told_before: known.told_before,
      trace: [],
    };
  }

  const root = String(config.projectsRoot || defaultProjectsRoot()).replace(/[\\/]+$/, '');

  // Every folder that exists on disk — so a project we have never filed into is still findable.
  const folders = [];
  try {
    const walk = (nodes, prefix) => {
      for (const n of nodes) {
        const rel = prefix ? `${prefix}/${n.name}` : n.name;
        folders.push(rel);
        if (n.children && n.children.length) walk(n.children, rel);
      }
    };
    walk(await readProjectTree(root, 4), '');
  } catch { /* no tree → the model can still create */ }

  const people = (g.people || []).filter(Boolean);
  const user = [
    `Footage to file: ${g.count || 1} clip${(g.count || 1) !== 1 ? 's' : ''}.`,
    `Subject: ${g.subject || '(unnamed)'}`,
    g.description ? `Description: ${g.description}` : '',
    g.observation ? `What the camera saw: ${g.observation}` : '',
    people.length ? `People in it: ${people.join(', ')}` : '',
    g.location ? `Location: ${g.location}` : '',
    g.date ? `Date: ${g.date}` : '',
  ].filter(Boolean).join('\n');

  const system = [
    'You file a videographer\'s footage into their existing project tree.',
    'FIRST call recall_decision — if the user has already told you where this kind of footage goes, just use that. Never ask a question you have already been given the answer to.',
    'Otherwise search_projects. An existing project almost always fits — creating a new project for footage that belongs in an old one is the worst mistake you can make.',
    'If a search finds nothing, search AGAIN with different words (the place, a person, a broader term) before concluding anything.',
    'Then call exactly one of: place_in_project, create_project, or ask_user.',
    'Do not explain yourself. Choose a tool.',
  ].join(' ');

  const r = await runToolLoop({
    model, system, user,
    tools: ['recall_decision', 'search_projects', 'inspect_project', 'place_in_project', 'create_project', 'ask_user'],
    ctx: { root, folders, date: g.date || '', location: g.location || '' },
    maxSteps: 7,
  });

  // A model that answers in prose, or never decides, is telling us it doesn't know. Don't invent a
  // destination for it — surface it as a question, which is the honest outcome and the one Jake can
  // actually act on.
  if (!r.ok) {
    return {
      ok: true,
      action: 'ask',
      question: `Where should "${g.subject || 'these clips'}" go?`,
      options: [],
      reason: r.reason,
      trace: r.trace,
    };
  }
  return { ok: true, ...r.result, trace: r.trace };
});

// Name one clip from what the vision model SAW. The vision model looks; this one decides.
ipcMain.handle('ai:nameFromObservation', async (_evt, payload) => {
  const model = await aiToolModel();
  if (!model) return { ok: false, error: 'No tool-capable reasoning model installed.' };
  const p = payload || {};
  if (!p.observation) return { ok: false, error: 'No observation to name from.' };

  const user = [
    `What the camera saw: ${p.observation}`,
    p.context ? `The user's note about this shoot: ${p.context}` : '',
    (p.people || []).length ? `Recognised people in it: ${(p.people || []).join(', ')}` : '',
  ].filter(Boolean).join('\n');

  const system = [
    "You name a videographer's clips.",
    'First call get_naming_style to see how THEY name things, which subjects they already use, and WHO',
    'face recognition identified in this clip; and get_shoot_context to see what they called the other',
    'clips from this same shoot.',
    'The SUBJECT is what the footage is FOR — the shoot or the job (vlog, pov, lawn-mowing…) — NOT the',
    'objects in frame and not always the action on screen: men repairing a mower still belong to a',
    'lawn-mowing shoot. Everything you can actually see goes in the DESCRIPTION.',
    'If people were recognised, NAME them in the description — the camera cannot tell you who someone',
    'is, so a recognised name always beats "men" or "a boy".',
    'Then call set_clip_name with one of their existing subjects. Only if genuinely none of them fit, call propose_new_subject.',
    'Do not explain — call the tools.',
  ].join(' ');

  // The user's REAL subjects become a schema-level enum, so an invented subject is impossible rather
  // than discouraged. A genuinely new one must go through propose_new_subject, which refuses a
  // near-duplicate outright.
  const subjects = (p.subjects || []).map((x) => aiSlug(x)).filter(Boolean);
  const r = await runToolLoop({
    model, system, user,
    tools: ['get_naming_style', 'get_shoot_context', 'set_clip_name', 'propose_new_subject'],
    ctx: {
      subjects,
      clipText: `${p.observation} ${p.context || ''}`,
      date: p.date || '',
      siblings: p.siblings || [],
      // Face recognition already ran and already knew who this was — the loop just never told the model
      // in a place it reads. get_naming_style surfaces it now. See the note in that tool.
      people: (p.people || []).filter(Boolean),
    },
    enums: subjects.length ? { set_clip_name: { subject: subjects } } : {},
    maxSteps: 5,
  });
  // Report the ACTUAL cause. A transport failure is not the model failing to decide — telling Jake
  // "never settled on a name" when Ollama returned a 500 sends him debugging the wrong thing
  // (a prompt/model problem) instead of the right one (the server, or the context window).
  if (!r.ok) {
    const why = r.reason === 'no_tool_call' ? 'The model answered in prose instead of naming the clip.'
      : r.reason === 'transport_error' ? `Couldn't reach the AI model: ${r.error || 'the request failed'}`
        : 'The model never settled on a name.';
    return { ok: false, error: why, reason: r.reason, trace: r.trace };
  }
  // Apply the SAME deterministic cleanup the legacy path guarantees (audit #24). cleanNameField
  // swaps a generic crowd word for the person face recognition already identified — "two men
  // repairing mower" → "josiah-repairing-mower". Without it the tool path returned the model's words
  // raw, so the exact failure all the shoot-context work exists to fix came straight back through
  // the new path. Two naming paths must not disagree about a deterministic post-process, for the
  // same reason §2 requires the two FILING paths to agree.
  //
  // Applied here (result assembly) rather than inside set_clip_name.run(), because this is where the
  // recognised people are in scope — and it is where the legacy path applies it too.
  //
  // DESCRIPTION ONLY. The subject is schema-constrained to one of his EXISTING subjects and is an
  // identity, not prose: injecting a person's name into it would invent a subject he does not have
  // and fragment his library. The legacy path cleans both because there the subject is free-form.
  const recognised = (p.people || []).filter(Boolean);
  const out = { ...r.result };
  if (recognised.length && out.description) out.description = cleanNameField(out.description, recognised);
  return { ok: true, ...out, trace: r.trace };
});

// --- SHOOT MEMORY — "or it only ever asks it once and then it knows" ----------------------
//
// The residual failure from the real-footage run: `2026-06-01_lawn-mowing_josiah_v23` is twelve
// minutes of two men sitting on the grass repairing a mower. Nobody mows. The label is not in the
// pixels, and no vision model will ever find it. The AI called it `vlog`, which is a perfectly
// reasonable reading of what it saw, and wrong.
//
// Guessing that clip is the wrong behaviour. Asking about it 37 times — once per clip of that shoot —
// is worse. So: ask ONCE PER SHOOT. He shoots in batches (20 of his 28 days are a single subject), so
// one answer settles the whole day, and it is remembered forever. The 38th clip of that shoot costs
// zero questions and zero model calls to place.
function shootMemory() {
  if (!Array.isArray(config.shootMemory)) config.shootMemory = [];
  return config.shootMemory;
}
const shootDay = (d) => String(d || '').slice(0, 10);

function rememberShoot({ date, subject }) {
  const day = shootDay(date);
  const sub = aiSlug(subject);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !sub) return { ok: false };
  const mem = shootMemory();
  const at = mem.findIndex((m) => shootDay(m.date) === day);
  const rec = { date: day, subject: sub, ts: Date.now() };
  if (at >= 0) mem[at] = rec; else mem.push(rec);
  // His answer is ground truth and there is one entry per shoot day, so this list stays small
  // (28 days across his whole 310-clip library). No pruning needed, and pruning it would throw away
  // exactly the thing he took the trouble to tell us.
  saveConfig();
  return { ok: true, date: day, subject: sub };
}

function recallShoot(date) {
  const day = shootDay(date);
  const hit = shootMemory().find((m) => shootDay(m.date) === day);
  return hit ? hit.subject : '';
}

ipcMain.handle('ai:rememberShoot', async (_e, p) => rememberShoot(p || {}));
ipcMain.handle('ai:recallShoot', async (_e, date) => ({ ok: true, subject: recallShoot(date) }));

// Which of these shoots do we still not understand?
//
// A shoot needs asking only if we know NOTHING about it: he has not answered it before, and he has
// never named a clip from that day. Everything else is already settled — asking again would be the
// app forgetting, which is the single thing he told us never to do.
ipcMain.handle('ai:shootsToAsk', async (_e, dates) => {
  const lib = currentFinalMeta() || {};
  const namedDays = new Set();
  for (const rec of Object.values(lib)) {
    if (rec && rec.subject) namedDays.add(shootDay(rec.date));
  }
  const out = [];
  const seen = new Set();
  for (const d of (dates || [])) {
    const day = shootDay(d);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || seen.has(day)) continue;
    seen.add(day);
    const known = recallShoot(day);
    if (known) continue;                 // he already told us
    if (namedDays.has(day)) continue;    // he already named clips from it — get_shoot_context has this
    out.push(day);
  }
  return { ok: true, shoots: out };
});

// --- PLACEMENT MEMORY — ask once, then never again --------------------------------------
//
// Jake: "It should be able to figure this out, or it only ever asks it once and then it knows."
//
// That is the whole point, and nothing in the app did it. You'd confirm "these mowing clips go in
// Garden Reno", the clips would be filed, and the DECISION would evaporate — so next month it asked
// again. Worse, when it couldn't identify footage it invented a project rather than ask, because a
// question it would only have to ask once still felt expensive to it.
//
// So: every answer becomes a rule. And a remembered answer does not go to the model AT ALL — it is a
// dictionary lookup, which is instant, free, and has exactly zero variability. The model is then only
// ever consulted about things it has genuinely never seen, which is the only place a model belongs.
function placementMemory() {
  if (!Array.isArray(config.placementMemory)) config.placementMemory = [];
  return config.placementMemory;
}

// Remember where the user filed this kind of footage. Called when they CONFIRM a placement — their
// confirmation is the ground truth, not the model's suggestion.
function rememberPlacement({ date, subject, people, location, path }) {
  const subj = aiSlug(subject || '');
  const dest = String(path || '').trim();
  if (!subj || !dest) return null;
  const day = shootDay(date);

  const mem = placementMemory();
  const ppl = (Array.isArray(people) ? people : []).map((p) => String(p).toLowerCase()).sort();
  const loc = aiSlug(location || '');

  // A decision is about a SHOOT, not a subject. Same day + same subject is the same decision, so it
  // updates in place; a different day is a different shoot and gets its own record, because that is
  // the thing we must be able to tell apart later. (See recallPlacement for why that matters.)
  const existing = mem.find((m) => m.subject === subj && shootDay(m.date) === day
    && JSON.stringify(m.people || []) === JSON.stringify(ppl));
  if (existing) {
    existing.path = dest;
    existing.location = loc || existing.location;
    existing.count = (existing.count || 0) + 1;
    existing.ts = Date.now();
  } else {
    mem.push({ date: day, subject: subj, people: ppl, location: loc, path: dest, count: 1, ts: Date.now() });
  }
  saveConfig();
  return { ok: true, remembered: subj, date: day, path: dest };
}

// UNDO HAS TO ACTUALLY UNDO.
//
// An `exact` recall files a shoot with NO card and NO question (see the review grid), and the Undo
// button on that auto-filed card is the ONLY way the user can ever correct a placement the app got
// wrong. Undo used to clear `g.chosen` — the UI — and leave the memory that caused the auto-file
// sitting in config. So: he undoes it, closes the review, and every future clip from that shoot is
// silently filed into the project he just rejected, forever, with no card and no question. His undo
// was quietly reverted, and the app got MORE confident each time (`count` goes up).
//
// It only ever looked fine because re-picking updates the record in place — the bug needs him to undo
// and NOT immediately choose again, which is exactly what "undo" means.
//
// The identity here must match rememberPlacement's EXACTLY (subject + shoot day + people), or it
// deletes the wrong record — or, worse, nothing at all while reporting success.
function forgetPlacement({ date, subject, people }) {
  const subj = aiSlug(subject || '');
  if (!subj) return { ok: false, removed: 0 };
  const day = shootDay(date);
  const ppl = (Array.isArray(people) ? people : []).map((p) => String(p).toLowerCase()).sort();

  const mem = placementMemory();
  const keep = mem.filter((m) => !(m.subject === subj && shootDay(m.date) === day
    && JSON.stringify(m.people || []) === JSON.stringify(ppl)));
  const removed = mem.length - keep.length;
  if (!removed) return { ok: true, removed: 0 };
  config.placementMemory = keep;
  saveConfig();
  return { ok: true, removed };
}

ipcMain.handle('ai:forgetPlacement', (_e, payload) => {
  try { return forgetPlacement(payload || {}); }
  catch (e) { return { ok: false, removed: 0, error: (e && e.message) || String(e) }; }
});

// Have we been told this before? Deterministic — no model, no prompt, no variability.
//
// Returns a confidence so the caller can decide whether to act silently or still show the user.
// EXACT is "you told me this exact thing"; LIKELY is a strong lexical match on the subject (the same
// prefix matcher that fixed the alpine/alps miss).
// ONLY THE SAME SHOOT IS "EXACT". Everything else is a suggestion he still gets to see.
//
// This used to return `confidence: 'exact'` on a bare SUBJECT match, with no notion of which shoot the
// clips came from — and the review grid auto-files an exact recall with no card and no question. So:
// he files his 2026-06-01 lawn-mowing shoot into `Lawn Care/Josiah`. A month later he mows a different
// property. Subject matches, recall says "exact", and the new shoot is silently filed into Josiah's
// project. He is never asked, and never told.
//
// "Ask once and then it knows" means never re-asking about THE SAME SHOOT. It does not mean answering
// a question he was never asked. A new shoot with a familiar subject is a SUGGESTION ("you filed the
// last lawn-mowing shoot here — same project?") — one click to accept, and he can see it.
function recallPlacement({ date, subject, people, location }) {
  const subj = aiSlug(subject || '');
  if (!subj) return null;
  const mem = placementMemory();
  if (!mem.length) return null;

  const day = shootDay(date);
  const ppl = (Array.isArray(people) ? people : []).map((p) => String(p).toLowerCase());
  const loc = aiSlug(location || '');

  // The same shoot, already decided. This is the only thing that may skip the question.
  // Records written before placement was shoot-aware carry no date; they can never be exact, which is
  // the safe direction — the worst case is that he is asked once more.
  const sameShoot = day && mem.find((m) => m.subject === subj && shootDay(m.date) === day);
  if (sameShoot) {
    return { path: sameShoot.path, confidence: 'exact', told_before: sameShoot.count || 1, date: day, score: 99 };
  }

  let best = null; let bestScore = 0;
  for (const m of mem) {
    let score = 0;
    if (m.subject === subj) score += 10;
    else if (aiTokenMatch(m.subject, subj)) score += 6;
    else continue;                                    // a different subject is a different decision

    const overlap = (m.people || []).filter((p) => ppl.includes(p)).length;
    score += overlap * 2;
    if (loc && m.location && aiTokenMatch(m.location, loc)) score += 2;
    score += Math.min(3, m.count || 1);               // a decision you've confirmed repeatedly is stronger

    if (score > bestScore) { bestScore = score; best = m; }
  }
  if (!best) return null;
  // A different shoot — never 'exact', however familiar it looks.
  return {
    path: best.path,
    confidence: 'likely',
    told_before: best.count || 1,
    from_shoot: shootDay(best.date) || '',
    score: bestScore,
  };
}

// The model gets it as a tool too — so even for footage it must reason about, "where did we put this
// last time?" is a question it can just ask.
defineTool('recall_decision', {
  description: 'Check whether the user has ALREADY told you where this kind of footage goes. Call this FIRST — if they have, use it. Never ask a question you have already been given the answer to.',
  parameters: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      people: { type: 'array', items: { type: 'string' } },
    },
    required: ['subject'],
  },
  run: async ({ subject, people }, ctx) => {
    const hit = recallPlacement({ date: ctx.date || '', subject, people, location: ctx.location || '' });
    if (!hit) return { known: false, note: 'The user has not told you where this kind of footage goes. Search for a project.' };

    // If this were the SAME shoot he has already ruled on, we would never have called the model at all
    // (ai:placeGroup returns that answer directly). So anything the model sees here is a DIFFERENT
    // shoot that merely looks familiar — say so plainly, or it will treat an old job's project as
    // settled fact for a new job.
    if (hit.confidence === 'exact') {
      return { known: true, path: hit.path, confidence: 'exact', times_filed_here: hit.told_before };
    }
    return {
      known: true,
      path: hit.path,
      confidence: 'likely',
      from_a_different_shoot: hit.from_shoot || 'an earlier one',
      times_filed_here: hit.told_before,
      note: 'He filed a DIFFERENT shoot of this kind here. It may be the same ongoing project, or a new '
        + 'job that happens to look the same. If you cannot tell, ask_user — do not assume.',
    };
  },
});

// The renderer calls this when the user CONFIRMS a card. This is the moment the app learns.
ipcMain.handle('ai:rememberPlacement', (_e, payload) => {
  try { return rememberPlacement(payload || {}) || { ok: false }; }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

// And this is asked BEFORE the model, so a known answer costs nothing.
ipcMain.handle('ai:recallPlacement', (_e, payload) => {
  try { return recallPlacement(payload || {}) || { known: false }; }
  catch { return { known: false }; }
});

// --- BOOTSTRAP: learn from the library the user ALREADY has ------------------------------
//
// Jake has 310 correctly-named clips sitting in his Compressed folder, and the app's
// `ai.styleExamples` and `ai.subjects` were BOTH EMPTY. The single best source of truth about how he
// names things — hundreds of examples he wrote himself — was on disk, unread, while the AI invented
// subjects like `car-door` and `skateboarding` for want of knowing that `pov` and `vlog` existed.
//
// This reads it. Not a model in sight: it parses the filenames he already wrote.
//
// It also surfaces the fragmentation he already has (`lawn-mowing` 68 clips AND `lawnmowing` 15) so
// he can merge them — because until he does, BOTH are "existing subjects" and the enum will happily
// keep offering the wrong one.
// His archive is not a clean teacher. Two kinds of poison in it, both found by reading what
// learnFromLibrary actually produced from his real 310 clips:
//
// 1. MARKERS, not subjects. He writes `_delete_` to mean "this clip is junk" — 6 clips, so it sails
//    past the "used at least twice" filter and lands in the ENUM. The model could then legitimately
//    name a clip `delete`. It is a workflow marker, not a thing he films.
//
// 2. THE OLD AI'S OWN GARBAGE. `still-black-squares-grid-static`, `still-still-wooden-fence-small-
//    structures`, `wide-establishing-panning-car-houses` — these sit in his library because the OLD
//    naming pass wrote them. Mining filenames cannot tell HIS names from the AI's bad ones, so it was
//    feeding the old model's mistakes back to the new one as exemplary style. That is the
//    self-confirmation loop again, wearing a different hat.
//
//    set_clip_name is explicitly forbidden from using camera words. An example full of them does not
//    merely fail to teach — it contradicts the instruction, in the one place the model trusts most.
const MARKER_SUBJECTS = new Set(['delete', 'deleted', 'trash', 'junk', 'tmp', 'temp', 'test', 'misc', 'unsorted', 'raw', 'new']);
const CAMERA_WORDS = /(^|-)(still|wide|panning|pan|static|establishing|closeup|close-up|shot|angle|zoom|handheld|tracking|grid|footage|clip|video)(-|$)/;

function learnFromLibrary(dirs) {
  const roots = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
  const subjectCount = new Map();
  const pairs = [];        // "subject / description" — real few-shot examples
  let scanned = 0; let parsed = 0;

  for (const dir of roots) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!VIDEO_EXTS.has(ext) && !IMAGE_EXTS.has(ext)) continue;
      scanned += 1;
      const meta = parseNamedClip(e.name);
      if (!meta || !meta.subject) continue;      // a raw GH016805.mp4 teaches nothing
      parsed += 1;

      const subj = aiSlug(meta.subject);
      if (!subj || MARKER_SUBJECTS.has(subj)) continue;       // `delete` is a marker, not a subject
      subjectCount.set(subj, (subjectCount.get(subj) || 0) + 1);

      const desc = aiSlug(meta.description || '');
      // Never teach what we forbid. A marker description teaches nothing, and one full of camera words
      // is the OLD model's output being laundered back in as if he had written it himself.
      if (!desc || MARKER_SUBJECTS.has(desc) || CAMERA_WORDS.test(desc)) continue;
      pairs.push(`${subj} / ${desc}`);
    }
  }

  // Subjects he ACTUALLY uses, commonest first. A subject used once is probably a typo (his archive
  // has a `vloghead-owenpack-josiahpack-insidehouse` — clearly a mistake), so require it twice.
  const subjects = [...subjectCount.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s);

  // Near-duplicates that are ALREADY splitting the archive (his has `lawn-mowing` 67 and `lawnmowing`
  // 15 — one subject, two folders, forever).
  //
  // Reporting them is not enough. If BOTH stay in the enum the model will keep offering the minority
  // spelling and the split gets worse every run. So the enum gets only the CANONICAL spelling — the
  // one he uses most — which stops the bleeding immediately. The existing files keep their names:
  // renaming 15 of his clips is a destructive act and his call, not a side effect of learning.
  const duplicates = [];
  const collapsed = new Set();
  for (let i = 0; i < subjects.length; i += 1) {
    for (let j = i + 1; j < subjects.length; j += 1) {
      const a = subjects[i]; const b = subjects[j];
      if (collapsed.has(b)) continue;
      if (a.replace(/-/g, '') === b.replace(/-/g, '') || aiTokenMatch(a, b)) {
        // `subjects` is sorted commonest-first, so `a` is always the dominant spelling.
        duplicates.push({ keep: a, merge: b, keepCount: subjectCount.get(a), mergeCount: subjectCount.get(b) });
        collapsed.add(b);
      }
    }
  }
  const canonical = subjects.filter((s) => !collapsed.has(s));

  // Spread the examples across subjects rather than taking the first 60 (which, on his archive, would
  // be 60 clips of `vlog` and teach the model nothing about `pov` or `calisthenics`).
  const bySubject = new Map();
  for (const p of pairs) {
    const s = p.split(' / ')[0];
    if (!bySubject.has(s)) bySubject.set(s, []);
    bySubject.get(s).push(p);
  }
  const examples = [];
  for (let round = 0; round < 12 && examples.length < 60; round += 1) {
    for (const s of canonical) {   // never show the model a duplicate spelling as a good example
      const list = bySubject.get(s);
      if (list && list[round]) examples.push(list[round]);
      if (examples.length >= 60) break;
    }
  }

  return {
    ok: true,
    scanned,
    parsed,
    subjects: canonical,        // what the model may choose from — one spelling per subject
    allSubjects: subjects,      // everything seen, including the duplicates
    counts: Object.fromEntries(subjectCount),
    examples,
    duplicates,                 // for the user to act on: "you have both, want to merge?"
  };
}

// Read the library and SAVE what it learned: the subjects become the enum the model must choose from,
// and the examples become real few-shot pairs. Both were empty; both were sitting on disk.
ipcMain.handle('ai:learnFromLibrary', (_e, dirs) => {
  try {
    const targets = (Array.isArray(dirs) && dirs.length)
      ? dirs
      : [config.finalizeSource, config.intakeFolder, config.projectsRoot].filter(Boolean);
    const r = learnFromLibrary(targets);
    if (!r.parsed) {
      return { ok: false, error: 'No clips there follow your naming scheme yet — name a few by hand first and I can learn from them.' };
    }
    config.ai = config.ai || {};
    config.ai.styleExamples = r.examples;
    // Merge with any subjects already known, rather than replacing — a subject you use but haven't
    // filed yet is still a subject.
    const existing = Array.isArray(config.subjects) ? config.subjects : [];
    config.subjects = [...new Set([...r.subjects, ...existing.map((x) => aiSlug(x)).filter(Boolean)])];
    saveConfig();
    return r;
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

// --- LEARN FROM WHAT HE ACTUALLY CORRECTS -----------------------------------------------
//
// The gap this closes: `styleExamples` was written by exactly two things — learnFromLibrary and
// learnNames — and BOTH mine the archive in bulk and REPLACE the array. When Jake looked at a name
// the AI produced and typed a better one, that pair — the single cleanest signal in the entire
// system, him saying "you wrote X, it is actually Y" — was distilled into an English rule and then
// THROWN AWAY. The one thing he'd expect "it learns from me" to mean was the one thing not kept.
//
// Three things make this work, and each one is a trap if you undo it:
//
// 1. A SEPARATE STORE. Corrections must NOT be appended to `styleExamples`: learnFromLibrary
//    assigns over that array (there is a test pinning "replaced, not appended"), so one click of the
//    health card would silently wipe every correction he had ever made. Mined examples are derived
//    data and can be rebuilt from disk at any time; corrections are the ONLY copy of what he told us.
//
// 2. CORRECTIONS WIN THE SLICE. The few-shot is cut to 12. The mined set holds up to 60, so a
//    correction appended to the end would never once reach the model — stored, and still ignored.
//    They go FIRST.
//
// 3. …BUT ONLY HALF OF IT. If he corrects twelve vlog clips in a row, twelve vlog examples would
//    crowd out every other subject and the model would forget `pov` and `calisthenics` exist —
//    learnFromLibrary deliberately spreads the mined examples ACROSS subjects for exactly that
//    reason. So corrections take at most half the budget; the mined diversity keeps the rest.
const STYLE_CORRECTION_CAP = 40;

function recordStyleCorrection(pair) {
  const subject = aiSlug((pair && pair.subject) || '');
  const description = aiSlug((pair && pair.description) || '');
  if (!subject || !description) return { ok: false };            // half a name teaches half a lesson
  // `_delete_` is his junk MARKER, not a name. It sails past every other filter (see MARKER_SUBJECTS)
  // and would land in the few-shot as though `delete` were a thing he films.
  if (MARKER_SUBJECTS.has(subject) || MARKER_SUBJECTS.has(description)) return { ok: false };
  //
  // NOTE: no CAMERA_WORDS filter here, and that is deliberate — it is the whole reason these are two
  // stores and not one. That filter exists because 18% of the archive's descriptions were written by
  // the OLD AI and mining filenames cannot tell his words from the machine's. Here authorship is not
  // in doubt: he typed it, just now, to correct us. Second-guessing his own correction would make the
  // app disagree with the user about what the user prefers.
  const ai = config.ai || (config.ai = {});
  if (!Array.isArray(ai.styleCorrections)) ai.styleCorrections = [];
  const text = `${subject} / ${description}`;
  const already = ai.styleCorrections.findIndex((c) => c && c.pair === text);
  if (already >= 0) ai.styleCorrections.splice(already, 1);      // re-corrected → it is fresh again
  ai.styleCorrections.push({ pair: text, ts: Date.now() });
  if (ai.styleCorrections.length > STYLE_CORRECTION_CAP) {
    ai.styleCorrections = ai.styleCorrections.slice(-STYLE_CORRECTION_CAP);   // newest wins
  }
  saveConfig();
  return { ok: true, pair: text, count: ai.styleCorrections.length };
}

// THE single owner of the few-shot block. Both prompt sites (get_naming_style, and the legacy
// giant-prompt path in 07) read through this, so they can never drift apart.
function styleFewShot(limit) {
  const ai = config.ai || {};
  const cap = Math.max(1, Number(limit) || 12);
  const corrections = (Array.isArray(ai.styleCorrections) ? ai.styleCorrections : [])
    .slice(-Math.floor(cap / 2))              // most RECENT — his style now beats his style last year
    .reverse()                                // freshest first: it is the one that must survive the cut
    .map((c) => c && c.pair)
    .filter(Boolean);
  const mined = (Array.isArray(ai.styleExamples) ? ai.styleExamples : []);
  return [...new Set([...corrections, ...mined])].slice(0, cap);
}

ipcMain.handle('ai:recordStyleCorrection', (_e, pair) => {
  try { return recordStyleCorrection(pair || {}); }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

// --- AI HEALTH — the things that were silently wrong ------------------------------------
//
// Jake's real config, verbatim:
//   ai.model      = 'llava-llama3'   (measured: hallucinates whole objects)
//   ai.textModel  = ''               (so EVERY text task ran on the vision model, which cannot
//                                     call tools at all)
//   styleExamples = 0                (while 310 correctly-named clips sat on disk, unread)
//   projectsRoot  = ''               (there is NOWHERE to file to — which is the real reason
//                                     "organize sucks", and the app never said so)
//
// Not one of those was surfaced anywhere. The app just quietly did its worst and looked stupid. Each
// of them is detectable, and each has a one-click fix — so say so, and fix it.
// --- VRAM residency: one model at a time, and give it back when done ------------------------
//
// The single-GPU / older-machine rule. See ollamaUseOnly() for why batching alone was not enough.

// Called at the top of each phase of a run: "I am about to use this model, and only this model."
ipcMain.handle('ai:useOnly', async (_e, model) => {
  const m = String(model || '').trim();
  if (!m) return { ok: false, freed: [] };
  return ollamaUseOnly(m);
});

// Called when a run ENDS. Hands the VRAM back rather than sitting on it for Ollama's 5-minute
// keep_alive while the user goes off to edit video.
ipcMain.handle('ai:release', async () => ollamaReleaseAll());

// What's resident right now — so the UI can tell the truth about it instead of guessing.
ipcMain.handle('ai:loaded', async () => ({ ok: true, models: await ollamaLoaded() }));

ipcMain.handle('ai:health', async () => {
  const ai = config.ai || {};
  const problems = [];

  // 1. A reasoning model that can actually call tools.
  const toolModel = await aiToolModel();          // this also auto-picks and persists one if it can
  if (!toolModel) {
    problems.push({
      id: 'no-tool-model',
      severity: 'high',
      title: 'No reasoning model',
      detail: 'Naming and filing need a model that can call tools. A vision model cannot — it just writes prose, which is why the results have been erratic.',
      fix: 'pull',
      fixLabel: 'Get qwen3:8b',
      arg: 'qwen3:8b',
    });
  }

  // 2. A vision model that actually sees what's there.
  let advice = null;
  try { advice = (await visionAdviceInner()) || null; } catch { advice = null; }
  if (advice && advice.kind === 'upgrade') {
    problems.push({
      id: 'weak-vision',
      severity: 'high',
      title: `Switch to ${advice.best}`,
      detail: advice.why,
      fix: 'useVision',
      fixLabel: `Use ${advice.best}`,
      arg: advice.best,
    });
  }

  // 3. It has never read the names you already wrote.
  const styles = (ai.styleExamples || []).length;
  const libs = [config.finalizeSource, config.intakeFolder].filter(Boolean);
  if (!styles && libs.length) {
    problems.push({
      id: 'no-style',
      severity: 'medium',
      title: "It hasn't learned your naming style",
      detail: 'Your Compressed folder is full of clips you named yourself. That is the best possible example of how you want things named, and the AI has never read it.',
      fix: 'learn',
      fixLabel: 'Learn from my clips',
      arg: libs,
    });
  }

  // 3b. It has never read the filing he ALREADY did by hand.
  //
  // `backfillLedgerFromTree` existed, was tested, had an IPC handler and a preload bridge — and no
  // caller at all. Meanwhile his Projects tree holds 1354 clips filed by hand and the ledger reads
  // ZERO, so everything downstream is dead: `ledgerMatch` opens with `if (!ledgerCache.length)
  // return null`, the same-shoot offer never fires, and `search_projects` finds nothing. The answer
  // has been on his disk the whole time next to a one-shot importer with no button.
  let ledgerN = 0;
  try { ledgerN = (config.projectLedger || []).length; } catch { ledgerN = 0; }
  let treeHasFiles = false;
  if (!ledgerN && config.projectsRoot) {
    try { treeHasFiles = fs.readdirSync(config.projectsRoot).length > 0; } catch { treeHasFiles = false; }
  }
  if (!ledgerN && treeHasFiles) {
    problems.push({
      id: 'no-ledger',
      severity: 'medium',
      title: "It doesn't know what you've already filed",
      detail: 'Your Projects folder is full of footage you filed yourself, and the app has never read it. That memory is what makes a new card from the same shoot offer the right project instead of asking again.',
      fix: 'backfillLedger',
      fixLabel: 'Read my Projects folder',
      arg: config.projectsRoot,
    });
  }

  // 4. Nowhere to file to.
  if (!config.projectsRoot) {
    // If the folder we'd guess actually EXISTS, offer it — one click, no file browser. His is
    // `~/Videos/02 - Projects/2026`, already holding `2026 - Client Work` / `- Personal` /
    // `- Social Media`. Making him go and find a folder we could already see is busywork.
    const guess = defaultProjectsRoot();
    let found = false;
    try { found = fs.statSync(guess).isDirectory(); } catch { found = false; }
    problems.push({
      id: 'no-projects-root',
      severity: 'high',
      title: 'No Projects folder set',
      detail: found
        ? `Organize files clips into a Projects tree, and none is set — which is why organizing has never worked. Found one at ${guess}.`
        : 'Organize files clips into a Projects tree — and you have not got one. That is why organizing has never worked: there is nowhere for anything to go.',
      fix: found ? 'useProjects' : 'pickProjects',
      fixLabel: found ? 'Use that folder' : 'Choose a folder',
      arg: found ? guess : '',
    });
  }

  return { ok: true, problems, toolModel, visionModel: ai.model || '' };
});

// Same logic as the ai:visionAdvice handler, callable internally (an ipcMain handler cannot be
// invoked from within the main process).
async function visionAdviceInner() {
  const ai = config.ai || {};
  const current = ai.model || '';
  let installed = [];
  try { installed = await ollamaListModels(); } catch { return null; }
  const vision = [];
  for (const n of installed) {
    // eslint-disable-next-line no-await-in-loop
    if (await ollamaModelVision(n)) vision.push(n);
  }
  if (!vision.length) return null;
  vision.sort((a, b) => visionRankOf(a) - visionRankOf(b));
  const best = vision[0];
  if (!current) return { kind: 'unset', best, installed: vision };
  if (best === current || visionRankOf(best) >= visionRankOf(current)) return null;
  return {
    kind: 'upgrade',
    current,
    best,
    installed: vision,
    why: /^llava/i.test(current)
      ? `${current} invents things that aren't in your footage — on your own clips it called a pickup truck "a person riding a motorcycle". ${best} read the text off a monitor in the same frames.`
      : `${best} is measurably more accurate at describing what is actually in a frame than ${current}.`,
  };
}
