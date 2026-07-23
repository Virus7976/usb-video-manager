# What this app should be able to do

The capability list, and the roadmap. Jake asked for "100 things the app should be able to do…
build it as a feature into everything… like the android app. I would like it to have full
functionality once released."

Two words in that shape everything below:

- **"into everything"** — a capability is not done when the desktop can do it. Each item names the
  surfaces it must reach: **D** desktop · **P** phone · **B** backend/API. A capability that only
  works in one place is *partial*, and is marked so.
- **"full functionality"** — the phone is a full client, not a companion. His own Android app
  (Gourgess Lawns) is the bar he set: offline-capable, queue-backed, and able to do the real job
  rather than view it.

⚠ **Statuses are only as good as the last probe.** Three entries have been found wrong by probing:
item 84 (marked `dead`; the capability works two ways), item 89's ffmpeg check (reported unreachable;
it is a sibling, not nested), and the headline premise below about competing subjects (they live in
`drafts.json`, not the folder Organize scans). Three others were spot-checked and HELD — items 21 and
24 are correct, and 24 is better than its line describes. **Probe before trusting a status, and
probe before contradicting one.**

**Status is honest, not aspirational.** `done` means it works and has a test. `partial` means it
works somewhere but not everywhere it is listed for. `todo` means it does not exist. Nothing is
marked done because it was written — several things in this codebase were written, shipped, and had
never once run.

## Measured on his real store, 2026-07-20 — the numbers the roadmap has to answer to

    clips known             4594
      named                  331   (7%)
      with people            200
      AI observations       1084
    FILED                      1   ← one clip, out of 4594
    projects in ledger         0
    save points                0
    people enrolled           48   · faces pending 458
    standing rules             2   · AI memories 9 · shoot memory 0

**The pipeline does not complete.** Not "is slow", not "needs more features" — 4,593 of his
4,594 clips have never been filed. Every capability below is worth exactly as much as its
contribution to changing that number.

**And the reason is naming, not filing.** Of 206 named clips there are **112 distinct subjects**:

  * **37 of them (95 clips, 46%) describe the SHOT, not the job** — `talking-head`,
    `talking-head-young`, `talking-head-person`, `person-sitting-couch`, `vlog-young-man`.
    That is the vision model reporting what is on screen. His own note: *the subject is what the
    footage is FOR, not what is in frame.*
  * **20 pairs are fragments of each other** — `car` / `car-driving` / `car-driving-down` /
    `car-parked`; `b-roll` / `b-roll-living` / `b-roll-time`; `vlog` / `bedtime-vlog`.

Filing groups by subject. With 112 subjects for 206 clips and no two agreeing, **there is nothing
to group** — so the destination ladder falls through to `_unsorted` and he files nothing. The
ledger has 0 projects because nothing ever got filed to learn from.

**Conclusion for this list: a controlled vocabulary is not a nice-to-have, it is the unblock.**
Features that add more ways to generate free-text subjects make this worse.

---

## The bar he already set

His Gourgess Lawns Android app is **53,029 lines across 125 files, 46 screens, 33 test files, and
zero TODO/FIXME/HACK comments in the entire tree.** There is no half-built screen in it. When he says
"full functionality once released", that is the thing he means.

Three rules are written into that repo, and they govern this list:

1. **Parity is non-negotiable.** From its `AGENTS.md`: *"The web app and this mobile app are ONE
   product. Any change to user-facing functionality or behaviour must land in both."* Only "pure
   app-side plumbing (offline queue, rendering)" is exempt. He enforces it with a test that parses
   the shipped source of BOTH repos and fails when they drift.
2. **Offline-first is the architecture, not a feature.** Optimistic local write → idempotent queued
   op → automatic drain → reconcile. A cold boot with no signal is fully usable.
3. **Incompleteness must be impossible to ship.** He has a test whose only job is to fail when a
   screen exists that nothing renders — because a hand-maintained list *"looks complete from the
   inside, and nothing tells you what is missing. It was missing nine."*

