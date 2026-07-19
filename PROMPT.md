# PROMPT.md — Standing instructions for autonomous work on this project

> This is the source of truth for every autonomous session (including `/loop`). Read it first.
> Keep it accurate: if the structure, conventions, or priorities drift enough that this file would
> mislead a future session, update it yourself in the same session.

---

## 1. Project summary

**USB / SD Auto-Action** is a Windows Electron desktop app for **one specific videographer (Jake)**.
It is his footage-ingest pipeline: detect a card/phone → **safely copy** footage off it → rename/organize
clips → **AI-analyze** them (local vision model names + describes) → **recognize faces/people** →
compress (ffmpeg) → file into his **projects tree** → back up to NAS → export a DaVinci Resolve CSV →
**delete from the card**. GoPro + iPhone workflows are first-class.

It is a **tool for a tool-user**, not a consumer app. "Done well" for THIS project is specific:

- **His footage is never at risk.** Copies are staged, fsync'd, and verified before anything trusts them;
  the card is never touched until copies provably exist elsewhere. This is non-negotiable and outranks
  every feature.
- **It removes work instead of creating it.** The AI must be trustworthy enough that Jake does *not*
  re-check every clip. If he has to verify everything, the app is net-negative and has failed.
- **The AI decides, it does not author.** Jake's own verdict: *"it shouldn't have to think that much, it
  should just be choosing when to use the tools it's given."* Bounded, checkable decisions (same shoot?
  known face? unsure→ask one question) beat open-ended generation on a 7–8B local model.
- **It leans on the signal that works.** Jake shoots in **batches**: the shoot *date* predicts the subject
  ~88% of the time. Lead with that; let per-clip vision only break ties. (See `usb-app-shoots-in-batches`.)
- **It earns trust before spending it.** The delete-from-source gate is the one irreversible act; it is
  trusted last, after many boring correct runs — never by default.

**North star:** turn it from *a good-looking app that doesn't function properly yet* into *a tool that
disappears into the work*. Reliability and trust over surface area. Do not add features that widen the
surface while the load-bearing core is still shaky.

---

## 2. Parity requirements

**There is no website.** This was checked directly, not assumed: there is no web server, no
`site/`/`web/`/`www/` tree, no Next/Vite/Astro/express config, no Pages/Netlify/Vercel deploy. `src/index.html`
and `src/preview.html` are **Electron renderer pages**, not a site. The `qrcode` + `multicast-dns`
dependencies are for **ADB wireless pairing** (`main-mod/05-windows-phone.js`) — they are not a hosted
surface. If a future session is handed a generic "keep the app and website in parity" instruction, that
instruction has no referent here; the real parity obligations are the internal ones below. **If a web
surface is ever added, rewrite this section rather than leaving both claims standing.**

The internal parity requirements ARE load-bearing and have caused real bugs. Treat these as hard
"build-for-both" rules:

- **Main process ↔ renderer are two halves of every feature.** A functional feature is not done until
  both sides exist and agree. The two bundles are `main.js` (from `main-mod/*.js`) and
  `src/renderer.js` (from `src/mod/*.js`), wired by `preload.js` IPC.
- **Embed preview must equal the actual embed.** The renderer's `clipEmbedKeywords`/metadata preview
  (`src/mod/03-rename.js`) MUST produce exactly what main's `buildEmbedTags` (`main-mod/09-ipc-boot.js`)
  writes — same keywords, same dedup (case-insensitive), same element order. **This has drifted twice.**
  Any change to embedded metadata updates BOTH sides in the same change.
- **The two filing paths must behave identically.** Map "Apply" (`projects:move`, `main-mod/02-media.js`)
  and `finalize:run` (`main-mod/09-ipc-boot.js`) both file footage. They must agree on copy-vs-move,
  folder resolution (`resolveFolderPath`), undo, and never-dump-to-root. A fix to one usually needs the
  other.
- **Photos and videos are equally first-class** through every stage (metadata, staging, organize, delete).
  Photos have historically been second-class; do not regress that.
- **The second-screen preview (`src/preview.html`, standalone, NOT bundled) must stay consistent** with
  the in-app preview behavior (playback policy, tiles). It is deployed as a file — edit it directly.
- **Data-safety invariants apply to ALL stores.** If you harden one store's read/write (accessor +
  `ensureStore` + `saveStore` refuse-if-unloaded guard), apply it to every lazy store, or note why not.

---

## 3. Data-safety rules (what this loop must NEVER do unsupervised)

