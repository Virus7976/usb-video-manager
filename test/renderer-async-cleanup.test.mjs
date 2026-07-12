// Renderer async-cleanup guards.
//
// THE BUG CLASS: the renderer treated `await window.api.X()` as if it could never reject.
// Every long-running IPC call was written as
//
//     flag = true; btn.disabled = true; off = window.api.onProgress(...)
//     const res = await window.api.doTheThing(...)      // <-- can REJECT
//     off(); flag = false; btn.disabled = false          // <-- skipped on a throw
//
// so one rejection (ffmpeg missing, EPERM, card yanked, Ollama stopped) left the screen
// permanently wedged — button stranded on "Filing…"/"Deleting…", spinner turning forever,
// a guard flag stuck true — AND orphaned a live IPC listener that double-wrote the UI on
// the next run. Before this suite there was not a single `finally` in all of src/mod.
//
// Two layers here:
//   1. STATIC  — the shape can't come back (these run over the real module sources).
//   2. BEHAVIOURAL — the real shipping functions, driven with a REJECTING window.api.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MOD_DIR = join(ROOT, 'src', 'mod');
const modFiles = readdirSync(MOD_DIR).filter((f) => f.endsWith('.js')).sort();
const readMod = (f) => readFileSync(join(MOD_DIR, f), 'utf8');

// --- tiny structural helpers ----------------------------------------------------------

/** Every function body in `src`, as {start,end} spans over the source (brace-matched). */
function functionSpans(src) {
  const spans = [];
  const header = /(?:\basync\s+)?\bfunction\b[^(]*\([^)]*\)\s*\{|\([^()]*\)\s*=>\s*\{|\b[A-Za-z_$][\w$]*\s*=>\s*\{/g;
  let m;
  while ((m = header.exec(src))) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    if (open < 0) continue;
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') { depth -= 1; if (depth === 0) { spans.push({ start: m.index, end: i + 1 }); break; } }
    }
  }
  return spans;
}

/**
 * The function that actually OWNS an await-straddling concern at `idx`: the smallest
 * enclosing function body that itself contains an `await`. (The progress callback passed to
 * a subscription is an inner function with no await — we must not stop there.)
 */
function owningAsyncFn(src, spans, idx) {
  const containing = spans
    .filter((s) => s.start <= idx && idx < s.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start));
  for (const s of containing) {
    const body = src.slice(s.start, s.end);
    if (/\bawait\b/.test(body)) return body;
  }
  return null;
}

