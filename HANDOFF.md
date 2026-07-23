# HANDOFF — start here

**Updated 2026-07-22.** This file exists so a session on another machine can pick up cold, without
re-reading a chat log. If you change direction or land something big, update this file in the same
commit.

---

## 1. Read these, in this order

| file | what it is |
|---|---|
| **`PROMPT.md`** | Standing instructions for autonomous work. **The source of truth.** §8i is the current direction; §5 is work-selection; §3 is the data-safety rules that outrank everything. |
| **`AGENTS.md`** | Project memory + dev guide. §8 is the lessons log — append at the top, never delete. Rule zero (issues tab) is at the top. |
| **`FEATURES.md`** | The 100-capability roadmap with honest status. ⚠ Its headline premise is now known to be WRONG — see §3 below. |
| **`QUESTIONS.md`** | 9 open questions for Jake. Nothing is blocked on them; each took the safe reversible path. |
| **`CHANGELOG.md`** | User-facing notes, written in Jake's terms, second person. Match that voice. |

Branch: **`integration/preview-ui-everything`**. That is where the work happens.
Remotes: `github` (Virus7976/usb-video-manager — also the auto-update release feed) and `origin`
(a self-hosted Gitea).

## 2. Where we are

- Suite: **1,682 unit tests passing, 0 failing** (`npm run check`). E2E: `npm run test:e2e`
  (Playwright drives the real Electron app; works from WSL).
- **Never edit `main.js` or `src/renderer.js`** — they are generated. Edit `main-mod/*.js` and
  `src/mod/*.js`, then `npm run bundle`.
- Five sibling worktrees exist (`../USB-Video-Downloader-{ui,motion,rules,placement,integration}`).
  All are **fully merged and drained** — 0 commits ahead. Ignore them or delete them.

## 3. ⚠ The three corrections that matter most

**a. The AI was naming every clip and discarding the name.** `aiSuggestClip`'s tool path returned its
result instead of passing it to `applyAiResult`, the only place `clip.subject`/`clip.description` are
ever assigned. Measured: 1,084 clips watched by the vision model, **716 with a blank draft**. His
"331 of 4,594 named" figure is exactly the clips named *before* that path went in. Fixed (`2e8b783`).
**36 existing tests missed it because every one asserted the RETURN VALUE, never the clip.**

**b. FEATURES.md's premise is wrong, and the roadmap still says otherwise.** It claims filing is
blocked by 112 competing subjects. Those live in `drafts.json` — clips still on cards. The 310 clips
in `02 - Compressed`, which is what Organize actually scans, carry **8 distinct subjects**. Driven
end to end against his real layout: `finalize:run` moved **309 clips into 47 folders, 0 errors**,
12.3% to `_unsorted`, 0 to the root, idempotent on re-run. **The filing pipeline works.**

**The real stall is reachability.** 1,487 clicks over 14 days of real use, **0 on the Organize
screen.** `config.session.view` resumes him into the phone flow every launch, and the "ready to
organize" card sits third on Home behind 458 pending faces and 700 phone videos.

**c. A "learn from his data" feature measured net negative and was reverted.** Making the project
ledger a subject-vocabulary source changed 0 group counts and produced 2 wrong canonicalisations,
because a real Projects tree is workflow scaffolding (`V5`, `Day 1`, `In Progress`, `raw footage`),
not a subject list. It had 20 break-verified tests and was still worthless. The pin is in
`test/subjects-learn-from-his-folders.test.mjs`. **Lesson: test fixtures for a learn-from-his-data
feature must be shaped like HIS data, and check the CONSUMER before optimising the producer.**

## 4. What to do next — in this order