**What the storage actually is.** There is **no database and no migration system** — checked directly:
no sqlite/postgres/mysql/prisma/drizzle/knex/typeorm/mongo, no `migrations/` folder, no `*.sql`, no schema
files. Persistence is **hand-rolled JSON files**, all under one folder:

```
%APPDATA%\USB SD Auto-Action\        (WSL: /mnt/c/Users/jakeg/AppData/Roaming/USB SD Auto-Action/)
```

That root is **pinned to `process.env.APPDATA` deliberately, NOT `app.getPath('userData')`**
(`main-mod/01-core.js:119-129`) — the Electron path "proved flaky between launch methods (direct exe vs
Start-menu shortcut), so a reopened instance could read a different/empty folder and *forget everything*."
This is also why the e2e harness isolates via `APPDATA`, not `XDG_CONFIG_HOME` (`usb-app-driving-the-gui`).

- **The 10 lazy stores** (`STORE_FILES`, `01-core.js:143-172`): `drafts.json`, `final-meta.json`,
  `versions.json`, `project-ledger.json`, `people.json`, `clip-observations.json`, `faces-pending.json`,
  `face-scenes.json`, `copied-log.json`, `ai-questions.json`. They were split OUT of `config.json`
  precisely to stop write-amplification (face descriptors were ~95% of it).
- **Plus** `config.json` (all settings), and append-only logs that are NOT in `STORE_FILES` and are easy to
  forget: `interaction-log.jsonl` (`06-copy-transfer.js:407`), `feedback.jsonl`
  (`08-finalize-feedback.js:509`), `memory-inbox.jsonl` (`07-naming-organize.js:917`), `app.log`,
  `crash.log`, and the image dirs `faces/`, `feedback-images/`, `poster-cache/`.

Writes go through `writeJsonAtomic` (temp → fsync → rename), with a boot-time sweep of orphaned
`*.tmp` left by crashes (`sweepStoreTemps`, `01-core.js:133-140`). Concurrency safety is the
**single-instance lock** ("one writer per file"), not transactions. That atomicity protects against a
*torn* write; it does **not** protect against a *wrong* write, and there is no history — an overwrite is
gone. Nothing here is backed up by anything.

**There is NO staging environment.** This is the single most important fact in this file.
`npm run release` (`scripts/release.mjs`, documented in `RELEASING.md`) bumps the version, commits, tags,
pushes to **both** Gitea (`origin`) and GitHub (`Virus7976/usb-video-manager`), and publishes a **GitHub
release**. Installed apps then **self-update via `electron-updater` within ~6 hours or on next launch**
(`setupAutoUpdates`, `main-mod/02-media.js`; checks 8 s after launch then every 6 h, packaged Windows only).
**Publishing IS shipping to Jake's working machine.** There is no canary, no ring, no rollback beyond
cutting another release.

**The migration analogue.** Since there's no schema tool, the irreversible-migration equivalent is
**changing the shape of a store that already holds learned state Jake cannot regenerate** — above all
`people.json` (trained face descriptors), `project-ledger.json` (filing history), and `clip-observations.json`.
Re-training faces means re-doing manual work; there is no source to rebuild from. A store-shape change is a
one-way door and must be treated like a destructive migration: **read-compatible with the old shape, or it
does not ship.**

### NEVER, unsupervised — log and defer instead

1. **NEVER run `npm run release`, `electron-builder --publish always`, or otherwise cut/publish a
   release.** That auto-delivers to Jake's machine. Build and test freely (`npm run build:win` uses
   `--publish never`); leave the release for a supervised moment. `npm run release:dry` is safe.
2. **NEVER deploy or restart the app while Jake may be mid-scan/mid-copy.** Interrupting an ingest is
   how footage gets lost. If the deploy state is unclear, defer and note it in `AGENTS.md`.