The queue is where he spends his care, and the four details he got right are the ones to copy:
a lock around the queue file; consume-by-id against a **fresh** read (a stale snapshot silently threw
away everything enqueued mid-drain); a per-op attempt cap so one poison op cannot wedge everything
behind it; and a background outbox of **one file per op**, never a shared list, because two writers
on one JSON file lose writes.

And one distinction he states explicitly, which this app currently gets wrong in several places:
**"offline" and "empty" are different states.** A fetch that failed must never render as "you have
nothing" — *"so a crew member with no signal isn't told their data doesn't exist."*

### What that means for scope here

- **D** desktop · **P** phone · **B** backend. An item is `done` only when it works on every surface
  listed for it, with a test.
- The phone may **exceed** the desktop (camera, GPS, push, lock-screen actions, offline) but must not
  fall **short** of it on anything a user notices.
- Anything affecting only his own data **queues offline**. Anything that leaves the building (an
  upload to someone else, an email) requires a connection and says so.

---

## The 100

**Legend** — surfaces: **D** desktop · **P** phone · **B** backend/API.
Status: `done` (works everywhere listed, with a test) · `partial` (works somewhere, not everywhere)
· `todo` · `dead` (built and shipped, but nothing can reach it).

### A. Get the footage off the device (1–14)

| # | Capability | D | P | B | Status |
|---|---|---|---|---|---|
| 1 | Detect a card the moment it is inserted | ✓ | – | – | done |
| 2 | Pick a drive or folder by hand | ✓ | – | – | done |
| 3 | Notice the card was pulled mid-run and stop cleanly | ✓ | – | – | done |
| 4 | Scan a card for video and stills | ✓ | – | – | done |
| 5 | Find a phone over USB (MTP) and list its albums | ✓ | – | – | done |
| 6 | Fast phone transfer over ADB | ✓ | – | – | done |
| 7 | **Turn fast transfer back OFF** | ✓ | – | – | done (D) — “Turn off fast transfer” on the phone card; there was previously no route back to MTP |
| 8 | Pair a phone wirelessly (QR / manual code) | ✓ | – | – | done |
| 9 | Watch a NAS folder a phone app uploads into | ✓ | – | – | done |
| 10 | **Un-set that watch folder** | ✓ | – | – | done (D) — File → “Stop using the wireless backup folder”; the dialog says nothing in it is deleted |
| 11 | Skip files already pulled from this phone | ✓ | – | – | done |
| 12 | Upload footage from the phone itself, resumably | – | ✓ | ✓ | partial — backend + core done and tested; **no phone UI yet** |
| 13 | Resume an upload the phone abandoned when it slept | – | ✓ | ✓ | partial — same |
| 14 | Ingest what the phone uploaded into the normal flow | ✓ | – | ✓ | done (D) — a Home card brings completed uploads into Uncompressed through `copyFileVerified`, releasing staging only after the copy verifies. Collisions get a new name, never someone else's bytes; a failed copy leaves the upload waiting |

### B. Copy it safely, then clear the card (15–24)

| # | Capability | D | P | B | Status |
|---|---|---|---|---|---|
| 15 | Copy to the intake folder with live progress | ✓ | – | – | done |
| 16 | Cancel a copy without leaving a truncated clip | ✓ | – | – | done |
| 17 | Check free space before starting | ✓ | – | – | done |
| 18 | Verify every copy byte-for-byte | ✓ | – | – | done |
| 19 | Remember what was copied and where it landed, across restarts | ✓ | – | – | done |
| 20 | Mirror to the NAS as a second copy | ✓ | – | – | done |
| 21 | Delete from the card ONLY after re-verifying each pair | ✓ | – | – | done |
| 22 | Resume an interrupted session on next launch | ✓ | – | – | done |
| 23 | Show what is waiting to be dealt with, on Home | ✓ | ✓ | ✓ | partial — desktop only |
| 24 | Never re-import a clip already imported | ✓ | – | – | done |

### C. Name it — and this is where the pipeline actually stalls (25–42)