const hasFinally = (body) => /\bfinally\s*\{/.test(body);
const usesBusyPrimitive = (body) => /\bwithBusyBtn\s*\(/.test(body);

/** Brace-matched spans of every `try {` / `finally {` block inside `body`. */
function keywordSpans(body, keyword) {
  const spans = [];
  const re = new RegExp(`\\b${keyword}\\s*\\{`, 'g');
  let m;
  while ((m = re.exec(body))) {
    const open = body.indexOf('{', m.index);
    let depth = 0;
    for (let i = open; i < body.length; i += 1) {
      if (body[i] === '{') depth += 1;
      else if (body[i] === '}') { depth -= 1; if (depth === 0) { spans.push({ start: open, end: i + 1 }); break; } }
    }
  }
  return spans;
}

/**
 * The ONE hazard: an `await` that is not inside a `try`.
 *
 * A try/CATCH protects the cleanup that follows it just as well as a try/finally does —
 * either way control reaches the next line. It is only the *unguarded* await that can skip
 * the cleanup entirely, by unwinding straight out of the function. So this is the precise
 * rule, and it is mechanism-agnostic: it does not care whether the button is restored by
 * `disabled = false`, by close(), or by a re-render, because an unwind skips all three.
 */
function unguardedAwaits(body, { from = 0, to = Infinity, ipcOnly = false } = {}) {
  const tries = keywordSpans(body, 'try');
  const re = ipcOnly ? /await\s+window\.api\./g : /\bawait\b/g;
  const out = [];
  let m;
  while ((m = re.exec(body))) {
    if (m.index < from || m.index > to) continue;
    if (tries.some((s) => m.index >= s.start && m.index < s.end)) continue;   // inside a try
    out.push(m.index);
  }
  return out;
}

// --- 1. STATIC GUARDS ------------------------------------------------------------------

test('no unguarded await sits between an IPC subscribe and its release', () => {
  // `off = window.api.onFooProgress(...)` … `await window.api.doFoo()` … `off()`.
  // If that await rejects and is not inside a try, `off()` never runs: the listener stays
  // live and double-writes the progress bar on the next run. Guard the await, or release in
  // a finally (which protects it by construction).
  const offenders = [];
  for (const f of modFiles) {
    const src = readMod(f);
    const spans = functionSpans(src);
    const sub = /([A-Za-z_$][\w$]*)\s*=\s*window\.api\.on[A-Z]\w*\s*\(/g;
    let m;
    while ((m = sub.exec(src))) {
      const body = owningAsyncFn(src, spans, m.index);
      if (!body) continue;                              // not inside an async fn — nothing to skip
      const name = m[1];
      const rel = new RegExp(`\\b${name}\\s*\\(\\s*\\)`);
      // Released in a finally → guaranteed, whatever the awaits do.
      if (keywordSpans(body, 'finally').some((s) => rel.test(body.slice(s.start, s.end)))) continue;
      const at = body.indexOf(m[0]);
      const tail = body.slice(at);
      const relM = tail.match(rel);
      if (!relM) continue;             // released elsewhere (a dialog's close) — not this bug class
      const releaseIdx = at + tail.indexOf(relM[0]);
      if (unguardedAwaits(body, { from: at, to: releaseIdx }).length) {
        offenders.push(`${f}:${src.slice(0, m.index).split('\n').length} (${name})`);
      }
    }
  }
  assert.deepEqual(offenders, [], `unguarded await between subscribe and release:\n  ${offenders.join('\n  ')}`);
});

test('no unguarded IPC await happens while a button is disabled', () => {
  // Whatever restores the button — `disabled = false`, close(), a re-render — an unguarded
  // await that rejects unwinds past ALL of it. That is what stranded buttons on "Filing…",
  // "Deleting…", "Grouping…" and "Loading…" with no way back short of restarting the app.
  // Route through withBusyBtn (the primitive owns the finally) or guard the await yourself.
  const offenders = [];
  for (const f of modFiles) {
    const src = readMod(f);
    const spans = functionSpans(src);
    const dis = /\.disabled\s*=\s*true/g;
    let m;
    while ((m = dis.exec(src))) {
      const body = owningAsyncFn(src, spans, m.index);
      if (!body) continue;
      if (usesBusyPrimitive(body)) continue;            // the primitive owns the restore
      const at = body.indexOf(m[0]);
      if (unguardedAwaits(body, { from: at, ipcOnly: true }).length) {
        offenders.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `button disabled across an unguarded IPC await:\n  ${offenders.join('\n  ')}`);
});

test('the guard itself has teeth — it catches the shape it exists to prevent', () => {
  // A guard that cannot fail is worse than no guard. This is the exact pre-fix shape.
  const bad = `async function runIt() {
    btn.disabled = true;
    const off = window.api.onCompressProgress((p) => {});
    const res = await window.api.compressRun({});
    off(); btn.disabled = false;
  }`;
  const body = owningAsyncFn(bad, functionSpans(bad), bad.indexOf('window.api.onCompressProgress'));
  assert.ok(body, 'the owning async function is found');
  assert.equal(unguardedAwaits(body, { ipcOnly: true }).length, 1, 'the unguarded IPC await IS seen');
  assert.equal(hasFinally(body), false);

  // …and it clears the safe shape: an await inside a try still reaches its cleanup.
  const good = bad.replace(
    'const res = await window.api.compressRun({});',
    'let res; try { res = await window.api.compressRun({}); } catch { res = null; }'
  );
  const goodBody = owningAsyncFn(good, functionSpans(good), good.indexOf('window.api.onCompressProgress'));
  assert.equal(unguardedAwaits(goodBody, { ipcOnly: true }).length, 0, 'a try-guarded await is NOT flagged');
});

test('withBusyBtn exists in the shared core and owns the finally', () => {
  const core = readMod('01-core.js');
  assert.match(core, /async function withBusyBtn\(/, 'the busy-button primitive lives in 01-core');
  const body = owningAsyncFn(core, functionSpans(core), core.indexOf('async function withBusyBtn('));
  assert.ok(hasFinally(body), 'withBusyBtn restores the button in a finally — that IS the primitive');
});

// --- 2. BEHAVIOURAL: run the REAL shipping source against a rejecting window.api ---------

/**
 * Pull real top-level/nested functions out of a module source and run them.
 * `prelude` re-creates the closure variables they capture; `expose` lets a test read those
 * closure variables back out (you cannot see a `let` inside a Function scope otherwise).
 */
function loadFns(relFile, { names, injected = {}, prelude = '', expose = '{}' }) {
  const src = readFileSync(join(ROOT, relFile), 'utf8');
  const pick = (name) => {
    let start = src.indexOf(`async function ${name}(`);
    if (start < 0) start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found in ${relFile}`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error(`unbalanced braces for ${name}`);
  };
  const bodies = names.map(pick).join('\n');
  const argNames = Object.keys(injected);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...argNames, `${prelude}\n${bodies}\nreturn Object.assign({ ${names.join(', ')} }, ${expose});`);
  return factory(...argNames.map((k) => injected[k]));
}

const btnStub = (label = 'Go') => ({ textContent: label, disabled: false });

test('withBusyBtn restores the button when the action REJECTS', async () => {
  const toasts = [];
  const { withBusyBtn } = loadFns('src/mod/01-core.js', {
    names: ['withBusyBtn'],
    injected: { showToast: (m) => toasts.push(m), logIssue: () => {} },
  });
  const btn = btnStub('Apply — file clips');
  const out = await withBusyBtn(btn, 'Filing…', async () => { throw new Error('EPERM'); });

  assert.equal(out, undefined);
  assert.equal(btn.disabled, false, 'button must not be left disabled');
  assert.equal(btn.textContent, 'Apply — file clips', 'label must not be stranded on "Filing…"');
  assert.match(toasts[0] || '', /EPERM/, 'the failure is surfaced, not swallowed');
});

test('withBusyBtn routes the failure to onError when given one, and still restores', async () => {
  const { withBusyBtn } = loadFns('src/mod/01-core.js', {
    names: ['withBusyBtn'], injected: { showToast: () => {}, logIssue: () => {} },
  });
  const btn = btnStub('Try again');
  let seen = null;
  await withBusyBtn(btn, 'Loading…', async () => { throw new Error('no GPU'); }, (msg) => { seen = msg; });
  assert.equal(seen, 'no GPU');
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, 'Try again');
});

test('withBusyBtn passes the value through and restores on the happy path', async () => {
  const { withBusyBtn } = loadFns('src/mod/01-core.js', {
    names: ['withBusyBtn'], injected: { showToast: () => {}, logIssue: () => {} },
  });
  const btn = btnStub('Interpret');
  const seenWhileBusy = {};
  const r = await withBusyBtn(btn, '…', async () => {
    seenWhileBusy.disabled = btn.disabled; seenWhileBusy.label = btn.textContent;
    return { ok: true, rules: [1, 2] };
  });
  assert.deepEqual(seenWhileBusy, { disabled: true, label: '…' }, 'busy state IS applied during the call');
  assert.deepEqual(r, { ok: true, rules: [1, 2] });
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, 'Interpret');
});

test('model pull: a rejecting aiPull unsubscribes and clears the `pulling` latch', async () => {
  // The latch is the real damage: stuck true, every later download was refused with
  // "A download is already running — let it finish" for the rest of the session.
  let unsubCalls = 0;
  const { pull, peek } = loadFns('src/mod/08-people.js', {
    names: ['pull'],
    prelude: 'let pulling = false; let unsub = null;',
    expose: '{ peek: () => ({ pulling, unsub }) }',
    injected: {
      showToast: () => {},
      window: { api: {
        onAiPullProgress: () => () => { unsubCalls += 1; },
        aiPull: async () => { throw new Error('ollama not running'); },
      } },
    },
  });
  const statusEl = { textContent: '', classList: { remove: () => {} } };

  const ok = await pull('llava', statusEl);
  assert.equal(ok, false, 'a failed pull reports failure rather than throwing');
  assert.equal(peek().pulling, false, 'the `pulling` latch is released');
  assert.equal(unsubCalls, 1, 'the progress subscription is released exactly once');
  assert.match(statusEl.textContent, /ollama not running/, 'the reason is shown');

  // And the decisive part: a second pull is still possible.
  const ok2 = await pull('llava', statusEl);
  assert.equal(ok2, false);
  assert.equal(unsubCalls, 2, 'the retry subscribed and released again — the latch never jammed');
});

test('compress: a rejecting compressRun unsubscribes, clears the task and re-arms the dialog', async () => {
  let unsubCalls = 0;
  const cleared = [];
  const els = {
    '#cmpRun': { classList: cls(), disabled: false },
    '#cmpClose': { classList: cls(), disabled: false },
    '#cmpOrganize': { classList: cls(), disabled: false },
    '#cmpCancel': { classList: cls(), textContent: '', disabled: false },
    '#cmpSkip': { checked: false, classList: cls(), disabled: false },
  };
  const inputs = [{ disabled: false }, { disabled: false }];
  const cmpState = { files: [{ n: 1 }], out: 'D:/out', preset: 'x', running: false };
  const toasts = [];

  const { runCompress } = loadFns('src/mod/10-boot.js', {
    names: ['runCompress'],
    prelude: 'let cmpOff = null;',
    injected: {
      selected: () => cmpState.files,
      cmpState,
      $$: (sel) => els[sel],
      ov: { querySelectorAll: () => inputs, querySelector: () => null },
      setTask: () => {}, clearTask: (k) => cleared.push(k),
      showToast: (m) => toasts.push(m), logIssue: () => {},
      escapeHtml: (s) => s, fmtBytes: (n) => `${n}b`,
      window: { api: {
        onCompressProgress: () => () => { unsubCalls += 1; },
        compressRun: async () => { throw new Error('ffmpeg not found'); },
      } },
    },
  });

  await runCompress();

  assert.equal(unsubCalls, 1, 'the progress listener is released — it must not double-write the next run');
  assert.deepEqual(cleared, ['compress'], 'the footer task chip is cleared, not left spinning');
  assert.equal(cmpState.running, false, 'the running latch is released');
  assert.equal(els['#cmpCancel'].classList.has('hidden'), true, 'Cancel is put away');
  assert.equal(els['#cmpClose'].classList.has('hidden'), false, 'Close is offered');
  assert.equal(els['#cmpRun'].classList.has('hidden'), false, 'Run comes back so the compress can be RETRIED');
  assert.equal(inputs.every((i) => i.disabled === false), true, 'the pickers are re-enabled');
  assert.match(toasts.join(' '), /ffmpeg not found/, 'the real reason is surfaced');
});

/** Minimal classList that starts with 'hidden' absent. */
function cls() {
  const s = new Set();
  return { add: (c) => s.add(c), remove: (c) => s.delete(c), contains: (c) => s.has(c), has: (c) => s.has(c) };
}