3. **NEVER weaken or bypass the delete gate** (`verifyCopyPair`, `delete:source`). It hashes whole files
   and **fails CLOSED**. It once fail-opened (`dest === source`) and deleted the only copy — see
   `usb-app-delete-gate`. Card deletes are never automated (Jake's absolute).
4. **NEVER hand-roll a copy of footage.** Route through `stageVerifiedCopy` — see `usb-app-copy-integrity`.
5. **NEVER write a store migration that isn't backward-read-compatible**, and never delete/rewrite a
   store in place without a timestamped sidecar copy first.
6. **NEVER run destructive commands against Jake's real folders** — his intake, Projects tree
   (`C:\...\02 - Projects\2026`), NAS mirror, or `%APPDATA%\USB SD Auto-Action\`. Tests use temp dirs
   (`mkdtempSync`) and an isolated `APPDATA`; keep it that way. Organize **COPIES, never moves**; C: is
   the tight disk (`usb-app-filing-back`).
7. **NEVER `git push` to `main` or to the GitHub mirror unsupervised**, and never force-push. Commit to a
   working branch; leave the merge/push decision to a supervised session.

**Safe backup-before-change for THIS stack** (do this before any store-shape or store-write change):
copy the whole `%APPDATA%\USB SD Auto-Action\` store dir to a timestamped sibling
(`…\USB SD Auto-Action.bak-YYYYMMDD-HHMM\`) before running anything that writes, and state in `AGENTS.md`
where the backup went. From WSL that path is under `/mnt/c/Users/jakeg/AppData/Roaming/`. For code, the
backup is git: commit before a risky refactor so `git diff`/revert is a real option.

**Log-and-defer format.** When a rule above blocks you, do not silently skip it and do not ask. Append to
the `AGENTS.md` in-progress section: *what* you wanted to do, *which rule* stopped you, *what you did
instead*, and the *exact next step* for a supervised session. A deferred item with a specific note is a
good outcome; an unlogged one is a failure.

> **⚠ Mapping for generic loop prompts.** A standing `/loop` prompt may impose rules about **databases,
> migrations, backups, and staging-vs-production**. Translate them; do not go looking for machinery that
> isn't here, and do not treat "no database found" as permission to skip the spirit of the rule:
> - *"never run destructive DB operations without a verified backup"* → **never rewrite/delete a JSON store
>   in `%APPDATA%\USB SD Auto-Action\` without the timestamped folder copy described above.** The stores
>   ARE the database.
> - *"any schema change must be additive/reversible"* → **store-shape changes must stay read-compatible
>   with the old shape.** If it isn't safely reversible, don't apply it — log it as blocked.
> - *"never deploy to production; use staging or a feature branch"* → **there is no staging.** Work on a
>   feature branch and stop there. `npm run release` IS the production deploy and auto-delivers to Jake —
>   this loop never runs it. Building locally (`npm run build:win`, `--publish never`) is fine.
> - *"build the matching version for the website, and vice versa"* → **there is no website** (§2). The
>   binding equivalent is the **main-process ↔ renderer** parity list in §2 — apply the rule there.

---

## 4. State-tracking convention

Three places, all of which you READ at the start and UPDATE before finishing:

1. **`/home/jake/.claude/projects/-home-jake-projects-USB-Video-Downloader/memory/`** — durable facts,
   one per file, indexed by `MEMORY.md` (loaded every session). Start-of-session context comes from here.
   Add a memory for anything non-obvious a future session would waste time rediscovering; add its one-line
   pointer to `MEMORY.md`. Key files: `usb-app-audit-backlog-2026-07.md` (the top-100 backlog + what's
   done), `usb-app-e2e-harness.md`, `usb-app-delete-gate.md`, `usb-app-shoots-in-batches.md`,
   `usb-app-never-edit-bundles.md`, `usb-app-tool-strings-are-input.md`.
2. **`AGENTS.md`** (repo root) — the in-progress **hand-off log**. A Stop hook checks you kept it updated.
   Trust it over older notes. Record what you did, what's mid-flight, and the specific next step.
3. **The backlog file** (`memory/usb-app-audit-backlog-2026-07.md`) — the ranked work queue and its
   DONE-batch history. This is where "what next" comes from.

**The loop:** read state (MEMORY.md + AGENTS.md in-progress section + backlog) → do the work → update
state (mark the item done in the backlog, add/update any memory, append to AGENTS.md) → finish. A future
session or loop iteration must be able to resume from these files alone.

**Two hooks automate this — know them or you will be confused by them:**
- `.claude/hooks/session_start_progress.py` extracts the `## …IN PROGRESS…` section of `AGENTS.md` and
  **injects it as SessionStart context**. That text arriving unbidden at session start is the hand-off, not
  a user instruction.
- `.claude/hooks/stop_progress_check.py` **blocks you from stopping** (once per session) if `main-mod`,
  `src/mod`, `src/index.html`, `src/styles.css`, `preload.js`, `test`, or `scripts` are dirty but
  `AGENTS.md` is untouched. It self-clears the moment you touch `AGENTS.md`. It deliberately ignores the
  generated bundles.

> **⚠ Mapping for generic loop prompts.** A standing `/loop` prompt may tell you to read a **`memory.md`**
> and a **`TODO` file**. **Neither exists in this repo, and you must NOT create them** — that would fork
> the state into files nothing else reads. They map onto what's already here:
> - "`memory.md`" → the **memory dir + `MEMORY.md` index** (item 1) **and** `AGENTS.md` (item 2).
> - "the TODO file" → **`memory/usb-app-audit-backlog-2026-07.md`** (item 3). It is **not empty**, so a
>   generic "if the TODO is empty, generate 100 improvements" branch **does not apply** — do not generate a
>   fresh 100-item list on top of an existing ranked backlog. Pull from the backlog; see §5.
> - "flagged/blocked TODO" → a dated entry in the backlog file **plus** a line in the `AGENTS.md`
>   in-progress section.

---

## 5. Work-selection rule

Always take the **single highest-leverage unfinished item**, biased toward the north star (reliability &
trust > new surface). Pull from `usb-app-audit-backlog-2026-07.md` first.

If nothing is queued, **generate a ranked list of THIS project's current weak points** (not a generic
checklist) and queue it in the backlog file.