**1. ~~Repair and validate route destinations~~ — DONE (`c6a289e`, `2d94e34`).** The resolve-time repair and the health-check surfacing both landed. Historical detail:
His two standing filing rules store `dest: "2026/2026 - Client Work/Gourgess Lawns"` while
`projectsRoot` is `...\02 - Projects\2026`. `resolveFolderPath` therefore yields
`.../2026/2026/2026 - Client Work/...` — **117 of 309 clips fork his tree into a duplicate
`2026\2026\...`**, and the other 154 create bare top-level folders in his year root (`vlog/`, `pov/`,
`delete/`). Cause: he clicked the health card's "Use that folder", which set `projectsRoot` one level
deeper than his rules assumed, and **nothing revalidates a route dest when the root moves.**

**2. Then Jake's direction (PROMPT.md §8i, 2026-07-22):** the app must work with **zero setup**
first — no `01 - Uncompressed` / `02 - Compressed` / Tdarr / `L:` assumptions — then be customizable
all the way up to his rig, via **one config UI**, with **saveable and shareable presets**. A shared
preset carries no absolute paths and no personal data (people, faces, subjects, ledger); an imported
preset is **untrusted input** and must never touch footage.

**⚠ Sequencing is a hard rule:** #1 before #2. Reachability is the real stall, so the tempting move
is a "File these 310" button where he already lives — but shipping that before the route repair means
his first successful filing run forks his tree, and he stops trusting the app.

**3. Then, ranked, from the 2026-07-22 audit** (details in `AGENTS.md` §8):
- `ipc-reachability.test.mjs` has two holes: its regex misses template-literal channels (hiding 6
  genuine orphans in `makeListHandlers`), and its `used()` counts its own `KNOWN_UNUSED` strings as
  usage, so the array is never consulted and deleting it leaves the test green.
- ~~`projects:move` files into the bare root given `rel: ''`~~ — **REAL, and now FIXED.** An earlier
  iteration wrongly marked this "does not reproduce" because its probe used `items:` instead of the
  real payload key `moves:`, so nothing was exercised. See AGENTS.md §8 — "a probe asserting an
  absence must first be shown to produce the presence".
- ~~The ffmpeg-missing health check is unreachable~~ — **false.** `if (!ffProbeOk)` is a sibling of
  the `no-projects-root` push, not nested inside it. FEATURES.md #89 is correctly `done`.
- `ai:health` ignores `advice.kind === 'unset'`, so a fresh machine with a vision model pulled but
  not selected gets no nudge.
- Phone flow: "Send to Uncompressed" discards main's failure report and hides the retry button, so
  failed videos are silently stranded; the done-line counts videos that were never renamed.
- ~~`phone:applyQueue` guards `ai.facesPending` but not `ai.people`~~ — **REAL, and FIXED.** Both
  stores are guarded now. Settled by reusing the working fixture in
  `test/phone-answers-actually-land.test.mjs` (it needs `descriptor` AND `descriptors`); two earlier
  hand-written fixtures matched nothing and made the result unreadable. The file carries an explicit
  CONTROL test — it asserts enrolment really happens — so the guard test can never pass vacuously.
- 5 dead IPC bridges are worth deleting rather than wiring (`finalMeta:get`, `intake:get`,
  `feedback:list`, `ai:recallShoot`, `ai:visionAdvice`) — every one is reachable another way.

## 5. House rules that are easy to violate

- **Every behaviour change lands with a test, and every test is proved by BREAKING it.** A clean
  sweep across many breaks is a smell — a real set produces a mix. Run breaks as separate readable
  commands, not a loop printing a count.
- **A structural assertion must name the thing that would go missing.** Assertions here have passed
  vacuously many times. If a cap is involved, assert **identity, not size** — a `slice(-60)` holds a
  count constant forever while evicting real data.
- **Never stop, never ask mid-run.** Questions go to `QUESTIONS.md` with what was done instead and
  how to undo it; ask them all when he next messages.
- **Loop iterations must stay under 2 minutes** (Jake, 2026-07-22). See PROMPT.md §8j.
- Card deletes are never automated. Never hand-roll a copy of the footage. `verifyCopyPair` is never
  weakened.
