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