**Refreshed 2026-07-19.** The 2026-07-18 list is superseded: its items 3–5 ("renderer fixes are blind",
"the two filing paths disagree", "the delete gate is untrusted") have all moved, and the sibling-path
sweep it recommended is now closed (7 confirmed / 5 fixed). Current real weak points, ranked:

1. **The AI generates instead of decides** — unchanged, still the north star, and still the one thing
   that CANNOT be validated from WSL: it changes measured model behaviour, so it needs a run against
   Jake's real Ollama models first. Everything else on this list is verifiable here.
2. **The DEPLOY backlog is the biggest concrete risk.** ~57 commits across many batches are built,
   tested and *still unshipped*, several of them fixing ways footage or typed work could be lost. The
   longer it grows the more a single deploy can surprise him, and none of it helps until it lands.
   **Deploying (when he is not mid-scan) is worth more than the next fix.**
3. **#92 — the auto-update feed is UNSIGNED.** The highest-severity thing still unfixed. Needs a
   packaged Windows build, so it is not doable from WSL.
4. **Store invariants applied to one store but not its siblings.** This axis is now proven, not
   speculative: it found `renameDrafts` capped in TWO places with OPPOSITE rules, silently deleting
   hand-typed names on every launch (fixed `2b73e2d`). When you find a cap, prune, age filter or
   normalisation on a store, **grep for a second one on the same store before trusting either.**
5. **Write-throughs without their inverse.** Adding persistence to an action obliges you to reverse it
   too — the tagging fix (#26) silently made "Undo" leave a permanent tag until #-untag landed.
6. **The audit list has drifted from the code.** ~1 in 3 entries in both historical lists turned out
   already-done or misdescribed. **Confirm a bug reproduces before fixing it** — a test that goes green
   on the first run is the answer, not a setup problem.
7. **#77 (review faces on already-filed footage)** is still BLOCKED on a design call (which tree holds
   past footage — L: archive or C: projects); `finalMeta` stores no current path. Don't build it blind.
8. **Remaining perf items are mostly NOT worth it** — measure before optimising. `people:match`'s scary
   O(n·m) is 79 ms across a whole scan; the face-frame IPC is 1100px frames (~5 MB at default), and its
   suggested "concurrent detect" fix contradicts the single-GPU rule. Several are logged won't-fix WITH
   numbers; don't re-open on big-O alone.

Prefer items you can **verify** this session over items you can't.

---

## 6. Quality bar (inferred from the codebase)

- **Every fix lands with a regression test.** Fix-mode is standing (`usb-app-fix-mode`). Use
  **reproduce → fix → verify**: write a test that fails on the bug first, then fix, then watch it pass.
- **The runner is plain `node --test`** + `node:assert/strict`. There is no Jest/Mocha/Vitest — do not add
  one. Test media is **generated with ffmpeg at test time** (`test/fixtures.mjs`); no binary fixtures are
  committed, so some tests skip without ffmpeg on PATH.
- **Two test tiers, both must stay green:**
  - `npm test` — fast vm harness (**98 files** in `test/*.test.mjs`, shared `test/harness.mjs`). Loads the
    real `main.js` in a `vm` with a stubbed electron; invoke real IPC handlers with `app.invoke(...)`, read
    internals with `app.get(...)`, materialize vm values with `app.plain(...)` (**required** before
    `deepStrictEqual` — vm values have different prototypes and fail the prototype check otherwise).
    **Verified 2026-07-19: 913 tests, 832 pass, 81 skipped, 0 fail.** That is the baseline — if you
    see failures, they are yours.
  - `npm run test:e2e` — real Playwright+Electron (**20 files**, 81 tests / 80 pass / 1 skipped, opt-in via
    `RUN_E2E=1`, serial via `--test-concurrency=1`). Drives the actual app + faces. Renderer/face changes
    belong here, not "verify on deploy." You **cannot stub `window.api`** (contextBridge props are
    non-writable) — seed store files via `launchApp({ seed: … })` instead. See `test/e2e/README.md` and
    `usb-app-e2e-harness`.
  - `npm run check` = syntax checks + `scripts/check-primitives.mjs` + the fast suite. `npm run test:all`
    = both tiers.
