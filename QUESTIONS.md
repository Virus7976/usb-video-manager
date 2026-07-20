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

---

## Answered

_(nothing yet)_
