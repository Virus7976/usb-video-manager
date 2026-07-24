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
%APPDATA%\USB SD Auto-Action\        (WSL: /mnt/c/Users/<you>/AppData/Roaming/USB SD Auto-Action/)
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
where the backup went. From WSL that path is under `/mnt/c/Users/<you>/AppData/Roaming/`. For code, the
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
2. **The DEPLOY backlog is the biggest concrete risk.** ~81 commits across many batches are built,
   tested and *still unshipped*, several of them fixing ways footage or typed work could be lost. The
   longer it grows the more a single deploy can surprise him, and none of it helps until it lands.
   **Deploying (when he is not mid-scan) is worth more than the next fix.**
3. **#92 — the auto-update feed is unsigned.** ⚠ **RE-ASSESSED 2026-07-20 — this entry was wrong in
   two ways, and the correction matters because the old wording invited a panic fix.**

   *"Not doable from WSL" is false.* Packaged Windows installers build fine from here via
   `powershell.exe npx electron-builder --win`; that has been done repeatedly this session.

   *"Highest-severity" overstates it.* The integrity chain is NOT absent. `latest.yml` (verified on a
   real build) carries a sha512 for the installer, electron-updater checks the download against it,
   and the manifest itself comes over HTTPS from GitHub. So tampering **in transit** is already
   covered. What is genuinely missing is **code signing**, and its two real consequences are:
   - anyone who can publish to the `Virus7976/usb-video-manager` releases can push an update that
     **auto-installs** on his machine (`autoDownload = true`, `autoInstallOnAppQuit = true`), so the
     security of the whole update path reduces to the security of that GitHub account; and
   - Windows SmartScreen warns on every install, and there is no cryptographic proof a build is his.

   **This is not a code fix.** A certificate costs money and is his call; 2FA on that account is his
   action. The one thing that IS a code decision — whether updates should auto-install at all, or
   wait for an explicit click — is recorded as **Q8** in QUESTIONS.md. Do not "fix" this unprompted.
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
  - `npm test` — fast vm harness (**119 files** in `test/*.test.mjs`, shared `test/harness.mjs`). Loads the
    real `main.js` in a `vm` with a stubbed electron; invoke real IPC handlers with `app.invoke(...)`, read
    internals with `app.get(...)`, materialize vm values with `app.plain(...)` (**required** before
    `deepStrictEqual` — vm values have different prototypes and fail the prototype check otherwise).
    **Verified 2026-07-19 (end of session): 1045 tests, 952 pass, 93 skipped, 0 fail.** That is the baseline — if you
    see failures, they are yours.
  - `npm run test:e2e` — real Playwright+Electron (**22 files**, 93 tests / 92 pass / 1 skipped, opt-in via
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

### ⚠ LOOP SIZE (Jake, 2026-07-20): EACH LOOP MUST BE BIG

> *"make each loop way bigger. you should be anylizing the app for the 100 biggest things and do big
> fixes or a lot of small fixes in 1 loop."*

One iteration = a broad ANALYSIS plus a large batch of work. Not one finding, one fix, one deploy.

- **Fan out with subagents.** Audit several subsystems in parallel (they are cheap and they read code
  I would otherwise read serially), then act on everything worth acting on in the same turn.
- **Batch the fixes.** Many small fixes, or one large one plus its fallout, before building/deploying.
- **One build+deploy per loop, at the end**, not per fix.
- **Still non-negotiable, and the reason the batch must not get sloppy:** every behaviour change lands
  with a test, and every test is proved by BREAKING it. A big batch multiplies the cost of a silent
  regression, so the discipline tightens as the batch grows — it does not relax.
- Changes to the copy/delete/filing paths still ship with their verification (§3, §8b) or not at all.


### ⚠ STANDING ORDER (Jake, 2026-07-20) — NEVER STOP, NEVER ASK

> *"make it so that until I message you you never stop and never ask a question. save all questions to
> a file and when I message you again ask them all. if you hit a legitimate road block you absolutely
> can't overcome even after many tries, note it and give me some options in a question after I ask you
> for them. until then operate following the rules on prompt.md and not stopping"*

Concretely, and without exception until he messages again:

1. **Never call AskUserQuestion.** Not for layout decisions, not for data-changing calls, not for
   anything. This supersedes every earlier "ask him first" note in this file — those now mean
   *"write it to `QUESTIONS.md` and pick the safest reversible option."*
2. **Every question goes to `QUESTIONS.md`**, in the format that file defines: what the question is,
   why it needs him, what I did in the meantime, and how to undo it. When he next messages, ask them
   all at once.
3. **Never end a turn without re-arming the loop.** A finished iteration is not a finished session.
4. **A blocker is not a stopping point.** Try many angles first. If it is genuinely insurmountable,
   log it in `QUESTIONS.md` **with concrete options** and *move to the next item* — do not idle on it
   and do not surface it until he asks.
5. **The data-safety rules in §3 still bind absolutely.** "Never stop" is not permission to touch the
   delete gate, hand-roll a copy of the footage, or run a destructive command against his real
   folders. When a task needs one of those, the answer is the safest reversible action plus a
   `QUESTIONS.md` entry — never a shortcut.

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

5. **⚠ ROUND-TRIP PROBING — the 2026-07-20 session's highest-yield technique, and the only one that
   found bugs reading could not.** Do the thing, then go and LOOK at the result through the app's own
   next step. `file → rescan`, `file → undo → list the tree`, `save → relaunch`. It found:
   - the filed badge naming a folder that **did not exist** (two writers, each correct alone, quietly
     disagreeing — the ledger kept the requested spelling while the summary reported the resolved one);
   - undo leaving empty dated folders standing, which the folder-reuse rule would later treat as real
     shoots.
   **Why it beats inspection:** a two-writer disagreement is invisible in either writer. You cannot
   read your way to it. Run it, then ask the app what it thinks happened, and compare that to the disk.
6. **Ask what the screen says when the run achieved NOTHING.** A green "Done" over `moved: 0` sent him
   away believing the job was finished — with Organize unticked there was not even a zero on screen to
   notice, because the stat chips are built per-option.
7. **Follow the data to where it is CONSUMED, not just written.** `shootMemory` read 0 for months: the
   question that fills it was gated on a flag latched inside an unrelated *render* (a race), and its
   only call site was the card flow, so the Organize path never asked at all.

8. **⚠ A CHANGE TO THE DESTINATION LADDER SHIPS WITH THE TWO-RUN REAL-DATA PROBE, or not at all.**
   Stage his real FILENAMES as empty files in a temp dir (no footage touched), load his real
   `ai.routes`, file them into a temp tree — **twice** — and check: run 2 moved 0, the folder counts
   are sane, and nothing crossed between projects. That probe caught a bug 8 unit tests missed, and
   the failure only appeared on the SECOND run because filing writes the ledger that the next run
   reads. `test/filing-is-idempotent-on-a-real-day.test.mjs` now encodes it, but run the probe too —
   his real card has shapes no fixture has thought of yet.

**And the counter-rule: an "obvious consistency fix" that changes ACCURACY is not obvious.**
`people:reassignFace` dedups at `0.2` where its sibling uses `FACE_DEDUP_T` (0.35). That is a
behaviour change to face matching, not a rename — it would enrol fewer faces and shift matching from
then on. **Measure against real face data or leave it.** Same class as the AI tool strings.

---

## 8b-2. ⚠ THE SIX WAYS A GREEN TEST LIED (2026-07-20 — all found by breaking, none by reading)

A passing test is a claim, not evidence. Every one of these passed while proving nothing:

1. **The fixture could not fail the way the guard prevents.** A case-sensitivity test whose every
   fixture name was lowercase; a NAS-copy guard exercised only against an empty NAS folder; a
   sampled-vs-full hash test whose files differed in a byte sampling actually reads. **The fixture has
   to be able to FAIL.**
2. **The code under test overwrote the fixture's input.** `writeDrafts` stamps `ts: now` on every
   incoming draft, so a draft cannot be old on the call that saves it — the age filter never ran. Seed
   the store directly and trigger the prune with an unrelated save.
3. **A tie-break test where every other ordering already pointed the right way.** Pending records got
   the newest timestamps and survived the cap on timestamp alone; deleting the rule under test changed
   nothing. **Make every other signal point the WRONG way.**
4. **The assertion named an expression instead of an outcome.** Four tests broke on correct
   improvements because they pinned a literal call or `if (...) return;`. Assert the behaviour.
5. **A negative assertion on a collapsed slice.** `slice(indexOf(x))` with a missing anchor returns the
   LAST CHARACTER, so every `doesNotMatch` on it passes forever. Now enforced by
   `test/assertions-cannot-pass-vacuously.test.mjs`. **A length check does NOT guard this** — the
   collapsed slice is one character long. Assert the INDEX resolved.
6. **The break itself did nothing.** Patching an initial value that the real code immediately
   overwrites changes no behaviour, so nothing failing proves nothing. **When a break comes back green,
   check the patch actually altered behaviour before blaming the test.**

7. **⚠ THE FIXTURE COULD NOT REPRODUCE THE REAL FAILURE — and I did not know how reality failed until
   I forced it to.** I shipped a filing rung with 8 green tests, including one asserting a same-date
   clip "with nothing in common" is not pulled in. Real days are not like that. On a day he shot a
   lawn job AND a vlog, a personal vlog was filed into a **client project**. The bridge was a single
   clip — `_vlog_dennis-lawn-tour` — whose DESCRIPTION matched his lawn rule, so it routed into the
   client project and taught the ledger that the project contains the subject "vlog". My fixture had
   the two shoots but **not the clip that connects them**, and one filename was the whole difference
   between proving something and proving nothing.
8. **A regression test that does not catch its own regression is worse than none** — it certifies the
   bug as fixed. My first version of the idempotence test passed with the reverted bug re-applied.
   **Always re-apply a reverted bug and watch its regression test fail** before trusting it.

**And when two guards overlap, break them separately AND together.** In the undo cleanup, removing
either the empties check or the non-recursive `rmdir` was still safe; removing both was not. "One
break didn't fail" is not evidence that a guard is redundant.

---

## 8d. ⚠ THE STANDING BACKLOG — six-agent parallel audit, 2026-07-20

Six read-only subagents audited copy/delete, AI/faces, renderer state, dead paths, stores, and UI
honesty in parallel. **Fixing one loop's worth per loop; pull the next from here rather than starting
a fresh hunt.** Items struck through are done and have a test. Everything below was traced to a line,
not guessed — but re-verify before fixing, because three earlier "traced" findings turned out to be
overstated once I read the surrounding code.

### Done this loop (2026-07-20, commit 93141b6)
- ~~Organize map: manual placements destroyed on rebuild, and Run filed to the auto plan~~
- ~~Phone pull: a successfully pulled photo deleted when two share a filename (+ merge/retry twins)~~
- ~~`draftIsNamed` blind to face tags → 200 of his drafts prunable~~
- ~~`people:merge` capped at 60 vs 80 everywhere else~~
- ~~`collectClipFaces` missing the `m.ignored` guard its twin has~~
- ~~Cancelled analyze discarded its clusters while clips stayed marked scanned~~
- ~~Phone entry: list built after questions restored; `updateBatchBar` never called~~
- ~~"AI auto-enhance complete ✓" and "Filed N …✓" claimed success over total failure~~

### Data safety — ALL CLOSED as of 2026-07-20 (be78a87, 947b261)

Items 1-4, 9 and 10 of the original list are done, each with a test proved by breaking it. Kept here
only so a future session doesn't "rediscover" them and assume they're open:

- `_serializePending` pruning resolved clusters against an untrustworthy scene list → now keeps when
  in doubt, plus a `stores:readFailures` bridge so a corrupt store is distinguishable from an empty
  one (main returns the empty DEFAULT for a corrupt file, so the IPC succeeds and the renderer
  couldn't tell — that was the subtle half).
- `gcFaceCrops` missing the fourth reference store (`config.ai.ignored` lives in config.json, not a
  sidecar, so `storeReadFailed` never covered it).
- `clipObs` cap sorting undated records to epoch (evicted for predating a field, not for being old)
  and having no unconsumed-work exemption — the only cap in the app without one.
- Group shots keyed with legacy `clipKey` while their clusters used `clipKeyV2` — the store the #8
  migration missed. Writes are V2 now; reads stay cross-form via `sceneKeyMatches`, because exact
  V2 matching would push a SECOND record for a clip that still has a legacy-keyed scene.
- A face engine failing mid-run marking clips permanently scanned (`ready:false` carries neither
  error flag). Fixed on BOTH scan paths.
- Descriptors per pending cluster uncapped — 14 MB, one cluster at 318, capped to 80 on save and
  load to match what enrolment already truncates to.


### ⚠ UI AUDIT — 2026-07-20, his explicit ask ("the navigation is all over the place, buttons are all
over the place, nothing is up to date"). 15 findings, ranked. NOT yet fixed.

Highest-value first; the top five are things that actively mislead:

1. **Three names for one step.** The home card advertises compress as "ffmpeg (H.264/H.265)"
   (`src/index.html:100`) but the screen opens in Tdarr/watch-folder mode by default
   (`10-boot.js:11,17`), and the Done screen calls it "HandBrake / Resolve" (`index.html:271`).
2. **Compress is a modal; its two siblings are full screens.** `index.html:79/92/105` are three
   identical-looking rows, but two open screens with step pills and the middle one opens an overlay.
3. **Clicking a DRIVE card does nothing visible; clicking a PHONE card navigates.** `01-core.js:379-383`
   — `onDrive()` only sets state and explicitly HIDES the flow. Same affordance, opposite behaviour.
4. **The Done screen contradicts itself in the phone flow** — `index.html:269` hard-codes "Copied &
   named — in your Uncompressed folder" while the same screen shows a "Send N videos to Uncompressed"
   button, because phone videos stage in `_Phone Video Temp`.
5. **Four names for one folder**: "intake folder", "Uncompressed folder", "01 - Uncompressed", and
   "Clips are copied to" — and the two buttons that open it call the same handler under two names.
6. `.ghost` and `.subtle` are pixel-identical (`styles.css:178-180`), ~50 usages chosen at random,
   with a third bare-`btn` tier mixed into the same rows.
7. Finalize step footers use three different button orders and three different escape labels; step
   2's Continue is not `primary`, so the forward action is the weakest control on the screen.
8. `finMap2Btn` (`index.html:409`) has a live listener but nothing ever removes `hidden` — dead route
   to a modal that already has two live ones.
9. The phone flow's Copy button label flips format once any checkbox is ticked, then names a
   card-flow destination.
10. The card-flow copy screen tells phone users "the originals stay safe on the card until Step 3" —
    the files are already on the computer and Step 3 is unreachable.
11. Two `primary` buttons on the Done screen, and the `primary` one ("Close") hides to tray while the
    action the screen's own text points at is `ghost`.
12. "Cancel" on the rename step is a divergent copy of `goHome()` with no `confirmLeaveTransfer()`
    guard — leaves mid-copy with no warning and a stale device list.
13. `goToCopyProgress` doesn't hide `#finalize`/`#phone`, so the global copy chip can stack two
    screens on top of each other. There are 6+ hand-rolled copies of the hide-list; they want one
    `showScreen(id)`.
14. Settings is both a container and a peer of its own contents (the Edit menu lists 5 of its 8 cards
    as flat siblings). Also colour emoji in a codebase that deliberately moved to monochrome SVG.
15. The Phone screen is the only main screen with no menu route; View duplicates two File items under
    different names.

**Batch 1 done 2026-07-20 (commit 3751cff):** findings 1, 3, 5, 8, and 12 (the Cancel button that
skipped the mid-copy warning — that one could cost footage, not just confuse).

**Batch 2 done 2026-07-20 (commit 7beb38d):** findings 9, 10, 11 and 13. Thirteen is the structural
one and worth knowing about: `showScreen(id)` in 01-core.js now owns which section is visible,
derived from `APP_SCREENS`. **Use it for any new screen** — the six hand-written hide-lists it
replaces are exactly how `goToCopyProgress` came to leave `#finalize` visible. `goHome` and
`goToCopyProgress` are migrated; the remaining open-coded sites in 09-phone-finalize.js (`:11`,
`:500`, `:571`, `:1671`) and 01-core.js (`:593`, `:601`, `:632`, `:1049`) should follow.

Also closed AI-backlog item 8 (face-chip ranking read `p.faces.length`, a field `people:get` never
sends, so tier 2 was always 0 and chips were alphabetical).

**Batch 3 done 2026-07-20 (commit 18c8cb8):** findings 4, 7, 13 (completed), 15 — and findings 6 and
7-in-part were **REFUTED**. Read this before "fixing" them again:

- ⚠⚠ **DO NOT MERGE `.ghost` AND `.subtle`.** They share every visual rule, so they read as
  redundant — but `.row-actions` orders buttons BY CLASS: ghost is `order: 6` ("Back/dismiss"),
  subtle is `order: 8` ("utilities → far right"), primary/danger `order: 1`, bare `.btn` `order: 4`.
  Merging them silently reorders every footer in the app. `test/navigation-is-one-system.test.mjs`
  pins this.
- ⚠ **"Three different footer button orders" was not a real defect.** Every step footer is a
  `.row-actions`, so DOM order does not affect what he sees. Only the *class* of each button matters.

**showScreen is now mandatory for opening a screen.** A test fails on any new
`$('flow'|'finalize'|'phone').classList.remove('hidden')`. Migrating the existing sites surfaced two
more instances of the original bug — `goToRename` and `openFinalize` never hid `#phone` at all.
The three home-rendering paths inside `onDriveOptions` are deliberately left open-coded: they run on
device DETECTION, so a full screen switch there could yank him off Organize when a card is plugged in.

**Batch 4 done 2026-07-20 (commit f1d5ff0):** finding 14's menu half.

**Remaining UI: 2 only.**
- 2: Compress is a modal while its two siblings are full screens with step pills. This is the biggest
  remaining one and it is a real restructure, not a label change — weigh it against the step-list
  pipeline UI in `ARCHITECTURE.md`, which may absorb it entirely.
**Left undone ON PURPOSE — `keep-emoji` is a no-op.** It is applied 26 times across the modules and
has exactly ONE CSS rule, `.ns-tip .keep-emoji { font-size: 18px; }`, so 25 of the 26 do nothing. Two
honest options, neither taken: give it a real global rule (changes how 26 emoji render in places that
cannot be verified from WSL), or delete the 25 dead usages (discards a documented intent — the class
means "this emoji is deliberate, don't swap it for an SVG"). **Ask him which**, or verify visually
first. Do not silently pick one; a cosmetic change nobody can see is the worst kind to guess at.

**Sequencing note:** he chose "close safety data first, then build new". Data safety is now CLOSED,
so this list and the AI-pipeline items below are the current front. The UI work should land as
incremental restructuring behind the existing tests — NOT the greenfield rebuild he floated, because
1356 vm tests encode behaviour that was expensive to get right. See `ARCHITECTURE.md`.

### AI pipeline — 5, 6 and 7 CLOSED 2026-07-20 (commit 3751cff)

Both were fully built, shipped, and had never run once:
- The Organize shoot question read `c.date` while finalize:scan keeps it at `f.meta.date` — `dates`
  was always empty, so it early-returned before rendering. THIS is why shootMemory reads 0.
- Its answer wrote `c.subject`, which on Organize is only the caption mirror; the persisted field is
  `f.meta.subject` via saveFinalMeta. Fixed together, because fixing the first alone surfaces this.
- `clips:tagPerson`/`untagPerson` could not match ANY finalMeta record (name-keyed store vs
  clipKeyV2). Fixed with a dedicated matcher — NOT by loosening `clipKeyMatches`, which also drives
  two DELETE paths.

Remaining here: item 8 (face-chip ranking tier 2 reads `p.faces.length`, but `people:get` returns
`{count, confirmed, unconfirmed}` and no `faces` array — chips fall through to alphabetical).

### Next up — the AI pipeline never completes ([[usb-app-toolness-100]])
5. **The Organize shoot question can never fire.** `askAboutShoots` reads `c.date`, but
   finalize/Organize clips carry the date at `f.meta.date` — only card-flow clips have a top-level
   one. So `dates` is empty and it returns immediately. This is why `shootMemory` reads 0 despite the
   feature being wired, and it starves `get_shoot_context` of the +20pt `he_told_you_this_shoot_is`
   signal. **Fix 6 at the same time or the fix is invisible.**
6. **`askAboutShoots`'s "apply to the whole day" writes `c.subject`**, which on the Organize path is
   only the conveyor caption; the authoritative field is `f.meta.subject` via `saveFinalMeta`. He
   answers, sees a toast claiming N clips named, and nothing persists.
7. **`clips:tagPerson`/`untagPerson` can never match a finalMeta record.** finalMeta is keyed by
   lower-cased filename; the keys passed in are always `clipKeyV2`. Every comparison is false, so
   confirming a face tags nothing durable for already-filed clips — which is precisely the case the
   feature's own comment says it exists for.
8. **Face-chip ranking tier 2 is dead**: it reads `p.faces.length`, but `people:get` returns
   `{count, confirmed, unconfirmed}` and no `faces` array. Chips fall through to alphabetical.
9. ~~**A transient face-engine failure marks the clip permanently scanned** — `detectFacesForClip`
   returns `{ready:false}` with no `readError`/`detectError`, and the guard checks only those two.
   Should be `if (fr.ready && !fr.readError && !fr.detectError)`.
10. ~~**Descriptors per pending cluster are uncapped.** Measured: 4715 vectors across 458 clusters, one
    cluster holding 318 (~880 KB alone), 14 MB total of which only 37 KB is thumbnails. Enrolment
    caps at 80 on arrival, so everything past 80 is written and re-written for nothing.

### Next up — the renderer rebuilds destroy state
11. **Scroll position is lost on every rebuild** in `finRenderList`, `renderTreeView` and `renderPlan`
    — while the twins at `01-core.js:1634` and `07-organize-map.js:1660` explicitly preserve it.
    `finRenderList` is called *inside* the analyze loop, so a 400-clip run snaps the list to the top
    after every clip. Multi-select by clicking is unusable past the first screen.
12. **The "remember this rule" checkbox is discarded by the re-render that reads it** — `.dplan-rem`
    lives inside the group card, and expanding any group calls `renderPlan()`, resetting them all. He
    ticks three, expands one to check its clips, and files with no rule saved and no signal.
13. **`finResetDates` awaits one ffprobe per selected clip serially**, with progress hardcoded to 1/1
    and no `aiAborted` check. Select-all on 400 clips is minutes of apparent hang with no cancel.
14. **Phone entry fans out ~400 concurrent ffprobes** in one `Promise.all` with no bound, on a blank
    screen with no spinner.
15. **`versions.json` stores a full copy of all 4594 drafts per save point** — ~1.4 MB each, 8.6 MB
    for 8 points. Store a delta, or the names only.

### Next up — capability that exists but cannot be reached
16. **`rename:apply` is fully implemented and wired to nothing** — so a typo in a filed clip's name
    is permanent inside the app, and fixing it in Explorer desyncs finalMeta/ledger keyed on the name.
17. **`adbDisable` is unreachable**: `useAdb` is set true in three places and false only by a handler
    nothing calls. If ADB flakes, he is stuck on the broken path with no way back to MTP short of
    hand-editing config.json. (Also gates Q7 in QUESTIONS.md.)
18. **`clearPhoneBackupFolder` unreachable** — the pick half is wired, the clear half is not.
19. **`removeFieldHistory` unreachable**, so every typo he has ever typed is offered back forever in
    the combo dropdowns — and `styleExamples` mines those same values for the AI.
20. **`simulatePhone` menu checkbox has inverted polarity on a fresh config** (`!== false` in the
    renderer vs `=== true` in main), so it renders ticked while off and clicking it is a no-op.
21. **`finSlugFolder` (`slug(v) || 'unsorted'`) is never called**; the real path build drops empty
    levels instead, so a clip missing a category lands one directory shallower, mixed into another
    level's contents rather than a visible `unsorted/`.

### Deferred deliberately
- **The MTP PowerShell copier has the same collision hole the ADB path just had.** Not fixed: it
  cannot be tested from WSL without a real device and it moves the only copy of his photos. Recorded
  as **Q7** in QUESTIONS.md with three options.

### The structural lesson from this audit
Findings 1, 3 and 6 in the UI-honesty sweep were all cases where a **correct** version of the same
message already exists elsewhere (`07-organize-map.js:1490`, `04-tasks-ai.js:909`). The honesty fixes
were applied per-site instead of to a shared helper, so every new call site starts out dishonest by
default. Same for the face guards and the caps: **the twin is where the bug is.** When fixing
anything here, grep for the sibling before writing the test — five of this loop's eight fixes were
"one path fixed, its twin missed".


## 8e. ERROR-PATH AUDIT — 2026-07-20. Findings 1-9 CLOSED (745f596, 4e9a1cb). Only 10 remains.

The technique that produced these: audit the branches that only run when something goes WRONG. They
are the least-exercised code in the app, and the sibling-sweep works there too — the guard present on
one error path and absent on its twin.

**Closed:** undo destroying its own record on failure · finalize:run never writing an undo record if
it threw partway (+ its unguarded progress emitter) · undo orphaning the XMP sidecar and thereby
disarming the empty-folder cleanup · `projects:move` and `compress:run` both reporting ok:true when
every item failed.

**Also closed (second batch):** the premature `sidecar` assignment · phone:pull's literal `ok:true`
and its uncounted drops (⚠ the audit's claim that a "phone-clear step" reads this is WRONG — nothing
in this app deletes from a phone, so it was a false "all done", not lost footage) · the leaking
`phonevid_<ts>` temp dir · compress:run's missing re-entrancy guard.

**Still open — ONE item, and it is benign:**
~~6. `finalize:run` assigns `sidecar = ${curPath}.xmp` BEFORE the write. On the failure path it stays
   truthy, so step 2 tries to move a file that was never created and pushes a second, misleading
   error (`Sidecar for X stayed at the source: ENOENT`). Nothing is lost — `metaLanded` correctly
   stays false — but one failure reports as two, one describing a file that does not exist. Assign
   only after the write succeeds. (`main-mod/09-ipc-boot.js:876-889`)
7. `phone:pull` returns a literal `ok: true` regardless of how much it dropped, and `incomplete`
   under-reports: it counts only TRUNCATED pulls. A file the device never produced falls into
   `catch { /* couldn't verify — skip */ }` (`05-windows-phone.js:334`) and into the sim branch's
   `catch { /* skip */ }` (`:296`) without incrementing anything. So a pull that got 40 of 60 photos
   returns ok:true with incomplete:0 — and the phone-clear step downstream reads that as clean.
   **This is the one with footage at stake; do it next.**
8. `phonevid_<ts>` temp dir (`05-windows-phone.js:1041`) is never removed — grep finds exactly one
   hit. Its sibling `stageDir` in `phone:distribute` IS cleaned (`:1195`), though not in a `finally`,
   so an early throw there leaks a full copy of the card's stills too. Tens of GB of invisible growth
   on a videographer's machine.
9. `compress:run` has no re-entrancy guard while `copy:start` does (`if (copyTask && copyTask.active)
   return …`). Two concurrent runs into the same outDir would have run A's unconditional
   `fsp.rm(join(out, '.partial'))` delete run B's in-flight staged encode. The renderer's
   `cmpState.running` makes it hard to reach, which is why it is not urgent — but it is the same
   guard the copy path decided it needed, on a handler that spawns processes and deletes a directory.
10. `phoneAbort` is a cross-flow module global set by the CARD flow's `copy:cancel`
    (`06-copy-transfer.js:389`) and reset on entry by only two of its three consumers.
    **Currently benign — the agent could not construct a failing sequence, and it is listed only so a
    future session does not re-derive it.** If a fourth consumer is added, reset-on-entry must be
    added with it.

**Checked and genuinely clean, do not re-audit:** retry logic is bounded and idempotent throughout
(`copyFileVerified` fixed-count, `readJsonRetry` capped at 6, ffmpeg/PowerShell have idle watchdogs
plus absolute ceilings, `nearestExistingDir` caps at 8 hops); process/handle cleanup is consistently
in `finally`; `copy:start` does NOT leave a truncated file in the watch folder — `copyFileWithProgress`
stages to `.part`, full-fingerprints, renames, and unlinks the part in its own catch.


## 8f. CONCURRENCY AUDIT — 2026-07-20. Finding 1 CLOSED (3c3a4bc); 2-8 open, ranked.

Nobody had audited what happens when two things run at once. The highest-yield technique was again the
sibling sweep, applied to GUARDS: one path guarded, its twins not.

**Closed:** two of the three face-clustering paths could erase each other's entire run (and the clips
stayed marked scanned, so a re-scan skipped them — permanent loss).

**Closed 2026-07-20 (8370989, 88a8ec5):** 2 (Follow AI un-cancelling a run) · 3 (copy:start's guard
claimed too late — it EXISTED, the audit was wrong about that, but `copyTask` is assigned ~70 lines
and four awaits later) · 4 (finalize:run unguarded, two runs fighting over the single undo slot) ·
5 (Analyze/Improve unguarded and un-cancelling each other) · 7 (the debounced draft save discarded
when a new scan empties the array — a name typed within 600ms of swapping cards, silently lost).

**Still open:**

2. ⚠ **"Follow AI ↓" silently UN-CANCELS a run.** `src/mod/04-tasks-ai.js:582` does
   `aiFollow = true; aiAborted = false;`. That button is only visible DURING a run and only after he
   has scrolled away — exactly the state someone is in when they cancel. Cancel → the loop is inside a
   vision call for up to 180s → he clicks the still-visible "Follow AI ↓" to see what it is doing →
   `aiAborted` goes false → the next `if (aiAborted) break` passes and the run RESUMES, overwriting
   names he cancelled to protect. The same line un-does `reportCardGone()`, so one click resumes
   analysis against a card that has been pulled out. **Do this next — it is one line and it is real.**
3. ⚠ **`copy:start` has no re-entrancy guard**, the twin of the one just added to `compress:run`.
   Two invocations share `copyTask`: run A reads B's abort flag, `copy:cancel` cancels only B, both
   write `copyTask.currentIndex/copiedBytes` and emit on one channel, and whichever finishes first
   sets `copyTask = null` so the other throws a TypeError mid-copy and the renderer shows "Copy
   failed" over a partly-imported card. **Reachable without a millisecond window:** auto-mode fires
   `setTimeout(..., 800)` (09-phone-finalize.js:676) and the renderer's own `copyInProgress` latch is
   not set until AFTER `await freeSpace(...)` per target — so clicking Copy at ~790ms means both
   proceed. This handler moves multi-GB of his only copy.
4. ⚠ **`finalize:run` has no re-entrancy guard either, and two runs fight over the single undo slot.**
   `config.lastOrganize` holds ONE record. The batch Run disables its button, but `fileOneClipNow`
   (09-phone-finalize.js:1909) calls the same handler with no disable and no guard — and it is
   deliberately the low-friction "file one clip right now" action, i.e. the one clicked repeatedly.
   Two runs both relocate footage, both stamp lastOrganize, last write wins, and one run's clips have
   NO undo path — the outcome the ⚠⚠ comment at 09-ipc-boot.js:1083 was added to prevent, reached by
   another route. Secondary: the CSV merge at :1105-1117 is a read-modify-write across two awaits on
   a shared file, so concurrent runs drop each other's rows.
5. `aiAnalyzeSelected` / `aiImproveSelected` have no run guard while `aiAutoEnhance` does, and both
   start with `aiAborted = false` — so starting Improve un-cancels a running Analyze. Both call
   `setAiRunOrder(...)`, which replaces `aiStageClips` wholesale, so the conveyor describes one run
   while two are writing.
6. ⚠ An in-flight AI run writes into a `state.scannedFiles` that a NEW CARD has already replaced.
   **Partly mitigated but NOT closed:** the run guard added in 88a8ec5 stops two AI runs overlapping,
   but nothing stops him navigating Home mid-analyze and scanning another card — `goHome` gates only
   on `confirmLeaveTransfer()` (copy), and analyze is deliberately non-modal.
   `goHome` gates only on `confirmLeaveTransfer()` (copy), and analyze is deliberately non-modal — so
   leaving mid-analyze and scanning another card means card A's results are applied by INDEX to card
   B's clips. `enterRenameWithPhoneFiles` documents exactly this hazard for `aiQuestions` and re-binds
   them; the live AI loops never got the same treatment.
7. The debounced draft save is DISCARDED when a new scan empties `state.scannedFiles`. The
   `if (state.scannedFiles.length)` guard is evaluated at FIRE time, and `startFlow` empties the array
   seconds before refilling it — so a name typed within 600ms of swapping cards is silently lost, with
   a ✓-looking UI. `flushDraftSave` has the identical guard, so the blur/pagehide net does not catch
   it either.
8. Cancel is not honoured during the NAS mirror: the intake copy takes the cancel token, the mirror
   immediately after it calls `copyFileVerified` which accepts no token and has a retry. Cancel during
   a large network mirror sits at "Cancelling…" for the full transfer plus a verify plus a retry.

**Checked and genuinely clean, do not re-audit:** main-side store read-modify-write (every mutator
reads via `currentX()`/`freshStore` and writes with NO await in between — there is no
`const x = currentDrafts(); await …; saveStore(…)` anywhere in main-mod/); progress-subscription
lifecycle (subscribeProgress is idempotent, every per-run handle is torn down in a finally — no
double-subscribe, no leak); compress (the new `compressRunning` + finally is correct and
`compressAborted` is checked at both the loop head and after the encode).


## 8g. FRESH-INSTALL AUDIT — 2026-07-20. Most closed (979f43b). ONE blocker left, needs his decision.

Audited against his own goal: *"ship stock working completely on 1 computer with it compressing
everything and renaming writing metadata."* The path is in **much better shape than expected** — there
is a real 7-step wizard, empty states return clean `{ok:false,error}` shapes, and the AI degradation is
the single best-executed part of the app (aiReady/requireAi show two distinct actionable modals, a
`ui-ai-off` class hides AI affordances, naming by hand is unaffected throughout). Face models really
are bundled; exiftool is vendored and asarUnpack'd with a dual-layout resolver; adb is correctly
optional behind `useAdb:false`. **Do not "fix" any of those.**

**Closed:** `compressMode` defaulting to his Tdarr watch-folder (which HIDES the Run button, so stock
had no compress button at all) · `launchAtLogin` defaulting true and applied unconditionally ·
`defaultProjectsRoot()` asserting his tree shape on every machine · the hardcoded `L:\` fallback.

### ffmpeg — the PROBE is done (88a8ec5); bundling is still his decision.
The health check now runs `ffmpeg -version` through `runCapture` and reports a high-severity
`no-ffmpeg` problem with a copy-the-download-link action, so the absence is no longer silent. What
remains undecided is whether to VENDOR it (~80 MB on a 135 MB installer). Do not do that unprompted.
The original finding, kept for context:

`ffmpegPath: 'ffmpeg'` / `ffprobePath: 'ffprobe'` (01-core.js) assume they are on PATH, and **nothing
vendors them**. On a clean Windows box they are absent and the failures are SILENT:
- `06-copy-transfer.js:19-26` — `proc.on('error', () => resolve(false))`: every thumbnail and poster
  simply never appears, with no message.
- `06-copy-transfer.js:39-53` — `probeMeta` swallows it and returns `durationSec: 0`, so every clip
  shows no duration and the compress bar goes indeterminate.
- Only `compress:run` surfaces anything, and it surfaces the raw `spawn ffmpeg ENOENT`.

**There is no ffmpeg path field anywhere in the UI** — grepped all of src/mod/. A user with ffmpeg
installed somewhere non-PATH cannot point the app at it without hand-editing config.json.

Three options, none obviously right: **(a)** vendor it (~80 MB on an installer already at 135 MB);
**(b)** probe at startup and show one honest blocking message with a download link, plus a settings
field; **(c)** wizard step. **(b) is the cheapest real fix** and should probably happen regardless.

### ⚠ DELIBERATELY NOT DONE — the AI prompt example
The audit's last item was to genericize `"a client"` in the placement prompt's few-shot example
(03-ai-ollama.js:408, :478). **It is a MEASURED INPUT.** A cosmetic rename of a tool RESULT already
cost 20 points of accuracy here, 4/4 deterministic ([[usb-app-tool-strings-are-input]]). The prompt
does say "do not copy its values". Leave it until someone re-measures.


## 8i. ⚠⚠ DIRECTION FROM JAKE, 2026-07-22 — DEFAULTS FIRST, THEN PRESETS

> *"I have a specific setup with the app right now that I like, but you should build it as if it was
> an application that worked without all the compression folders and stuff and just worked and then
> can be mega customized to the point where I have it. I was thinking some kind of UI to organize all
> this and make it work. I should also be able to have presets, and save my setups as a preset and
> then share it."*

Four requirements, in his order:

1. **It works with NO setup.** A fresh install must ingest → name → file with zero configuration.
   Today the pipeline is gated on HIS layout: `01 - Uncompressed` / `02 - Compressed`, a Tdarr
   hand-off, an `L:` archive, `C:\...\02 - Projects\2026`. Organize scans `02 - Compressed`
   specifically — a user without that folder sees an empty screen and concludes the app is broken.
2. **Then customizable "to the point where I have it."** His rig is the far end of the slider, not
   the baseline. Nothing may be REMOVED to achieve #1.
3. **One UI that organises the configuration**, replacing settings scattered across screens plus a
   wizard he ran once and cannot find again (item 64).
4. **Presets he can save and SHARE.** Sharing is what changes the design: a preset leaves his
   machine, so it must carry no absolute paths and no personal data (people, faces, subjects,
   ledger), and importing one must never touch footage. **Treat an imported preset as untrusted
   input** — it is the first thing in this app that arrives from outside.

**Why this is not cosmetic, measured 2026-07-22.** His two standing filing rules store
`dest: "2026/2026 - Client Work/a client"` while `projectsRoot` is `...\02 - Projects\2026`.
So `resolveFolderPath` produces `.../2026/2026/2026 - Client Work/...` — **117 of 309 clips would
fork his tree into a duplicate `2026\2026\...` beside the real one**, and the other 154 create bare
top-level folders in his year root (`vlog/`, `pov/`, `delete/`). Cause: he clicked the health card's
"Use that folder", which set `projectsRoot` one level deeper than his rules assumed, and **nothing
revalidates a route dest when the root moves.**

**Order matters, and this is the one hard sequencing rule here:** fix and validate route
destinations BEFORE shipping anything that makes filing easier to reach. Reachability is the real
stall (0 Organize visits in 14 days of use), so the obvious next move is a "File these 310" action
where he already lives — but shipping that first means his first successful filing run forks his
tree, and he undoes it and trusts the app less.

Every path-shaped setting needs validation against the tree it points at, and a repair offer when it
drifts. See memory `usb-app-defaults-then-presets`.

---

## 8j. ⚠ LOOP CADENCE (Jake, 2026-07-22): EVERY ITERATION UNDER 2 MINUTES

> *"Also make it a rule for looping that it has to be under 2 minutes."*

`ScheduleWakeup` in dynamic mode must use **`delaySeconds` ≤ 120** (the runtime floor is 60, so the
usable window is 60–120). This supersedes the tool's own "lean 1200–1800s" guidance and any earlier
note in this file about long fallback heartbeats.

**This does NOT shrink the work.** §8 still stands: each iteration is a broad analysis plus a large
batch. The two rules combine to mean *keep the work big and the gaps between check-ins small* — do
not turn a 2-minute cadence into 2 minutes of work, and do not end a turn early just to hit the
cadence. Long-running things (subagent audits, e2e runs, builds) keep running across wake-ups and
notify on completion; the short wake-up is a heartbeat, not a deadline for the batch.

---

## 8h. ⚠ FEATURES.md IS THE ROADMAP — read it before choosing work.

Jake asked (2026-07-20) for "100 things the app should be able to do… build it as a feature into
everything… like the android app. I would like it to have full functionality once released."

`FEATURES.md` is that list: 100 numbered capabilities, each marked for the surfaces it must reach
(**D**esktop · **P**hone · **B**ackend) with an honest status. **Pull work from there.** Two things
in it override any other prioritisation:

1. **Item 29 — a controlled subject vocabulary — is the unblock, not a feature.** Measured on his
   real store: 4,594 clips, 331 named, **1 filed**. There are **112 distinct subjects for 206 named
   clips**; 46% describe the SHOT (`talking-head`, `person-sitting-couch`) rather than the job, and
   20 pairs are fragments of each other (`car` / `car-driving` / `car-parked`). Filing groups by
   subject, so nothing groups, so nothing files. **Every capability in the filing section is correct,
   tested, and useless until this is fixed.** Features that add more ways to generate free-text
   subjects make it worse.
2. **"Done" means done on every surface listed.** His own Android repo carries a non-negotiable
   parity rule enforced by a test that parses both repos' shipped source. The phone is currently at
   roughly 10% parity — exactly one workflow (the face review) is complete end to end.

Also in there: **6 capabilities that are built, shipped, and unreachable** — no preload caller, or
no UI route. Several are small wiring jobs and each one is something he paid for and cannot use.
(It was 11 until 2026-07-20, when items **7, 10, 28, 55 and 42** were wired up. The first three shared a
shape worth carrying forward: each was the *off switch* for something the app could only turn ON —
fast transfer, the wireless backup folder, a remembered autocomplete value. **A feature is not
finished at the point it can be enabled.** When adding one, look for the way back out in the same
change. 55 was different — a fact the app knew and never said, which on a 6 GB card is the difference
between an analyze run that is fast and one that swaps to disk.
**42 carried the real lesson: an unreachable handler has never been audited.** `rename:apply` looked
finished and had TWO bugs — no path guard at all (every other renderer-path handler has one; this is
the only one that MOVES a file), and it renamed the clip while leaving its `finalMeta` record behind
under the old filename key, so fixing a typo would have cost him the record. **Before wiring a dead
handler, read it as if it were new code.** It has never had a live call site to be audited from.)

⚠ **A trap in `test/ipc-reachability.test.mjs` that nearly let a fix ship dead.** Its `used()` check
matches `` `.${m}(` ``, so a **renderer-local function with the same name as the bridge method
satisfies it without calling anything**. The backup-folder work's first draft named its renderer
function `clearPhoneBackupFolder` — identical to the bridge method — and would have passed the guard
while invoking nothing. It is `stopWirelessBackupFolder` for that reason. Name the caller differently
from the bridge method, always.


### ⚠⚠ A BREAK-VERIFICATION HARNESS CAN ITSELF BE BROKEN — check that it ever reports a failure

On 2026-07-20 a shell loop that broke five guards in turn reported **`fails=0` for every one of
them**. Every guard was in fact caught; the harness was faulty. Five clean passes in a row is not a
result, it is a smell — a real set of breaks produces a mix.

**If a break harness reports no failure for EVERY break, verify one by hand before believing any of
them.** This is the "assertions that don't assert" trap (§8c) applied one level up, to the tooling
that is supposed to detect it. Prefer running the breaks as separate commands whose output you can
read over a loop that prints only a count.

### ⚠ AN UNIDENTIFIED E2E FLAKE — do not dismiss it if you see it

On 2026-07-20 the e2e suite reported **153/1** once, immediately after a full vm run in the same
command, and then passed 154/0 on three consecutive re-runs. The failing test name was NOT captured
before it went away, so this is an honest open item rather than a fixed one.

Two flakes in `test/e2e/phone-review-page.e2e.mjs` were found and fixed the same day, and a third
cause is plausible: that file launches **Chromium** while the rest of the suite launches **Electron**,
so a full run has several browsers competing, and its image-load waits are the most timing-sensitive
assertions in the suite.

**If you see a single e2e failure, capture the NAME before re-running.** `npm run test:e2e 2>&1 | grep
"^not ok"` costs nothing and is the difference between fixing it and rediscovering it. A suite that
"usually passes" trains you to ignore failures, which is worse than a red suite.

## 8c. Testing traps in THIS repo (each of these cost real time)

- **A STRUCTURAL ASSERTION MUST NAME THE THING THAT WOULD GO MISSING — and you must break each part
  separately to prove it. STRIP COMMENTS FIRST.** The single most expensive mistake of the session,
  hit six times. The explanatory comments in this codebase quote the very identifiers your assertion
  is looking for, so `apply.replace(/\/\/.*$/gm, '')` before matching — otherwise you are asserting
  that the comment still exists. Then break EACH part and watch it fail; a whole 6-test file once
  stayed green while both detections it guarded were deleted. `/undoAssign/` stayed green
  when the call was made unreachable with `if (false)`, because the identifier was still in the text.
  `/peopleAuto/` stayed green when one of two lines was deleted, because the other line still
  contained the word. `count >= 2` stayed green for the same break, because the surviving line
  mentions it twice. Only naming both concrete expressions caught it. Bare identifiers, word counts
  and "the old text is absent" are **non-guards**. Bind the call to its guard, name each collection,
  and prefer a behavioural test wherever a harness can reach the code.
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
- **PROVE A BREAK ACTUALLY APPLIED.** A scripted break that silently fails to match looks exactly
  like a guard that held. Assert the replacement hit (`s.count(old) == 1`) before concluding the test
  survived — a throwaway helper without that assertion produced a false "the break didn't fail it"
  twice in one session.
- **A flag proves what it guards, not what you assume it guards.** `_autoConsolidating` correctly
  prevents a second consolidation and nothing else, while five other writers touch the same store —
  and its presence reads as "this is handled". Check what the flag is actually checked BY.
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
  `C:\Users\<you>\Downloads\skool-downloader-chrome\usb-auto-action`, then run
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
test tiers are **119 vm files → 1045 tests / 952 pass / 93 skipped / 0 fail** and **22 e2e files →
93 tests / 92 pass / 1 skipped**; **81 commits** are undeployed. It refreshed the §5 ranked weak
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
**~82 commits are green and undeployed, with the installer PRE-BUILT AT HEAD and asar-verified** (see `AGENTS.md` 2026-07-19ba) — so the deploy is a ~10-second install with no build step. Check `AGENTS.md` §7a for the current deploy state before
assuming anything is live._

_**Final pass of 2026-07-19.** ELEVEN axes have now been swept and every finding is closed. In order
of yield: sibling-path (7 confirmed), store invariants (produced the worst data-loss bug of the
session), photo/video parity (found the card being WRITTEN to), state-changing-under-the-app (found a
durable false negative and a silent NAS disable), swallowed failures, undo/inverse pairs,
delete/evict paths, write-vs-read normalisation, main-vs-renderer guards, re-entrancy, and the
three-axis pass. **The queue is empty and the deploy is the only high-value action left.** If a
twelfth sweep comes back empty, say so plainly — after eleven, that is the likeliest and most useful
answer._

_If you changed bundling, the store engine, the AI tool protocol, the test harness, or the release
process, re-read this file and update the affected sections before you finish._