- **⚠ CI does NOT run the tests.** `.gitea/workflows/ci.yml` is `node --check` + `npm ci` + a `config.json`
  JSON parse — nothing more. `release-check.yml` is a post-tag validator and **no act_runner is even
  registered**. A stale committed bundle or a broken test passes CI. **Green CI means almost nothing here —
  run `npm run check` yourself before claiming done.**
- **A distinctive local idiom: static-analysis tests over module source.** Several tests read `src/mod/*.js`
  as *text* and brace-match to prove a convention can't regress (`renderer-async-cleanup.test.mjs`,
  `ipc-reachability.test.mjs`, `preload-sandbox.test.mjs`, `ai-naming-guard.test.mjs`). If one trips, **fix
  the code — do not loosen the rule.**
- **Error handling pattern:** IPC awaits can reject — cleanup must be in `finally` / `withBusyBtn`, never
  happy-path-only (`usb-app-async-cleanup-rule`). Stores are written atomically (`.part`/`.tmp` → rename,
  dir-fsync). Logging must never throw. The main process has a global crash net → `userData/crash.log`.
- **Security/safety concerns that matter HERE** (this is a footage tool, not a static site):
  - **Never weaken the delete gate** (`verifyCopyPair`, `delete:source`). It hashes whole files and fails
    CLOSED. It once fail-opened (`dest===source`) and deleted the only copy — see `usb-app-delete-gate`.
  - **Never hand-roll a copy of the footage.** Route through the staged/verified copy path
    (`stageVerifiedCopy`) — see `usb-app-copy-integrity`.
  - Organize **COPIES, never moves** onto his PC; C: is the tight disk (`usb-app-filing-back`).
  - `webSecurity:false` renderer: rendered filenames / AI text are untrusted — escape on the way into the
    DOM; the guarded `delete:source` shows the right pattern for fs/shell IPC.
- **Style:** match the surrounding code — this codebase has **dense "why" comments** explaining the bug each
  line prevents. Keep that. Keep IPC channel names and AI tool/result strings byte-stable (see §8).

---

## 7. Session-sizing rule

**Build things completely.** A feature is done when both main + renderer exist, it's tested (vm and/or
e2e), and state files are updated — not when the happy path compiles. Do not leave half-built code.