| # | Capability | D | P | B | Status |
|---|---|---|---|---|---|
| 25 | Structured fields: subject · description · location · date | ✓ | ✓ | ✓ | partial — desktop only |
| 26 | Custom taxonomy fields he defines himself | ✓ | – | – | done |
| 27 | Autocomplete from everything he has typed before | ✓ | ✓ | – | partial — desktop only |
| 28 | **Prune a bad autocomplete entry** | ✓ | – | – | done (D) — a × on the suggestion row, with an inline Undo |
| 29 | ⚠ **A CONTROLLED SUBJECT VOCABULARY** — snap onto known subjects, add deliberately | ✓ | ✓ | ✓ | partial — engine + AI snapping + ask-on-type done (D); phone/backend todo. ⚠ Learning his project FOLDER names was tried and reverted — measured net negative, see below |
| 30 | ⚠ Detect and merge near-duplicate subjects (`car` / `car-driving` / `car-parked`) | ✓ | – | ✓ | done (D) — Edit → “Tidy up subjects…”: 21 merges over 46 clips on his data, save point first, nothing pre-ticked |
| 31 | ⚠ Flag a subject that describes the SHOT not the JOB | ✓ | ✓ | – | partial — done (D): an inline, advisory note the moment he types one; phone todo |
| 32 | Batch-name a selection | ✓ | ✓ | – | partial — desktop only |
| 33 | Find &amp; replace across names | ✓ | – | – | done |
| 34 | Apply one clip's name to everything selected | ✓ | ✓ | – | partial — desktop only |
| 35 | Auto-fill the other chapters of a split take | ✓ | – | – | done |
| 36 | Select a range, a day, or between two clips | ✓ | – | – | done |
| 37 | Jump to the next unnamed clip | ✓ | ✓ | – | partial — desktop only |
| 38 | Live preview of the final filename | ✓ | ✓ | – | partial — desktop only |
| 39 | Autosave drafts continuously, survive a crash | ✓ | ✓ | ✓ | partial — desktop only |
| 40 | Restore what he typed last session | ✓ | ✓ | – | partial — desktop only |
| 41 | Save points he can roll back to | ✓ | – | – | done |
| 42 | **Rename a clip that is already filed** | ✓ | ✓ | ✓ | done (D) — right-click a row in Organize; the metadata record moves with the file (it is keyed by filename) |

### D. Let the AI help, without letting it decide (43–56)

| # | Capability | D | P | B | Status |
|---|---|---|---|---|---|
| 43 | Watch a clip and describe what is in it | ✓ | – | ✓ | done (desktop); backend can trigger — todo |
| 44 | Name from a stored observation, no re-watch | ✓ | – | – | done |
| 45 | Improve existing descriptions | ✓ | – | – | done |
| 46 | Auto-name everything in the background | ✓ | – | – | done |
| 47 | Cancel a run and have it actually stop | ✓ | ✓ | – | partial — desktop only |
| 48 | Ask once per shoot day, then never again | ✓ | ✓ | ✓ | partial — desktop only, and only fires since 2026-07-20 |
| 49 | Learn durable rules from his corrections | ✓ | – | – | done |
| 50 | Plain-English filing rules he can type | ✓ | ✓ | – | partial — desktop only |
| 51 | Remember where a project was filed, and offer it next time | ✓ | – | – | done |
| 52 | Tell him when the AI setup is silently wrong | ✓ | ✓ | ✓ | partial — desktop only |
| 53 | Run the AI on a DIFFERENT machine | ✓ | – | ✓ | partial — endpoint is configurable; 4 known gaps (timeouts, model-store writes, eviction, queue-and-retry) |
| 54 | Queue AI work when the AI box is asleep | ✓ | – | ✓ | todo |
| 55 | **Show which model is resident in VRAM** | ✓ | – | – | done (D) — badged per row in the Model store, and two-at-once is called out (his card is 6 GB) |
| 56 | **Backfill the ledger from his existing library** | ✓ | – | – | done (D) — Edit → Filing & destinations → “Read my Projects folder…”, re-runnable at any time; the health-check nudge only ever fired while the ledger was completely empty |

### E. Faces and people (57–70)

