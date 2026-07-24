# Questions for Jake

Standing order (2026-07-20): I never stop and never ask mid-run. Everything that would have been a
question lands here, and I ask them all at once when he next messages.

**How to read this file.** Each entry says what I need from him, why I couldn't just decide it, what
I did in the meantime so nothing was blocked, and how to undo that if he wants the other answer.
Nothing here is waiting on him — the work continued past every one of these.

**What does NOT belong here:** anything I can decide and log as an assumption, anything a test can
settle, and anything where one option is clearly safer and reversible. Those get decided, not asked.
This file is for genuine forks in HIS data or HIS workflow, and for blockers I could not get past.

---

## Open

### Q1 — Duplicate subject spellings in his own vocabulary
**The question:** `lawn-mowing` (68 clips) and `lawnmowing` (15) are one subject spelled two ways, and
his stored subject list carries both. Should the app merge them in his DATA — the subjects list, the
drafts, the saved metadata — or keep both spellings forever?

**Why it needs him:** it rewrites his own vocabulary. He typed both, and a machine deciding which of
his words is "correct" is exactly the kind of silent tidying that has burned this project before (a
cosmetic rename of a tool result once cost 20 points of accuracy).

**What I did instead:** solved the part that needed no decision. Filing now REUSES an existing folder
whose name differs only by separators or case, so both spellings land in one tree without renaming
anything. His data is untouched; only the destination choice changed.

**To undo:** revert the near-match branch in `resolveFolderPath` (`main-mod/02-media.js`) — the
`loose()` comparison. Tests: `test/folder-reuse-ignores-separators.test.mjs`.

### Q2 — Clips he named `delete`
**The question:** 3 clips are named `<date>_delete_...` — his own marker for footage he intends to
bin. Should filing skip them, file them into a `_delete` holding folder, or treat them as ordinary
footage?

**Why it needs him:** guessing "skip" could hide footage he actually wanted; guessing "file" clutters
his archive with clips he has already written off. Either way it is his intent, not mine to infer.

**What I did instead:** nothing — they file normally, as before. No behaviour changed.

### Q3 — A 304 MB orphaned temp file on `L:`
**The question:** `2026-05-31_lawn-mowing_dennis_v1.mp4_exiftool_tmp` (304 MB, 2026-06-15) is debris
from the interrupted exiftool write. Delete it?

**Why it needs him:** it is a file on his disk that I did not create. The real clip beside it is
intact (70 MB, older), so nothing is at risk — but deleting his data is his call, and I will not
delete a file I cannot fully account for.

**What I did instead:** left it alone and reported the size. Fixing the exiftool crash means no new
ones will appear.

### Q4 — 203 photos stranded in the Uncompressed folder
**The question:** `01 - Uncompressed` holds **203 app-named .jpg photos** (shoots from 2016 and
2024). Organize scans `02 - Compressed`, and photos never get compressed, so they never move there —
they are invisible from the default Organize view. Should the Organize screen offer the intake folder
as a second source, or is a manual folder switch fine?

**Why it needs him:** it changes what the main screen scans by default, and I do not know whether
those photos are staged deliberately or are leftovers from an older version of the app.

**What I verified in the meantime (nothing changed):** pointed a scan at that folder against copies of
his real filenames — **203/203 matched by filename and filed cleanly into 10 dated folders**
(`vlog/2024-08-03` and so on), 0 errors. So the workaround already works today: on the Organize step,
change the source folder to `01 - Uncompressed` and tick "include photos". No code change needed to
unblock him.

### Q5 — which spelling wins when a subject has two
**Not really a question, more a heads-up.** Filing now reuses a folder whose name differs only by
separators (Q1), but on a tree where NEITHER spelling exists yet, the first clip filed creates the
folder — so his 83 lawn-mowing clips will all land under whichever of `lawnmowing` / `lawn-mowing`
gets filed first (alphabetically that is `lawnmowing`, the 15-clip spelling).

**What I did:** left it. Renaming the folder afterwards is a one-second fix and the reuse logic then
follows HIS name permanently. Pre-scanning the batch to pick the majority spelling is more machinery
than the cosmetic gain justifies.

### Q6 — auto-confirming faces above a confidence you set
**The question:** Tier 2 item 24 — *"auto-confirm faces above a confidence he sets, and only ask about
the uncertain ones."* Your 458 pending clusters include many that already match one of your 48
enrolled people; the app matches them, but saves every one as UNCONFIRMED, so they all still queue for
review. What distance threshold should auto-confirm at — or would you rather it never auto-confirms?

**Why it needs you:** this decides face IDENTITY without asking, and that identity gets embedded into
your files. Too loose and the wrong name is written into footage and has to be found and undone; the
threshold is the whole safety margin, which is why the item says "he sets" rather than "pick one".
Related: a cosmetic 0.2-vs-0.35 threshold difference elsewhere in this code was measured as a real
accuracy change, so this is not a number to guess.

**What exists in the meantime (nothing changed):** the review already has **"Confirm all
suggestions"** — one click accepts every suggested match in the current grid, and each is undoable
individually. So the bulk path is there; only the *automatic* part is open.

---

## Q7 — the MTP phone copier can still overwrite one photo with another. Fix it blind, or wait?