If a task is too big for one session, **split at a clean, shippable boundary** (e.g. "main-side IPC +
tests this session; renderer wiring next") and leave a **specific, actionable** note in `AGENTS.md`
in-progress section: what's done, what's next, which files, which test to write. A clean sub-slice that's
tested and green beats a whole feature that's half-wired.

---

## 8. Autonomy rule

**Never stop to ask clarifying questions.** Make the reasonable call, **log the assumption** in `AGENTS.md`
(and a memory if it's durable), and keep going.

The ONE hard exception is not "ask" — it's "**don't ship blind**": for changes to the **copy/delete/store
data-safety paths** or the **measured AI prompt/tool strings**, the reasonable call is to **write the
reproduction/verification test FIRST** (the e2e harness makes almost everything verifiable now). If it
genuinely can't be verified this session, **defer it with a specific logged note** — never ship an
unverified change to those paths. Everything else: decide, log, proceed.

---

## 8b. How to FIND work here (the techniques that actually produced bugs)

Written after a long session in which the ranked backlog turned out ~1-in-3 already-fixed. These are
ordered by what actually yielded confirmed, user-visible bugs.

1. **THE SIBLING-PATH SWEEP — by far the highest yield.** Look for a guard, validation, fallback or
   normalisation present on ONE path and absent on its TWIN. It found 7 confirmed gaps in one pass,
   five of them real enough to fix, three touching footage:
   - the phone import routed photos to Photos Temp; the card import dumped them in the Tdarr intake
   - `phone:copyVideos` versioned a name collision; `phone:distribute` **overwrote a different photo**
   - MTP verified a pull against source size; ADB accepted `size > 0`
   - `finalize:run` refused to move off a card and preflighted free space; `projects:move` did neither
   - the legacy analyze loop checked "card yanked"; all three batch loops did not
   **The natural twins:** card/SD vs phone import · the two filing paths · video vs photo · tag/untag,
   do/undo, save/delete · single-clip vs batch AI · main-side vs renderer-side validation of the same
   value · first-run vs resume · happy path vs retry · create vs update.
2. **Ask whether a "retry later" branch is really "never".** `#69`'s embed failure said "leave it for
   a clean retry" — but every real instance (HEIC, odd codec, read-only) fails identically forever, so
   the clip could never be filed.
3. **Check which path is the DEFAULT.** `cardIsGone()` existed, but only on the fallback loop, and
   `batched = multiPass || toolModelReady` makes the other one default — the guard was unreachable.
4. **Grep for RAW accesses, not just the accessor.** When migrating a key, `isScanned` looked up draft
   keys directly and would have silently re-scanned every clip.

**And the counter-rule: an "obvious consistency fix" that changes ACCURACY is not obvious.**
`people:reassignFace` dedups at `0.2` where its sibling uses `FACE_DEDUP_T` (0.35). That is a
behaviour change to face matching, not a rename — it would enrol fewer faces and shift matching from
then on. **Measure against real face data or leave it.** Same class as the AI tool strings.

---

## 8c. Testing traps in THIS repo (each of these cost real time)

- **A NEGATIVE source-shape assertion cannot detect a break that doesn't restore the old text.** A
  test asserting "the old sort expression is absent from the source" stayed **green** when the rule it
  guarded was disabled with `if (false)` — the old text never came back, so the assertion held while
  the behaviour was gone. If the code under test runs at **load** time (the boot slim in `01-core.js`
  is top-level bundle code), seed the store on disk and boot it via `loadMain({ userData })`, then
  assert on the resulting state. Behavioural beats structural whenever it is reachable.
- **`Function.prototype.toString()` INCLUDES COMMENTS.** A test asserting the word "smooth" was gone
  failed against correct code because the comment explaining the fix said "smooth". Match the CALL.
- **A leaked test Electron breaks every later e2e run, and the error lies.** A killed run leaves a
  process holding the single-instance lock on `~/.config/USB SD Auto-Action`; every later launch then
  reports `electron.launch: Target page, context or browser has been closed`, which reads like a
  renderer crash **and fails identically at every commit**, defeating "check the previous commit".
  Always run `pgrep -af 'node_modules/electron/dist/electron' | grep -v 'pgrep\|zsh -c'` FIRST.
- **A test can pass for the wrong reason.** A `copied:forget` case went green while forget did nothing,
  because a broken `get` missed the legacy record too — empty for two different reasons is
  indistinguishable. **Assert through the path that ISN'T under test.**
- **A guard you haven't broken is not a guard.** A leftover-site check that inspected three named
  functions missed a reintroduced lookup in a fourth. Scan the SOURCE, then break the code and watch
  it fail.
- **Existing tests assert the code SHAPE, not the property.** 14 broke on renames this session while
  behaviour was unchanged. Rewrite them to assert the property.
- **Source-extracting vm tests inject deps BY NAME** (`analyze-resume`, `ai-analyze-tools` — some
  positionally via a `DEPS` array). Rename a renderer accessor and they fail **while e2e stays green**.
  Grep `test/` for any name you rename.
- **Testing a Windows-gated guard from WSL:** stub the helper in the vm —
  `app.get('fnName = function () { return Promise.resolve(true); }')`, since hoisted function
  declarations are assignable — and assert **the call is made and obeyed**, not that hardware existed.
- Confirm a FUNCTION NAME before asserting against its source: `String(wrongName)` yields `''` and
  every assertion fails at once, which looks like a real bug.
- Use a GENEROUS window when asserting one call follows another — the explanatory comments here are
  long enough to push the call past a 700-char slice.
- `copy:start` LOWER-CASES the extension (`destNameFor`), so assert on
  `path.dirname(r.copied[i].destPath)`, never a guessed filename.
- vm store handlers MERGE, so give each test distinct fixture keys or one inherits another's state.

---

## 9. Unusual things about this project (a generic prompt wouldn't know)

- **NEVER edit `main.js` or `src/renderer.js`** — they are generated. Edit `main-mod/*.js` (main) and
  `src/mod/*.js` (renderer), then `node scripts/bundle.mjs` (also runs via `pretest`/`prestart`/`precheck`).
  `src/preview.html` IS hand-edited (not bundled). See `usb-app-never-edit-bundles`.
  An edit made directly to a bundle is **silently destroyed** by the next `npm test`/`start`/`check`/`dist`.
- **The "bundler" is literal concatenation** (`scripts/bundle.mjs`), joined with **no separator** in
  **lexicographic filename order** — hence the `01-`…`10-` prefixes. Consequences: every module must **end
  with a newline**; load order is filename order (renaming a file reorders the program); and the whole point
  is that top-level `const`/`let` share **one scope** across modules — which is also what both test
  harnesses exploit. Don't convert these to ES modules or `require()`.
  **The scope is shared but not order-free:** a `function` declaration hoists across the whole bundle,
  a `const` does **not**. Top-level code in `01-core.js` referencing a `const` declared in
  `08-…` throws a temporal-dead-zone `ReferenceError` **at boot**. Declare shared constants in the
  earliest module that uses them (this is why `DRAFTS_CAP` lives in `01-core.js`).
- **An in-memory "slim" of a loaded store is a disk write deferred, not avoided.** The boot slim's own
  comment said "No write here" and was materially misleading: `renameDrafts` is not in `LAZY_STORES`,
  so `loadStores()` had already read `drafts.json`, and `freshStore()` won't re-read a file whose
  mtime/size match our own last write — so the truncated map is exactly what the next `drafts:save`
  persists. **A comment claiming nothing reaches disk does not say who persists the value next; trace
  it.** See `usb-app-store-caps`.
- **`scripts/check-primitives.mjs` enforces "one primitive owns each cross-cutting concern"**: no bare
  `spawn` (use `runCapture`/`streamSpawn`/`killAfter`), no bare `copyFile` (use `copyFileVerified`/
  `moveFileCrossDevice`), no bare `mkdir` (use `ensureDir`). Rationale is in `DEDUP.md`.
  `primitives-baseline.json` is a **per-line fingerprint map, not a count** — so a genuinely new bypass
  fails even if an old one was removed in the same commit. Only run `--update-baseline` when you have
  deliberately grandfathered something. **Note it scans `main-mod/` ONLY** — the renderer has no such guard,
  so renderer-side duplication needs your own eyes.
- **Two UI conventions that are easy to violate:** (1) **motion is restrained** — 120–200 ms, `ease`, no
  bounce/overshoot/glow/shimmer/confetti, and the `@media (prefers-reduced-motion: reduce)` block must keep
  covering any new looping animation; don't reintroduce "delight" flourishes. (2) **never stack
  `backdrop-filter` over `backdrop-filter`** — the inner surface goes **invisible on some GPUs**, and this
  is invisible to headless render tests.
- **Tool/result strings and AI prompts are MEASURED INPUT, not decoration.** A cosmetic rename of one tool
  *result* string cost 20 points of subject accuracy, deterministically. Do not "tidy" prompts or tool
  strings without re-measuring against Jake's real Ollama models. See `usb-app-tool-strings-are-input`.
- **Ollama is the runtime** (qwen2.5vl:7b vision + qwen3:8b tool/reasoning). "Use Qwen not Ollama" is a
  mental-model gap — Ollama serves Qwen. **One 6 GB GPU → one model resident at a time**; batch, evict at
  phase boundaries. See `usb-app-single-gpu-rule`, `usb-app-ollama-is-the-runtime`.
- **Dev/test environment is WSL2 Linux against a Windows-targeted app.** `electron`, `ffmpeg`, and
  `powershell.exe` work; **`adb`/MTP do NOT** — phone-COM paths are untestable here, so verify their logic
  by unit-testing the parse/branch, not by driving a device. See `usb-app-test-environment`.
- **The real GUI is drivable from WSL** (Playwright + WSLg). Traps: delete `ELECTRON_RUN_AS_NODE` (leaks via
  WSLENV → no window); isolate/seed stores via **`APPDATA`** temp dir (NOT `XDG_CONFIG_HOME`); faces need
  `--use-gl=angle --use-angle=swiftshader` (tfjs needs real WebGL; `--disable-gpu` → uninitialised wasm
  backend). See `usb-app-e2e-harness`, `usb-app-driving-the-gui`.
- **Card deletes are never automated** and **AI analyze must always resume** (Jake's two absolutes,
  `usb-app-jake-workflow`).
- **Shipping is now a real release pipeline, not a folder copy.** *(This changed — older notes and any
  memory saying "deploy is a folder copy" are STALE.)* Code lives on **Gitea** (`origin`); the installer and
  auto-update feed live on **GitHub** (`Virus7976/usb-video-manager`) because Gitea can't host the ~130 MB
  asset (413 / 100 MB cap). `npm run release` (`scripts/release.mjs`, runbook in `RELEASING.md`) does:
  preflight → `npm run check` → bump + changelog → commit + tag → push to **both** remotes → build →
  publish the GitHub release → verify `.exe`/`.blockmap`/`latest.yml`. **Installed apps then self-update
  within ~6 h** (`setupAutoUpdates`, `main-mod/02-media.js`; 8 s after boot then every 6 h, packaged-Windows
  only). **See §3 — an autonomous session must NEVER run this.** `npm run release:dry` and
  `npm run build:win` (`--publish never`) are the safe local equivalents.
- **The installer must be built on Windows.** electron-builder needs Windows to stamp the `.exe`; WSL/Linux
  can edit and test but cannot produce a faithful installer. CI is a **backstop, not a builder** —
  `.gitea/workflows/release-check.yml` only validates a tag after the fact (and no act_runner is registered
  yet); `ci.yml` is syntax + JSON validation only. Neither runs the test suite. **Green CI means very
  little here — run `npm run check` yourself.**
- **You CAN build and install locally from WSL** — this is the safe middle ground between "held from
  deploy" and a real release. Bundle in WSL, copy `main.js` / `src/renderer.js` / `src/` /
  `package.json` to the Windows checkout at
  `C:\Users\jakeg\Downloads\skool-downloader-chrome\usb-auto-action`, then run
  `npx electron-builder --win --publish never` **directly** (that checkout predates the `main-mod/`
  split, so `npm run build:win` dies on its missing `prebuild:win` hook). Install with `/S`.
  **Check the app isn't running first** — never replace it mid-scan. This publishes nothing.
- **Verifying a build: use `grep -ac`, not `grep -c`.** grep treats `app.asar` as binary and reports
  `0` matches for a marker that is present — which makes a correct build look stale. Cost real
  confusion once; don't repeat it.
- **A manual folder deploy into `…\resources\app\` is possible but discouraged** — it **silently
  shadows `app.asar`**, so a later correct build appears to do nothing. As of 2026-07-19 no such
  folder exists and the asar is authoritative; keep it that way. Check `AGENTS.md` §7a for the
  current deploy state.
- **The app runs headless/windowless in production** (tray) — `console.*` goes to `userData/app.log` now.
- Real exiftool for verification lives at the vendored
  `.../usb-auto-action/node_modules/exiftool-vendored.exe/bin/exiftool.exe` (via `powershell.exe`).

---

_Last reviewed: **2026-07-19** (end of a long autonomous session)._

_Earlier passes added §3 (data-safety / no-staging / release-is-production) and renumbered §4–§9;
corrected §9's deploy notes (**"deploy is a folder copy" was stale** — there is a real
`npm run release` → GitHub → `electron-updater` pipeline); recorded that **CI does not run tests**;
documented the two `.claude/hooks/`; added mappings so a generic `/loop` prompt's website / database /
staging / `memory.md` / TODO-file assumptions resolve to what exists here; and added §8b (how to find
work) and §8c (testing traps)._

_This pass re-verified every figure in the file against the repo rather than carrying it forward:
test tiers are **98 vm files → 913 tests / 832 pass / 81 skipped / 0 fail** and **20 e2e files →
81 tests / 80 pass / 1 skipped**; **57 commits** are undeployed. It refreshed the §5 ranked weak
points (the 2026-07-18 list was superseded — the sibling-path sweep it recommended is closed), added
the store-invariant axis that has since proven itself, added two new §8c traps (negative source-shape
assertions; behavioural-over-structural for load-time code) and the §9 bundling TDZ rule, and
**fixed the known doc-bug it used to merely document** — the updater comment in `main-mod/02-media.js`
claimed a generic Gitea feed where `build.publish` is the github provider, so that entry is retired._

_**Current state:** `#8` (the `clipKey` collision) is complete across **five** stores (drafts,
observations, face clipKeys, copiedLog, aiQueue) and is **rewrite-free by design — do not add a
cleanup pass**. The sibling-path sweep (7 confirmed / 5 fixed), the three-axis sweep (3/3) and the
store-invariant sweep are all closed; the re-audited backlog and the also-rans are worked through.
What remains needs Jake's Ollama models, his Windows machine, a phone, or a labelled face fixture.
**~57 commits are green and undeployed** — check `AGENTS.md` §7a for the current deploy state before
assuming anything is live._

_If you changed bundling, the store engine, the AI tool protocol, the test harness, or the release
process, re-read this file and update the affected sections before you finish._