| # | Capability | D | P | B | Status |
|---|---|---|---|---|---|
| 57 | Detect faces across a clip's frames | ✓ | – | – | done |
| 58 | Cluster the same face together | ✓ | – | – | done |
| 59 | Review pending faces and confirm who they are | ✓ | ✓ | ✓ | **done — the one path complete on every surface** |
| 60 | Reject a face / never ask again | ✓ | ✓ | ✓ | done |
| 61 | Skip a face for later | ✓ | ✓ | ✓ | done |
| 62 | Suggest a name from people already enrolled | ✓ | ✓ | ✓ | done |
| 63 | Merge two spellings of one person | ✓ | ✓ | – | partial — desktop only |
| 64 | Rename a person and retag their clips | ✓ | – | – | done |
| 65 | Group shots — name several people on one frame | ✓ | ✓ | – | partial — desktop only |
| 66 | Browse every clip a person appears in | ✓ | ✓ | ✓ | partial — desktop only |
| 67 | Undo a face assignment | ✓ | ✓ | – | partial — desktop only |
| 68 | Put confirmed names into descriptions instantly | ✓ | – | – | done |
| 69 | Apply answers given on the phone | ✓ | – | ✓ | done |
| 70 | Show how many phone answers are waiting | ✓ | ✓ | ✓ | done |

### F. File it into the Projects tree (71–84)

| # | Capability | D | P | B | Status |
|---|---|---|---|---|---|
| 71 | One destination ladder, used by preview and by filing alike | ✓ | – | ✓ | done |
| 72 | Preview where every clip WOULD go, before moving anything | ✓ | ✓ | ✓ | partial — desktop only |
| 73 | Drag clips onto a visual map of the tree | ✓ | – | – | done |
| 74 | Manual placements survive leaving and returning | ✓ | – | – | done |
| 75 | Standing filing rules by keyword, optionally per-day | ✓ | ✓ | – | partial — desktop only |
| 76 | Ask the AI where a shoot belongs, searching the real tree | ✓ | – | – | done |
| 77 | File as a COPY by default, never a move | ✓ | – | – | done |
| 78 | Refuse to move footage off a removable volume | ✓ | – | – | done |
| 79 | Embed metadata into the file (XMP, sidecar fallback) | ✓ | – | – | done |
| 80 | Mirror the filed copy to the NAS | ✓ | – | – | done |
| 81 | Export a Resolve-compatible CSV | ✓ | – | – | done |
| 82 | Undo the last filing run, including the ledger | ✓ | ✓ | – | partial — desktop only; single run deep |
| 83 | File one clip immediately, without a batch | ✓ | ✓ | – | partial — desktop only |
| 84 | **Read filed metadata back** | ✓ | ✓ | ✓ | done — verified by probe on all three routes: Organize hydrates the saved record onto each row (`matchType: 'saved'`), Ctrl+K finds a filed clip by its description, and the backend reads the same store via `core/store-read.js`. The `finalMeta:get` IPC has no APP caller and is kept only as an e2e test seam — the capability was never the thing missing |

### G. Compress (85–89)

| # | Capability | D | P | B | Status |
|---|---|---|---|---|---|
| 85 | Hand off to a watch-folder tool (Tdarr) | ✓ | – | – | done |
| 86 | Encode locally with ffmpeg + presets | ✓ | – | – | done |
| 87 | Reject a short encode even when ffmpeg claims success | ✓ | – | – | done |
| 88 | Cancel an encode and kill the process tree | ✓ | – | – | done |
| 89 | Tell him ffmpeg is missing instead of failing silently | ✓ | ✓ | ✓ | partial — desktop only (added 2026-07-20) |

### H. Find it again (90–95)

| # | Capability | D | P | B | Status |
|---|---|---|---|---|---|
| 90 | Search clips by name/subject on the current screen | ✓ | ✓ | ✓ | partial — desktop only |
| 91 | ⚠ Search the whole LIBRARY, not just the loaded screen | ✓ | ✓ | ✓ | partial — done (D) via Ctrl+K over all 4,594 records (`core/library-search.js`, shared with the backend); phone client still todo |
| 92 | Browse the projects index with AI summaries | ✓ | ✓ | ✓ | partial — desktop only |
| 93 | Find clips by who is in them | ✓ | ✓ | ✓ | partial — backend query exists; no search box |
| 94 | Thumbnails and inline playback | ✓ | ✓ | ✓ | partial — desktop; phone shows face crops only |
| 95 | Pop-out grid wall of every clip | ✓ | – | – | done |