**The question:** the ADB pull path had a bug where two photos sharing a filename in different phone
folders (`DCIM/Camera/IMG_0001.jpg` and `Pictures/IMG_0001.jpg`) ended with one of them **deleted**.
That is fixed and tested. The MTP path — the fallback used when ADB is off or the phone refuses it —
has the same hole, in the embedded PowerShell: it does `Join-Path $dest $entry.name` with no
collision handling, so the second photo either overwrites the first or is reported `SKIP` when the
sizes happen to match. Either way one irreplaceable photo is gone and the run reports success.

**Why it needs you:** I can't test PowerShell from WSL without a real phone attached. Every other fix
this session was proved by breaking it and watching a test fail; this one I would be writing blind,
and the code path moves the only copy of your photos. Guessing at it is the exact trade that has
produced regressions here before.

**Options:**
1. **Wait until you can plug a phone in** and I'll fix it with you watching the first run. (Safest.)
2. **Fix it blind anyway** — the change is small (claim each target name, same logic ADB already
   uses) and I'd add a dry-run mode you could eyeball before a real transfer.
3. **Make MTP refuse the collision instead of guessing** — if two selected items share a filename,
   stop and tell you, rather than copying. Loses nothing, but you'd have to pull them in two passes.

**In the meantime:** if fast transfer (ADB) is on, you are not exposed — that path is fixed. Note
that turning ADB *off* is currently impossible from the UI (see the backlog), so if it's on, it stays
on.

---

## Q8 — should updates install themselves, given the app isn't code-signed?

**The question:** the app auto-updates from your GitHub releases. Downloads *are* integrity-checked
(the feed carries a sha512 and electron-updater verifies it over HTTPS), so nobody can tamper with an
update in transit. But the app isn't code-signed, and it's configured to download **and install**
updates on its own (`autoDownload = true`, `autoInstallOnAppQuit = true`).

That means the security of your video tool reduces to the security of the `Virus7976/usb-video-manager`
GitHub account: anyone who can publish a release there can push something that installs itself on your
machine the next time you quit the app.

**Why it needs you:** the fix isn't code. Options:
1. **Leave it.** Realistically fine if that GitHub account has 2FA on — which is worth confirming
   either way. Zero effort, and updates keep being effortless.
2. **Make updates explicit** — still download in the background, but never install until you click.
   A one-line change; costs you one click per update, removes the auto-install path entirely.
3. **Buy a code-signing certificate** (~$100–400/yr). Gets you real provenance and kills the Windows
   SmartScreen warning on every install. The only option that actually proves a build is yours.

**What I'd suggest:** confirm 2FA, and take option 2 — it removes the auto-install path for almost
nothing. A certificate is only worth it if the SmartScreen warning is bothering you.

**Correction worth noting:** PROMPT.md described this as "the highest-severity thing still unfixed"
and said it couldn't be worked on from WSL. Both were wrong — I've corrected them. The integrity
checking already exists, and packaged Windows builds work fine from here.

---

### Q9 — a shared preset carries your client folder names
**The question:** presets (new, 2026-07-23) deliberately exclude every absolute path and all your
personal data — people, faces, subjects, drafts, the ledger. But they DO include your standing
filing rules, and a rule is meaningless without its destination folder, so
`2026 - Client Work/a client` travels with it. If you send a preset to someone, they learn
your client names and how you organise them.

**Why it needs you:** filing rules are the single most useful thing in a workflow preset — a preset
without them is barely worth sharing. But they are also the only part that says anything about *who
you work for*. Which matters more is yours to weigh, not mine, and it depends on who you would send
one to.

**What I did in the meantime:** included them, and made the export explicit about it rather than
quiet. Nothing else about your clients travels — no ledger, no subjects, no filed metadata.

**Options if you want it changed:** (a) leave it; (b) strip rule *destinations* on export, keeping
the keywords and the on/off state, so the recipient re-points them; (c) ask at export time —
"include your filing rules?" with the folder names shown.

**To undo:** drop `'ai.routes'` from `ALLOWED` in `core/presets.js`. Tests:
`test/presets-never-leak-his-data.test.mjs`.


### Q10 — "310 clips in 211 projects" is technically right and reads oddly
**The question:** filing a 310-clip batch creates **211 ledger projects**, because a project is a
SHOOT (subject + date) — which you chose deliberately, and which is right: `vlog` alone covers 129 of
your clips, so grouping by subject alone would teach the ledger one entry for your whole archive.

But Home's payoff counter says "N clips in M projects", and "310 clips in 211 projects" reads like
something went wrong, when in fact it is 211 real shoots.

**Why it needs you:** the data model is correct and I am not proposing changing it — I tried, and
your own note in `test/subject-groups-by-shoot-date.test.mjs` stopped me, correctly. This is purely
what the counter should SAY.

**What I did in the meantime:** nothing. The counter is unchanged.

**Options:** (a) leave it; (b) count distinct top-level folders instead — "310 clips in 6 projects";
(c) say "shoots" rather than "projects" — "310 clips across 211 shoots", which is what it means.

**Measured for context:** 310 clips → 7 folders on disk, 211 ledger shoots, 8 seconds, 0 errors,
0 decisions required from you.

## Answered

_(nothing yet)_