### I. Keep it working (96–100)

| # | Capability | D | P | B | Status |
|---|---|---|---|---|---|
| 96 | Setup wizard on a fresh machine | ✓ | ✓ | – | partial — desktop only |
| 97 | In-app changelog, readable offline | ✓ | ✓ | – | partial — desktop only. His Android app ships an 81 KB offline changelog |
| 98 | Auto-update, with a manual check | ✓ | ✓ | – | partial — desktop only; unsigned (see Q8) |
| 99 | Activity/issue log he can read and copy | ✓ | – | – | done |
| 100 | ⚠ **Offline-first everywhere** — optimistic write, idempotent queue, auto-drain | – | ✓ | ✓ | partial — the face queue does this properly; nothing else does |

---

## What this list says

**5 capabilities are built, shipped, and unreachable** (`faces:image`,
`feedback:list`, `intake:get`, `ai:visionAdvice`, `ai:recallShoot`). He paid for those and cannot use
them. Several are small wiring jobs.

Five came off that list on 2026-07-20 — **7, 10, 28, 55 and 42**. The first three had a shape worth
naming: each was the *off switch* for something the app could only turn ON. Fast transfer, the wireless backup
folder, a remembered autocomplete value. A feature is not finished at the point it can be enabled,
and a reachability test that only asks "does a handler exist" will never notice, because in all three
cases the handler was there and correct.

**The phone is at ~10% of parity.** Exactly one workflow — the face review — is complete on every
surface. His own parity rule says that is not "released".

**And #29 is the one that matters.** Every filing capability in section F is correct and tested, and
files nothing, because 112 competing subject names mean nothing groups. A controlled vocabulary is
not feature 29 of 100 — it is the precondition for the other 99 mattering.

**2026-07-22 — a measured failure worth recording.** The vocabulary is built from `config.subjects`
+ drafts + `finalMeta`: three stores the app wrote, mostly the AI. His hand-made project folders
looked like the one subject vocabulary he authored himself, so the ledger was wired in as a fourth
source. Measured against his real tree (51 records, 764 clips):

    drafts (112 subjects)  ->  91 groups empty ledger  ->  91 groups populated.  No change.
    backlog (8 subjects)   ->   8 groups empty ledger  ->   8 groups populated.  No change.
    subjects whose canonical CHANGED: 2, and BOTH were wrong —
        vlog-footage -> 2026-06-11-vlog-footage-from-gopros-v1   (a folder named after a CLIP)
        timelapse    -> 05-timelapse                             (numbered scaffolding)

**Reverted.** A real Projects tree is workflow scaffolding, not a subject list — his folders include
`V5`, `Final Videos`, `In Progress`, `Day 1`..`Day 5`, `B-Roll`, `raw footage`,
`tdarr-workDir2-B73eb1-hG`. And it could not have helped regardless: canonicalisation runs only at
AI-name time and on-type, while nothing in `destinationParts`, `finalize:run` or `projects:move`
calls it — so his already-named backlog never passes through it at all.

**#56 was kept**, because the ledger's real consumer is PLACEMENT (`ledgerMatch`, same-shoot recall),
and it was reachable only through a health-check prompt that fired while the ledger was empty.

**And the bigger correction: the premise above is wrong for the footage that is actually filable.**
The 112 competing subjects live in `drafts.json` — clips still on cards. The 310 clips in
`02 - Compressed`, which is what Organize scans, carry **8 distinct subjects**. Driven end to end
against his real layout: `finalize:run` moved 309 clips into 47 folders, 0 errors, 12.3% to
`_unsorted`, 0 to the root, and the re-run was idempotent. **Filing is not blocked by the
vocabulary — it works.** What blocks it is that he has never opened the Organize screen: 1,487
clicks over 14 days, 0 on `finalize`, because `session.view` resumes him into the phone flow and the
"ready to organize" card sits third on Home behind 458 faces and 700 phone videos.
