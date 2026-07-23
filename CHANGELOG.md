# Changelog

All notable changes to this project are documented here. Keep this updated alongside
[`AGENTS.md`](AGENTS.md) on every meaningful change.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### You set your Projects folder, and filing said you hadn't (2026-07-23)

"Where filed footage goes" was stored in two different settings, and setting one didn't set the
other. Every route that asks you to point at your projects — the AI health card, the setup wizard,
Settings — writes one of them. **Filing read only the other one.**

So you could point the app at your Projects folder, press the button that finishes the job, and be
told *"No destination folder set — choose one in Edit → Organizing & folders…"*. You'd already said
where. It just asked in a different place.

Filing now uses your Projects folder when no separate destination is set. If you *have* deliberately
pointed filing somewhere else, that still wins.

### The Organize screen opens with your footage in it (2026-07-23)

If you hadn't explicitly picked a Compressed folder, Organize opened **empty** — even when the app
could see your clips perfectly well. Three separate places each worked out where your footage lives,
and only the deepest one knew how to fall back; the screen gave up before asking it.

They all use the same answer now, so the Home card, the screen it opens, and the run agree.

### Filing is the first thing Home offers you (2026-07-23)

Your interaction log covers 1,487 clicks over 14 days: 226 face confirmations, 354 typed fields,
48 "Select all" — and **zero** visits to the Organize screen. Not few. None.

Meanwhile filing works. Driven directly against your real layout it moved 309 clips into 47 folders
with no errors. The back half of this app is correct and you have never been on it.

Part of the reason: "footage ready to organize" was the **third** card on Home, behind 458 pending
faces and 700 staged phone videos. Both of those are preparation. Filing is the payoff. Putting
preparation first is how you end up doing 267 face decisions and filing nothing.

It's first now. It still only appears when there's actually something to file.

## [0.6.1] — 2026-07-23

### The phone backup told you it worked when videos hadn't moved (2026-07-23)

Two related problems in the phone flow, both of which made a partial failure look like a success.

- **"Send to Uncompressed" reported a tick regardless.** If some videos failed to move, it said
  "2 videos → 01 - Uncompressed ✓", cleared the pending list and **hid the Send button** — so the
  failed ones were stranded in `_Phone Video Temp` with no way to retry them for the rest of the
  session. It now says how many couldn't be moved, keeps them pending, leaves the button, and logs
  it. Stopping it yourself is reported as stopped, not as an error.
- **"N videos named & staged" counted videos that were never renamed.** The count was taken before
  the rename ran, so a clip whose rename failed was counted as staged and pointed at a filename that
  didn't exist. Only the ones that really got their name are counted now, and the rest are called out.

### It'll tell you when no vision model is selected (2026-07-23)

If you had a vision model installed but hadn't picked one, AI naming would quietly describe nothing —
and the health check said everything was fine. It now flags it with a one-click fix. This mostly
matters on a fresh machine.

### Internal

The check that's supposed to catch unreachable code had a blind spot: it read the source with a
pattern that missed six handlers, which turned out to be dead legacy code. It now inspects the
running app instead, and those six are gone.


## [0.6.0] — 2026-07-23

### Your own filing rules were about to fork your Projects tree (2026-07-23)

Both of your standing filing rules point at `2026/2026 - Client Work/Gourgess Lawns`, while your
Projects folder is already `...\02 - Projects\2026`. So filing would have built
`...\2026\2026\2026 - Client Work\...` — your year folder twice — right beside the real one.
**117 of your 309 clips** would have gone there, and the other 154 would have created loose folders
(`vlog/`, `pov/`, `delete/`) in your year root.

That's the app's fault, not yours. The rules picker offers folders relative to your Projects folder,
so `2026/...` was correct when you saved those rules — then a health-card button moved your Projects
folder one level deeper and nothing rechecked the rules.

Filing now lands in the folder you actually have. And **Settings → Folders & setup** shows every rule
with its real status and a one-click fix, so the stored rule stops saying something untrue.

### Nothing gets filed loose into the top of your Projects folder (2026-07-23)

A clip with no destination was copied straight into the root of your Projects tree and reported as
filed. It's now reported as skipped, with the reason, and left where it was.

### A face you named on your phone can't be lost any more (2026-07-23)

If `people.json` couldn't be read on launch, applying phone answers marked them applied, marked the
cluster reviewed, and enrolled nobody — destroying the answer in all three places at once. It now
refuses and keeps your answers for the next launch.

### Organize works on a fresh install now (2026-07-23)

If the app didn't already have your exact folder setup — `01 - Uncompressed`, `02 - Compressed`, a
Tdarr hand-off — the Organize screen just said **"No folder chosen"** and stopped. Everything after
importing was gated on a layout only you have.

Now it looks in the obvious place instead: your saved folder if you set one, otherwise your
Compressed folder, otherwise the Uncompressed folder your imports land in. It tells you which one it
picked, so you're never quietly looking at a different folder than you think.

**This is also why your 203 photos were invisible.** They live in `01 - Uncompressed`, photos never
get compressed, so they never reach `02 - Compressed` — and Organize only ever scanned Compressed.

### Save your setup as a preset, and share it (2026-07-23)

**Edit → "Save this setup as a preset…"** writes a file describing *how you work*: your folder
shape, your filing rules, your AI settings, your custom fields. **"Load a preset…"** opens one.

It's safe to send to someone. It carries **no folder paths** (they'd name your drives and your
Windows username), and **none of your data** — not your people, your faces, your subject list, your
typed names, or anything about your library. What it does carry is your filing rules, and a rule
needs its folder name to mean anything, so your project folder names travel with it. Worth knowing
before you send one to a client.

Loading one **shows you every setting it would change before anything changes**, and says plainly
that your footage, folders, people and typed names aren't touched. A preset also can't set a folder
path even if someone edits the file by hand — it simply isn't allowed to, and it tells you what it
ignored.

## [0.5.0] — 2026-07-22

### ⚠ The AI was naming your clips and throwing the name away (2026-07-22)

This is the big one, and it explains the number that has bothered you most.

Your library has 4,594 clips and 331 named. **1,084 of them have been watched by the AI** — it loaded
the footage, looked at it, and wrote down what it saw. 716 of those clips have a completely blank
name. Not a bad name. Blank.

The naming step had two routes: an older one, and a newer one that uses a second model to pick from
subjects you already use. The newer route switched itself on as soon as you had a suitable model
configured, and it worked — it produced the right subject and description every time. Then it handed
the answer to a function that had never been connected to anything. **Every name it generated was
computed correctly and discarded.**

- The run then told you it had named them.
- Because a clip only counts as "analyzed" once it has both a subject and a description, none of
  those clips ever counted as done — so the **next** run watched them all over again. That is where
  your GPU time has been going.
- Every name generated since roughly 2026-07-14 was lost this way. Your 331 named clips are the ones
  named before it.

Fixed. The names now land on the clips. If you re-run analysis on the blank ones, they will keep
their names this time — the observations are all still saved, so it does not need to re-watch them.

### One click could shrink the app's memory of your projects (2026-07-22)

"Read my Projects folder" (and the older prompt that offered the same thing) was written to only ever
*add* to what the app knows. It did — and it also quietly trimmed everything already there, because
it used different limits from the code that writes that memory normally.

On a project the app had filed 60 clips into, one click removed 16 subjects, 36 shoot dates, and 52
of the 60 stored descriptions. **The dates are the ones that hurt**: matching a new card against the
dates of past shoots is how the app knows where a shoot belongs, and you shoot in batches, so that is
its best signal. Trimming to the most recent 24 days meant re-importing anything older matched
nothing at all.

Nothing on your disk was ever touched — this was the app's own memory of your tree, and re-running
the read rebuilds most of it. Both writers now use the same limits, and re-running it is a genuine
no-op rather than something that quietly costs you a little each time.

### You can re-read your Projects folder whenever you like (2026-07-22)

**Edit → Filing & destinations → "Read my Projects folder…"** — new, and re-runnable any time.

The app keeps a memory of the projects you have filed into, and it uses that memory to work out
where a new card belongs: it matches the dates on the new shoot against the dates of shoots you have
filed before. Since you shoot in batches, that is its single best signal.

Previously the only way to build that memory was a prompt inside the AI health check, and it only
appeared while the app knew about **zero** projects. One run closed the door for good, and every
folder you added afterwards stayed invisible to it.

It reads only: nothing in your tree is moved, renamed or deleted. Re-run it after a batch of filing
and it tells you either how many new projects it found or "already up to date" — it will not claim
to have done work it did not do.

**Tried and pulled back out:** the same change also made your project folder names feed the subject
list, so a new clip could snap onto a folder you already had. Measured against your actual tree it
changed nothing at all (91 groups before, 91 after) and got two subjects *wrong* — `timelapse` became
`05-timelapse`, and `vlog-footage` became `2026-06-11-vlog-footage-from-gopros-v1`. Your Projects
tree is a workflow (`V5`, `In Progress`, `Day 1`, `raw footage`), not a list of subjects. Removed
rather than patched, and there is a test carrying those numbers so it does not come back.

### The reason almost nothing gets filed (2026-07-20)

Your library has **4,594 clips. 331 are named. One is filed.** Here is why, and what changed.

Filing groups clips by their subject. You have **112 different subjects across 206 named clips** — so
almost every clip is in a group of one, no group is ever big enough to be worth filing, and everything
falls through to "unsorted". `car`, `car-driving`, `car-driving-down` and `car-parked` are four names
for one thing. Nothing was ever going to file.

- **New names now snap onto ones you already use.** When the AI suggests `lawn-mowing-dennis-yard` and
  you already have `lawn-mowing`, it uses yours. A genuinely new shoot stays new — it only snaps when
  it is confident, and it never touches a subject you typed yourself.
- **When YOU type a variant, it asks.** "You typed `lawn-mowing-dennis`. You've already used
  `lawn-mowing` on 12 clips — use that instead?" with **Keep mine** as a real answer. It will never
  rename your work without asking.
- **Edit → "Tidy up subjects…"** cleans up what is already there. It shows every proposed merge with
  the exact clip counts, **nothing is pre-ticked**, and it takes a save point first so Edit → Version
  history undoes the whole thing. On your library it offers 21 merges covering 46 clips.

**Being straight about the limit:** 33 of your subjects (90 clips) are things like `talking-head`,
`person-sitting-couch` and `vlog-young-man`. Those describe what is *on screen*, not what the footage
is *for* — and no merge fixes that, because they are the wrong kind of name rather than a misspelling.
The tidy screen lists them so you can see them, and the app has stopped generating more of them, but
renaming those 90 is a judgement only you can make.

### Also fixed

- **Phone footage had no thumbnails at all.** Your log had 3,648 blocked requests — the folder phone
  videos are staged in was never on the allowed list, so every preview image silently failed. You have
  been naming phone clips blind.
- **An AI run could write its results onto a different card's clips** if you went Home and scanned
  another card while it was still going.
- **A name typed within a second of swapping cards was silently lost.**
- **"Follow AI ↓" secretly un-cancelled a run you had just cancelled.**
- **Analyze and Improve could run at once** and fight over the same clips.
- The app now tells you when **ffmpeg is missing** instead of silently producing no thumbnails and no
  clip durations.


### Fixed — two features that had never once worked, and the screens that misled you (2026-07-20)

- **Confirming a face didn't tag any clip you'd already filed.** The face review sends one kind of ID
  and the filed-clip metadata is stored under another, and the code that was supposed to bridge them
  couldn't — every comparison came back false. So the half of that feature meant for footage you'd
  already organized was dead code. Fixed, along with Undo, which had the same gap and would otherwise
  have left a name stuck on a clip with no way to remove it.
- **The "what was this shoot?" question could never appear on the Organize screen.** It looked for the
  date in one place; that screen keeps it in another. So it always found nothing and quietly gave up.
  That's why the app never remembered anything you told it about a shoot day — the feature was built
  and wired and had simply never run. Answering now also actually saves, which it didn't before.
- **The Organize map threw away clips you placed by hand, and then filed them somewhere else.**
- **A photo that copied off your phone perfectly could be deleted** when two photos shared a filename.
- **Group shots could overwrite each other** when two clips had the same name and size, deleting one
  of them and its picture — and naming a face in the survivor tagged the wrong clip.
- **Cancelling an analyze threw away the faces it had just found**, while marking those clips done.
- **Confirmed faces were the first thing deleted** when the app trimmed old data.
- **Merging two spellings of one person destroyed some of their faces.**
- **Faces you'd dismissed kept coming back** on the two screens you actually use.

### Changed — the app now says one thing consistently

- **"Cancel" on the naming screen no longer walks out mid-copy without warning.** Every other screen
  asked; this one didn't.
- **Clicking an SD card in the device list now opens it**, like clicking a phone always did.
- **One name for the Uncompressed folder** — it had four — and one story about compressing, which had
  three, including two apps this app never opens.
- **The phone screens stopped talking about your card.** They said your originals were "safe on the
  card until Step 3" — the files were already on your computer and Step 3 didn't exist on that flow.
- **The Done screen points at the thing it tells you to do next.** "Organize & back up" was the
  faintest button on screen while "Close" — which only hides the window — was the loudest.
- **The menus stopped disagreeing with themselves.** The Phone screen had no menu entry at all,
  Settings listed its own contents next to itself, and two menus offered the same thing under
  different names.
- **Screens can't stack on top of each other any more.** Clicking the copy indicator from the Organize
  screen used to draw both at once.


### Fixed — where your clips go, and the photos coming off your phone (found 2026-07-20)

Six audits ran over the app in parallel. These are the ones that were actually costing you work.

- **The Organize map threw away every clip you placed by hand — and then filed them somewhere else.**
  Drag clips into projects, press Back, and the map quietly rebuilt itself from the AI's plan. That
  alone would be annoying. The real problem: Run files by whatever the map last published, so after
  pressing Back it filed your footage to the *automatic* destinations while the screen had been
  showing yours. Same thing happened if you toggled "Organize" or "Keep the originals". Where you put
  a clip now sticks, and it wins over anything the planner suggests.
- **A photo that copied off your phone perfectly could be deleted.** Phones routinely hold two photos
  with the same filename in different folders (one in Camera, one in Pictures). The app correctly
  saved the second as "IMG_0001 (1).jpg" — then went looking for it under the original name, found
  the *first* photo instead, decided it was the wrong size, and deleted it. The photo was gone from
  the import and the good copy was left orphaned. The same mix-up also made one of the two vanish
  from the counts, and stopped a genuinely failed photo from being retried.
- **Confirming a face didn't count as work, so it was the first thing deleted.** On your library
  that's 200 clips where the only thing recorded was who's in them — and that was exactly what the
  cleanup threw out first.
- **Merging two spellings of the same person destroyed some of their faces.** Merging kept fewer
  faces than every other part of the app, so combining a "Sara" and a "Sarah" who were both properly
  trained could silently drop 20 faces you'd confirmed by hand. Fixing a duplicate made that person
  *harder* to recognise.
- **Faces you'd dismissed kept coming back.** The "don't ask me about this again" rule was only
  applied on one of the two scan paths — and the path missing it is the one behind the Organize and
  phone screens, so on the screens you actually use, dismissed faces returned on every scan.
- **Cancelling an analyze threw away the faces it had already found**, while still marking those
  clips as scanned — so they were skipped forever after.
- **The app claimed success when nothing worked.** "Filed 12 clips ✓" when all 12 failed, and
  "AI auto-enhance complete ✓" even when you pulled the card mid-run. Both now say what actually
  happened.
- **After a phone pull, AI questions were never flagged on any clip** — the toast said three were
  waiting and no clip was marked, so there was no way to reach them.

### Fixed — the names you type and the faces you train (found 2026-07-19)

These are the ones worth reading. Each was silently losing work you'd already done.

- **Typed names were being deleted every time the app started.** Your drafts were capped in two
  different places with opposite rules: one kept the names you'd typed, the other threw them away
  by age alone and kept ten times fewer. So every launch undid what the previous session had
  deliberately kept, and a recent face scan could evict a name you'd hand-typed weeks earlier. With
  ~4600 clips on a card that was thousands of names. There is now ONE rule, and a typed name always
  outranks an automatic flag.
- **Drafts were never cleared after a copy, so a card kept re-offering names you'd already dealt
  with** — and the leftovers counted against the cap forever, pushing out names still waiting to be
  used. (The clear was looking for them under the wrong key, so it silently matched nothing.)
- **Every enrolled face crop could be deleted in one go.** The cleanup that removes unused face
  pictures didn't load your people first, so it saw zero faces in use and deleted all of them. Your
  people list survived, pointing at pictures that no longer existed — broken images everywhere, with
  no way back. It now refuses to run at all unless it can see the full picture.
- **Undo on the face review didn't undo the training.** Naming a face teaches the recognizer
  permanently, and Undo only removed the tag — so a mis-named face stayed learned as that person,
  was re-suggested on every later scan, and "Confirm all" would then spread it. Undo now reverses
  the training too, precisely, without touching faces you enrolled earlier.
- **"Ignore this face" said it could be undone and couldn't.** It removed the face from the person
  and kept no record of where it came from, so nothing could put it back — the person quietly lost a
  confirmed face forever. Restoring now actually restores.
- **Deleting a person left their name on every clip you'd already filed**, which then got written
  into the files themselves at the next organize and fed back into the AI's naming. Deleting now
  offers to clear the name from stored clips, the way renaming already did.
- **The AI could throw away almost everything you'd taught it.** A background tidy-up of your
  preference rules had no lower limit, so it could replace twenty rules with one and save that. It
  now refuses any collapse that drastic, keeps what you taught it *while* it was thinking, and saves
  a copy of what it replaced.
- **Undoing an organize left the clips marked as filed**, so their AI descriptions became eligible to
  be cleaned up — and once cleaned up, those clips could never be organized again.

### Fixed — the app telling you the truth

- **The app could accept work all evening that it was unable to save.** If a data file couldn't be
  read at startup it correctly refused to overwrite it — then kept showing a ✓ on everything you
  typed, and lost the lot on restart. It now tells you, once, that nothing can be saved.
- **"Filed 0 into your Projects tree ✓"** — the map's Apply reported a refusal as a completed run,
  with a tick, and closed. It now shows the actual reason (card as destination, disk too full).
- **Clips filed without their metadata said nothing.** If embedding failed, the clip was filed and
  counted as a full success. You're now told, and the metadata is written to a sidecar file beside
  the footage instead of being lost.
- **"🧠 AI learned N things from your edits" appeared even when the save had failed** — so you'd stop
  correcting it while it had learned nothing.
- **A face that failed to enrol still showed a green ✓ "tagged" card.**
- **A face scan whose card was pulled marked every remaining clip "scanned, no faces" — permanently.**
  Those clips were then excluded from every future scan. It now says the card may have been
  disconnected, and leaves them scannable.

### Fixed — your photos (they were second-class)

- **Photos on your card were being written to before any copy existed.** The AI's record was embedded
  straight into the original still, on the card, while it was the only copy — something never done to
  a video. Photos are now staged off the card first.
- **Card photos were never backed up to your NAS**, even with NAS backup switched on, because they
  used a different setting buried in the phone preferences. Every video went; not one photo did.
- **A NAS that had gone offline silently disabled the second copy and reported a clean import.** You
  could then clear the card believing two copies existed. It now says plainly that the card has one
  copy.
- **Photos had no "will this fit?" check anywhere**, while videos had two — and a photo fans out to as
  many as five places.
- **Re-inserting a card re-offered and re-copied every still**, because photos were never recorded as
  imported.

### Fixed — smaller, but real

- **The organize map's "not enough room" check could never actually fire** — it was reading a size the
  caller never sent, so it silently passed everything.
- **Starting a second face scan while one was running could erase the first one's review.**
- **The project memory was written after the Undo button appeared**, so a quick Undo left a phantom
  project that kept influencing where future footage was filed.


### Fixed — your footage (the important ones)
- **Cancelling a copy could leave a broken clip in your intake folder, under its real name.**
  Stopping a copy part-way left the half-copied file sitting in `01 - Uncompressed` looking like a
  finished clip — Tdarr would compress it, and it would be filed into your Projects tree as the good
  copy, while the card was cleared anyway. The same cancel also left the app convinced a copy was
  still running, so every later copy was refused with *"A copy is already running"* until you
  restarted. Copies are now written to a staging file, flushed, **checked against the card**, and
  only then given their real name — so a file in your intake folder is always a complete, verified
  copy, and a cancelled one leaves nothing behind.
- **A copy is now verified as it lands, not just before a delete.** A flaky card read or running out
  of disk space could produce a short file that looked complete. It's checked immediately.
- **An interrupted compression could pass as finished.** If the app was closed (or crashed) mid-encode,
  the partial video was left where a completed one would be — and the next run skipped it as "already
  done" and filed it into your archive. Encodes are now staged and only promoted once ffmpeg finishes.
- **A cancelled or failed copy no longer forgets the clips that DID copy.** They were dropped from the
  app's memory even though they were safely on disk, so you couldn't clear them off the card, and the
  next run copied them again alongside the originals as duplicates.
- **Backing up a phone could silently overwrite a clip you'd already staged.** A second batch that
  produced the same name renamed straight over the first. It now files the new one alongside instead.
- **Very long names, and names like `CON` or `AUX`, no longer break the copy.** They're clamped and
  escaped, so a long AI description can't fail every clip in a batch.

### Fixed — batch renaming
- **Batch apply no longer stamps one date over every clip.** Simply ticking clips filled the batch
  date in from the first one, and applying it then overwrote every other clip's real capture date —
  and locked it, so it could never correct itself afterwards. On a card with two days of footage, the
  older day was silently re-dated. A shared date is now only filled in when the clips *already* share
  one; otherwise every clip keeps its own.
- **The row "apply to all ticked" button no longer wipes descriptions.** It copied every field
  including the empty ones, so pushing a subject out from a row with no description blanked the
  description and the category/project on all the ticked clips — including ones the AI had written.
- **"Select all" now means the clips you can actually see.** With a filter on (e.g. *Unnamed*), it was
  ticking the hidden clips too — so a batch edit silently overwrote clips you'd already finished.
- **A filter left on from a previous card no longer hides the next card's clips** (which could make
  the list come up empty and look like the scan had failed).
- **Restoring a save point now restores everything it saved** — people, tags, the "faces scanned" flag
  and the project match. They were in the snapshot but never read back, so restoring from *"Before AI
  analyze"* couldn't actually undo what the AI added.
- **Enter works its way through the fields again.** In the batch dialog it applied the batch
  immediately instead of moving to the next field, and in the clip list it dead-ended part-way down
  (or jumped back to the top) whenever clips were grouped by day.

### Fixed — AI analysis
- **Analysis picks up where it left off.** "Only name blank clips" still re-analysed *every* clip and
  threw the answer away, so cancelling at clip 40 of 100 and starting again re-watched all 100.
- **"Reuse earlier analysis of N clips (faster)" now actually does something.** It had no effect at all
  unless multi-pass mode was switched on, which it isn't by default.
- **The review questions survive a restart.** Finishing an analysis with "ask me to confirm" on and
  quitting before reviewing lost every question.
- **"Start over — ignore what's there" can now change a subject.** It never could, so re-analysing
  after a batch rename only ever rewrote descriptions.
- **You can see which clips the AI failed on, and retry just those** — instead of a count in a toast
  and no way to act on it.
- **Pulling the card out mid-analysis says so**, instead of reporting every remaining clip as its own
  separate "took too long" error.
- **Confirming a face is saved immediately** (it could be lost by a crash), and confirming faces on a
  card that came back on a different drive letter now actually tags the clips.
- **Photos get analysed and carried forward too** — they were backed up but their metadata was dropped,
  and they could never be cleared off the card.

### Fixed — organizing
- **"Run" now files clips where the map says.** It ignored the plan entirely and filed by category and
  project — fields that are normally empty — so it moved nothing and reported "0 moved" while looking
  like it had worked.
- **The Organize step has a Continue button.** There was no visible way forward.
- **The options that control Run are visible.** Whether to move files, write a Resolve CSV, or back up
  to a NAS were all decided by controls hidden from view.
- **"Part of an existing project?" is honoured.** The app asked, you answered, and then dropped the
  answer before organizing — so those clips landed in `_Unsorted`.
- **"Apply — file clips" asks first, and offers an Undo** on the spot.
- **Your AI metadata no longer expires.** It was deleted after 180 days (or once 5,000 newer clips came
  along) — while you were still waiting to organize it.

### Changed — startup speed
- **The app no longer loads the 1.3 MB face-recognition engine on every launch.** It was being
  read, parsed and executed before the window even appeared, whether or not you ever opened
  face recognition. It now loads the first time you actually use a face feature.
- **Startup no longer gets slower the more people you tag.** The face database, the AI clip
  observations and the pending-face crops were all parsed from disk before the window existed
  — and the face database grows every time you confirm a face (thumbnails are ~70% of it, and
  a mature library reaches several MB). Those three now load the first time something needs
  them, so launch cost stays flat no matter how large your library gets.

### Fixed — data safety
- **A corrupt `people.json` or `drafts.json` no longer wipes your data.** If one of those
  files was truncated by a crash, a disk glitch, or antivirus holding a lock, the app read it
  as "this user is new", started with an empty face database / no saved renames, and then
  **overwrote the file with that empty default** — permanently. It now detects that the file
  exists but won't parse, runs the session on defaults so the app still works, and *refuses
  to save over it*. Restore the file (or fix it) and the app picks it back up on the spot.
  `config.json` always had this protection; the sidecar stores never inherited it.
- **"Verify copies" now actually verifies the whole file.** It only sampled about 6 MB out of
  each clip (start, middle, end), so a corrupted copy that happened to keep the same file size
  could be reported as verified — and you'd then be told it was safe to clear the card. It now
  hashes every byte of both files, matching the checks already used before a NAS backup or a
  cross-drive move. Expect this step to take longer; it is the step that decides whether your
  originals can be deleted.

### Fixed — phone + AI reliability
- **Phones no longer go silently undetected.** A single unexpected line of PowerShell output
  containing a `{` or `[` (a path like `C:\Users\{guid}\…`, a `[notice]` banner) could make the
  app read the device list as empty — no phone, no error, nothing to click.
- **AI suggestions no longer come back blank because of stray punctuation.** If the model
  ended its reply with an aside containing a `}`, or returned two JSON blocks, the whole
  response was discarded. A reply of literally `null` produced an opaque "AI failed" error.
- **Keyword preview now matches what actually gets written to the file.** The preview listed
  both `Sunset` and `sunset` while only one was embedded, and it hid keywords the file did
  receive.
- **A GoPro clip with unreadable gyro data is no longer labelled "fast action".** An
  undecodable reading fell through to the maximum-motion bucket and fed that to the AI namer;
  it now reports no motion reading at all.
- **Folders named `CON`, `AUX`, `NUL`, `COM1`…** (legacy Windows device names) can now be
  created — previously organizing into one failed with an opaque error.
- An AI-suggested destination folder can no longer contain `..`, so it cannot point outside
  your projects root.
- A non-numeric compression "scale" override can no longer add an unintended ffmpeg filter.

### Added — testing
- **The app now has a test suite** (`npm test`, also wired into `npm run check`): 211 tests
  covering the copy/verify/fingerprint path, naming + metadata embedding, the phone parsers,
  the AI response parsers, and store durability. It loads the real shipping `main.js` in a
  sandbox with a stubbed Electron, so tests exercise the code that actually ships. Test
  footage is generated with `ffmpeg` at run time rather than committed to the repo.

### Added
- **The app reopens exactly where you left off.** Close it mid-job and the next launch
  drops you straight back into the rename/compress flow on that same card, or into
  Organize — no re-picking the drive, and your naming drafts restore automatically. (If a
  card was unplugged in the meantime it lands on Home, where the "footage to deal with"
  banner still surfaces the work.)
- **Continue already-pulled phone media WITHOUT reconnecting the phone.** Once photos and
  videos are pulled, they live locally in the temp folders — so naming, AI analysis and
  the final copy all run off disk, no phone needed. The app now remembers that as a
  resumable session (reopened on launch) and shows a **"📱 Phone media waiting for you"**
  card on Home whenever there are pulled-but-unfinished videos staged — one click drops
  you back into naming them.
- **Pair your phone over Wi-Fi with a QR code — no cable needed.** The phone panel now
  has a **📶 Pair over Wi-Fi (QR)** button that works just like Android Studio: it shows
  a QR code, you scan it on the phone under **Settings → Developer options → Wireless
  debugging → Pair device with QR code**, and the app finds the phone over the network
  (mDNS), pairs, and connects automatically. After that, fast transfers run over Wi-Fi
  and the app silently re-connects to that phone on later sessions. For networks that
  block device discovery there's an **Enter code manually** fallback (type the IP:port +
  6-digit pairing code the phone shows). Pairing sets up fast transfer (ADB) on its own,
  so the whole thing can be done without ever plugging in. Discovery is done in-app across
  every network adapter (so a PC with WSL/Hyper-V/VPN virtual adapters — which make ADB's
  own discovery bind the wrong one and hang — still finds the phone), and the manual
  fallback can take the phone's connect address too, so it works even when Wi-Fi discovery
  is fully blocked.

### Changed
- **AI analysis no longer interrogates you about every subject.** It used to queue a
  "is this a new subject?" confirmation for every clip whose subject wasn't already in
  your history — hundreds of near-identical prompts on a first import. Now the AI's
  subject is simply used (a perfectly good "snow-walking" is the point), with the only
  cleverness being that a new subject snaps onto one you already use when it's the same
  thing spelled differently (snow-walking = snow walking = snowwalking), so your
  vocabulary stays tidy without the nagging. Only a genuinely new top-level *category*
  (a new root folder) still asks.
- **The AI-questions review is one page, not a hundred clicks.** Replaced the
  one-question-at-a-time wizard with a single scrollable panel: named clips to confirm
  (inline subject/description edits), new values grouped by suggestion so one choice fans
  out to every clip that shares it, and learned rules as checkboxes — defaults
  pre-selected, so it's usually a single glance and **Apply**.

### Fixed
- **Your renames can never be silently wiped again (data-loss fix).** Reopening the app
  after naming clips could come back with everything blank. Cause: draft-saving replaced
  each clip's whole saved entry, and a face-scan/reopen write (which carries an *empty*
  subject for clips it hasn't restored yet) counted as "data" and overwrote your saved
  names — and the small 1000-entry cap then evicted named drafts in favour of
  scanned-flag-only ones. Draft saving is now **non-destructive**: a save can add or
  update a name but an empty value can **never** blank a saved one, named drafts are
  **never evicted** to make room for flag-only entries, and the cap is raised for large
  libraries. Plus the app now flushes drafts the instant its window hides/closes.
- **Face recognition no longer guesses.** The matcher was picking the single nearest
  face out of *everything it had stored* — including its own unconfirmed guesses — with
  a loose threshold and no tie-breaking, so it would confidently mislabel a stranger or
  flip-flop between two people. Rebuilt digiKam-style: it now matches **only against
  faces you've confirmed**, takes a **k-nearest-neighbour vote** (one bad crop can't win),
  requires the winner to clearly beat the runner-up (**ambiguity margin**), and — the key
  change — **returns "unknown" when nothing is a confident match instead of pretending**.
  Auto-tagging now fires only on confident matches; anything unsure goes to the Review
  grid for you to confirm. Sensitivity is tunable via `config.ai.faceThreshold`.
- **Face-confirm buttons were unreadable.** "✓ Yes" was crammed into a small round button
  and the label wrapped onto the dark card in near-black text. Yes/No are now proper
  labelled pills.

## [0.4.28] — 2026-07-02

### Changed (reliability — hardening the components under the hood)
- **A stalled or unplugged phone can no longer leave a hidden process running.** When a
  phone transfer is force-stopped (idle timeout or cancel), the app now tears down the whole
  process tree on Windows — previously the helper's own child processes could survive as
  orphans. Same tree-kill now applies to the ffmpeg compress cancel and the drive/ADB scans.
- The phone transfer also gained an absolute 3-hour ceiling as a final backstop, and
  background helpers cap how much output they buffer (can't balloon memory on a runaway
  process).
- Extension matching for phone scans is now escape-hardened, so adding a new video/photo
  format in one place can never accidentally break the scan regex.
- **The anti-regression guard is stronger:** it now tracks each bypass by location
  (fingerprint) instead of a global count, so a newly hand-rolled `spawn`/`copyFile`/`mkdir`
  is caught even if an unrelated old one was cleaned up in the same change.
- Minor: unified a duplicated AI-rules unwrap; menu descriptions honor lazy values.

## [0.4.27] — 2026-07-02

### Fixed
- **Re-tagging people across your clips is now saved.** After renaming/merging a person and
  choosing to re-tag their clips, the updates weren't being written to disk (a regression
  from the settings-file split) and would revert on restart. They now persist correctly.

### Changed (reliability — hardening the components under the hood)
- **Backups are verified more strictly.** A copied/backed-up file is now flushed to disk and
  checked with a **full** content hash (not a sampled one) before it's trusted — this catches
  a mid-file corruption or a copy interrupted by a NAS/USB drop that happens to keep the same
  file size. A failed verify no longer leaves a half-written file behind.
- **Your data can never end up in "no file."** If writing one of the separate data files
  (face data, drafts, etc.) ever failed, that data now stays safely inside the main settings
  file instead of being dropped from both. Settings/data writes are also flushed to disk so a
  power loss can't leave an empty file.
- Removed dead code left over from the settings-file split.

## [0.4.26] — 2026-07-02

### Changed (internal / performance)
- **The app opens and saves much faster, especially with lots of tagged people.** The face
  data (recognition descriptors for the People feature) was by far the biggest thing in the
  settings file — often hundreds of KB — and the whole settings file was rewritten on every
  little change, so each save re-wrote all of it. Face data now lives in its own file
  (`people.json`) and saves on its own, and the AI clip-observation cache likewise. On a
  typical setup the main settings file drops from ~330KB to ~12KB, so ordinary settings
  saves are near-instant. Existing face data migrates automatically on first launch
  (non-destructive — nothing is removed until it's safely moved). Completes the ConfigStore
  split started in 0.4.20.

## [0.4.25] — 2026-07-02

### Changed (internal / maintainability)
- Consolidated 6 copies of the "unwrap the model's rules/memories JSON" logic into one
  `extractRulesFrom` helper, so the exact unwrap guard can't drift between call sites.

## [0.4.24] — 2026-07-02

### Fixed
- **AVCHD camcorder clips (`.mts` / `.m2ts`) on a phone are no longer invisible over USB.**
  The Windows/MTP phone scan had its own hand-typed list of video extensions that had
  drifted out of sync with the app's master list and was missing `.mts`/`.m2ts`, so those
  clips didn't show up at all (the ADB scan already found them). Every scanner —
  Windows/MTP, ADB, and the app's internal checks — now derives from ONE shared list of
  video + image extensions, so a supported format can't be recognized by one path and
  missed by another.

## [0.4.23] — 2026-07-02

### Fixed
- **A phone that stalls or is unplugged mid-transfer can no longer hang the app forever.**
  The MTP (Windows) phone copy could get stuck inside a system call on a disconnected
  phone and leave a background process running with no way out. It now has an idle
  watchdog: if the copy makes no progress for 8 minutes it's stopped cleanly (a
  legitimately slow-but-progressing transfer keeps resetting the timer, so it's never
  interrupted). Built on a new shared `streamSpawn` helper.

## [0.4.22] — 2026-07-02

### Fixed
- **Compressing two clips with the same name but different case no longer risks one
  silently overwriting the other** (or ffmpeg reading and writing the same file). On
  Windows the filesystem treats `Clip.MP4` and `clip.mp4` as the same file; the collision
  check now compares paths case-insensitively (new shared `pathsEqual` helper), so
  same-name outputs are disambiguated correctly.

### Changed (internal / maintainability)
- One `pathsEqual`/`pathKey` path-identity helper now backs the compress collision check
  and the organize "already in place?" check (was two hand-rolled comparisons, one of them
  case-blind).
- Routed 7 more directory-creation sites through the shared `ensureDir` helper (primitive
  burn-down; the guard baseline drops from 12 raw `mkdir` to 5 — the rest are the config
  writers + `ensureDir` itself).

## [0.4.21] — 2026-07-01

### Fixed (data integrity)
- **Backups are now verified before they're trusted.** Every backup copy — the NAS mirror
  at import, the NAS mirror at Finalize, and the flat photo backup to your computer/NAS —
  now copies then **fingerprint-checks the result** (with one automatic retry) before
  counting it as done. Previously the photo backup trusted a copy if the file size merely
  looked right, so a truncated/interrupted network copy could be silently accepted and the
  original later deleted. One shared `copyFileVerified` primitive now backs all three, so
  they can't drift apart (the two NAS mirrors had quietly diverged in how they decided a
  file was "already there").
- **Photo backup no longer reports success when photos failed.** The flat backup returned
  "OK" unconditionally; it now reports the real copied/failed counts and the summary shows
  "N/M photos … ⚠ K failed to copy" so a partial backup can't look complete.

## [0.4.20] — 2026-07-01

### Changed (internal / performance — no behavior change)
- **Config no longer rewrites everything on every save (ConfigStore, step 1).** The big
  append-heavy stores — rename drafts, version save-points, final metadata, and the
  project ledger — used to live inside `config.json`, so a single toggle or a routine
  drafts autosave re-serialized ~400KB+ of unrelated data (slow open, heavy writes). They
  now live in their **own files** next to the config and save **independently**, so a
  drafts save writes only the drafts file. Existing data migrates automatically on first
  launch (non-destructive — nothing is removed until it's safely re-homed). Also collapsed
  two copies of the "reload store fresh from disk" routine into one, removing a subtle
  case where an in-memory edit could be clobbered by a stale on-disk merge. See
  [`DEDUP.md`](DEDUP.md) → Component architecture roadmap (P3).

## [0.4.19] — 2026-07-01

### Fixed (reliability / safety)
- **Phone video back-up now verifies before it deletes.** When a phone video had to be
  copied across drives into the intake folder, the app used to copy then delete the
  original with no check — a truncated copy could destroy the only good file. It now uses
  the same "copy → fingerprint-verify → then delete source" path as the rest of the app,
  so an interrupted cross-drive move never loses footage. (Two spots in the phone copy
  step.)

### Changed (internal / maintainability — no behavior change)
- **De-dup round 4** (see [`DEDUP.md`](DEDUP.md)): collapsed the three remaining
  behavioral-divergence duplicates into one implementation each, keeping the safer
  behavior: (1) the unsafe cross-drive move now routes through the verified move helper
  (above); (2) the two `ffprobe`/spawn "capture stdout" helpers are unified into a single
  `runCapture` with a consistent empty-string "no output" sentinel; (3) the menu-bar and
  right-click **submenu builders** (~55 near-identical lines each) now share one superset
  renderer, so submenu fixes happen in one place.

## [0.4.16–0.4.18] — 2026-07-01

### Changed (internal / maintainability — no behavior change)
- **De-dup rounds 1–3** (see [`DEDUP.md`](DEDUP.md)): single-sourced the video-extension
  list, `addUnique`, `personThumbHTML`, the Ollama endpoint constant, `canon` /
  `phoneVisibleMedia`; replaced five near-identical ffmpeg frame-grab copies with one
  `extractFrame`; and unified the progress-percent math into one clamped `pctOf()`.

## [0.4.15] — 2026-07-01

### Changed (internal / maintainability)
- **`main.js` (5.2k lines) is now split into modules** under `main-mod/` (core, media,
  ai-ollama, routes-ledger, windows-phone, copy-transfer, naming-organize,
  finalize-feedback, ipc-boot), bundled back into `main.js` by the same `npm run bundle`.
  Verified byte-identical to the pre-split file. Both processes are now modular.
- **Design control panel:** one `:root` block now governs corners (`--radius-sm/…/-xl`)
  and motion (`--motion-fast/-/-slow`, `--ease`). ~180 hardcoded corner radii and the
  transition durations were routed through these tokens — so "round every corner" or
  "make the whole app snappier/slower" is now a **one-line change**. (Pills/circles left
  as-is.)

### Changed (internal / maintainability — no behavior change)
- **`renderer.js` is now split into modules** under `src/mod/` (`01-core`, `02-combo`,
  `03-rename`, `04-tasks-ai`, `05-preview`, `06-menus`, `07-organize-map`, `08-people`,
  `09-phone-finalize`, `10-boot`). `scripts/bundle.mjs` concatenates them back into the
  single `src/renderer.js` the app loads (runs automatically before start/dev/check/dist).
  Verified byte-identical to the pre-split file, so behavior is unchanged — this is purely
  to make the code navigable and localize future changes. Edit the module, then it's
  bundled on build. (Module sources are excluded from the shipped package.)

### Changed
- **Subject/description/location dropdowns are now consistent everywhere** and useful
  immediately. All three places (per-clip rows, the command bar, the batch-name dialog)
  now draw from ONE shared suggestion source — values you've used **this session** plus
  your saved history — so the dropdown appears even before you've built up history, and
  the batch dialog can no longer drift out of sync with the rows. (First step of the
  structural cleanup: one source of truth instead of three hand-wired copies.)

### Fixed
- **Phone renames now survive a re-pull / crash.** The phone flow now restores your saved
  subject/description/date/tags from drafts (keyed by filename+size), like the card flow
  already did — so re-pulling the same phone brings back everything you'd named.
- **Pop-out preview / jump-to-clip work again on big rolls.** After windowing, clicking a
  clip (or a thumbnail in the selected strip, or "jump to next unnamed") for a clip past
  the first chunk did nothing — the card wasn't rendered yet. `focusClip` now renders
  ahead to that clip first. (The preview IPC chain itself was verified sound.)
- **"Invert selection" no longer freezes** on big rolls (was O(n²) like Select-all was).
- Videos whose rename fails keep a valid path for analysis/preview (repoint only the ones
  that actually moved).
- The windowed-grid "load more" observer no longer leaks across re-renders.

### Fixed
- **The rename screen no longer crashes or lags on big rolls.** It was building AND wiring
  every clip card (≈3,000 × 6 inputs + comboboxes) at once. Now cards render + wire in
  **chunks of 100 as you scroll** (windowed), so the screen opens instantly and clicks
  stay snappy no matter how many clips.
- **"Select all" no longer freezes/crashes.** It was re-running the batch-bar + rebuilding
  a growing thumbnail strip once per clip (O(n²)). Now it flips all clips in one pass with
  a single UI update, and the selected-clips strip is capped (shows "+N more").

### Notes
- Easy unselect: use the **Clear** button on the selected-clips strip (or the ✕ on any
  thumb). The subject/description dropdown is a learn-as-you-go autocomplete — it shows
  once what you type matches a previously-used value.

### Added
- **Native Windows taskbar progress** — the accent bar now fills on the app's taskbar
  icon during a pull/copy, and the fullscreen focus view has a **real, prominent progress
  bar that fills and "surges"** (shimmer) so how-much-is-left is obvious at a glance.
- **Interaction breadcrumb log** (for this fixing stage): every click + which screen it
  happened on is recorded to `interaction-log.jsonl`, so when something goes wrong we can
  trace exactly what was clicked and where it led.

### Changed
- The idle media grid on the phone chooser **collapses when empty** instead of showing a
  big blank bordered box.
- The **Auto mode toggle** now matches the native WinUI toggle-switch look.

### Fixed
- **Videos no longer land in "01 - Uncompressed" automatically** — they stay in
  "_Phone Video Temp" (renamed), which Tdarr doesn't watch, so it can't start compressing
  before you're ready or with the wrong names. When you're done, a deliberate **"Send N
  videos to Uncompressed"** button on the finish screen moves them over (instant,
  same-drive) — that's the moment Tdarr picks them up. You're in control of when.
- **The pull screen is no longer a blank box.** It now shows a live "Pulling off your
  phone…" state with the running count, and the fullscreen/focus view's **Live Activity**
  feed lists each file as it's pulled (instead of "Waiting for the first step…").
- **Portrait phone videos** fill the thumbnail cleanly instead of showing big black
  side-bars, and **hovering reveals the full frame**. Photos are never cropped.

### Changed
- **Photos AND videos now pull off the phone together, up-front.** The pull step copies
  photos → "04 - Photos Temp" and videos → "_Phone Video Temp" at the same time, so
  everything is local before you batch — thumbnails render, the AI can analyze, and you
  name it all in one place. At the copy step the videos just **move** into "01 -
  Uncompressed" (same drive = instant), instead of the old "videos stay on the phone
  until later" behavior that left them stranded and confusing.

### Fixed
- **Cancel actually cancels now.** The phone pull/copy loops check an abort flag, so
  Cancel stops the (long) video transfer instead of hanging on "Cancelling…". Whatever
  already copied is kept and resumes next time. Added a Cancel button to the pull screen.
- Native-feel polish on the home screen: consistent Fluent card hover/press states,
  tighter section rhythm, and the face option reads as an intentional inline option.

### Fixed
- **No more invisible CPU churn at the batching step.** Auto mode was quietly running the
  AI to pre-name photos with no on-screen indicator (it looked frozen while the computer
  worked). Removed that silent pass — batching stays day-grouped, and the toast now tells
  you plainly: name what you like, then **Continue to copy your videos off the phone**.
- **Clarified that videos copy on "Continue".** Videos stay on the phone (shown as "On
  phone") until you continue — so a huge roll doesn't tie up your phone before you've
  batched. The mechanism is verified (ADB pull works); nothing was broken, just unclear.
- **Bad dates like "2045-49-65"** from long numeric filenames are gone — the date parser
  now skips digit-runs that aren't a real calendar date (month 1–12, day 1–31).
- **Tidier home screen:** the face-scan option only shows when Auto mode is on, and the
  Auto-mode/pending bars are more compact.

## [0.4.6] — 2026-07-01

### Added
- **Auto face-tagging in Auto mode.** After a copy, footage is silently scanned for faces
  in the background. Any face that matches someone you've already named gets tagged onto
  the clip as an **unconfirmed guess** ("Liam?" — dashed chip) — it **never asks you to
  confirm** and never invents names for strangers. Unconfirmed people **still feed the AI
  descriptions** and carry into the metadata, so your footage arrives peopled without a
  single popup. A sub-toggle under Auto mode turns the (CPU-heavy) face pass off.
- **Change a person → offer to re-tag the affected clips.** When you **rename** or
  **merge** a person, the app finds every saved clip (organized + drafts) tagged with the
  old name and asks: *"Re-tag N clips as [new] and update their names/descriptions?"* — yes
  swaps the name everywhere (people tags + inside subject/description text); no leaves them.

### Fixed
- Unconfirmed face guesses (`peopleAuto`) now persist correctly through drafts and
  finalMeta (arrays were being stringified in the finalMeta store).

### Added
- **⚡ Auto mode.** A toggle on the home screen: flip it on, pick your phone, and the app
  runs the whole backup itself — scans, selects everything new/unfinished, pulls it off
  (ADB fast), and stops only at photo batching. Once you've batched and continued, it
  copies to Uncompressed and analyzes in the background on its own. **It never deletes
  anything** — pulling only ever copies off the phone, and Auto mode never touches the
  card-clear/delete step. You always delete manually.
- **Batching is now glance-and-accept in Auto mode:** pulled photos are pre-named by the
  AI (grouped by day) so you just review and continue. Edit any suggestion first.

### Fixed
- **Phone footage now remembers its metadata and gets pre-analyzed.** The phone copy step
  now saves each clip's batched name/subject (keyed by final filename) and runs the same
  background AI analysis the card flow does — so when you later organize, phone clips
  already know their names and where they belong (and count toward the home banner's
  "already analyzed" total). Previously this only happened for SD-card imports.

## [0.4.4] — 2026-07-01

### Added
- **"You've got footage to deal with" on the home screen.** When you open the app, a
  banner now surfaces footage waiting in the Uncompressed intake (still to compress) and
  clips already in the Compressed folder that are ready to organize — with a one-tap jump
  straight into Organize & back up. The per-clip AI analysis is already remembered, so
  nothing re-analyzes. First step toward a frictionless Auto mode: the app remembers your
  in-progress work across restarts and tells you what's left instead of forgetting it.

## [0.4.3] — 2026-07-01

### Added
- **Interrupted backups are now recognized as "to finish".** If a previous session
  pulled photos to Photos Temp but never finished renaming/copying/organizing them,
  those photos are no longer treated as done — they're counted as "to finish" and
  default-selected alongside genuinely new items, so nothing is silently left half-done.
  The summary now reads e.g. "N to back up · X to finish · Y backed up".
- **Already-pulled photos show real thumbnails** in the chooser grid, loaded free from
  their local Photos Temp copy (no phone access). Items still on the phone keep the
  photo/video icon — pulling files just to preview them would defeat the fast workflow.

### Changed
- **Phone videos now stage in a real "_Phone Video Temp" folder** (next to "04 - Photos
  Temp", under your Compression folder) instead of a hidden throwaway OS temp on C:.
  Because that folder is on the **same drive as the intake**, moving a finished video
  into "01 - Uncompressed" is now an **instant rename** instead of a slow full copy —
  and if a video pull is interrupted it **resumes** instead of re-downloading. Videos
  already sitting in the intake at the right size are skipped on a re-run. (The staging
  copy is removed once a video is safely in the intake; the folder itself stays.)
  Real-phone video pulls continue to use ADB fast transfer when it's enabled.

## [0.4.2] — 2026-07-01

### Fixed
- **Phone scan now works when fast transfer (ADB) is on.** Previously only the file
  *transfer* used ADB; the album listing and the "what's new" scan still went through
  Windows MTP. But once USB debugging is enabled the phone often stops exposing MTP to
  Windows, so the app showed "No albums found — Nothing here" even with thousands of
  photos/videos on the device. The scan and album chips now use ADB too (one `find`
  over DCIM/Pictures/Movies/Download with sizes), falling back to MTP when ADB is off.
- Hidden folders (Android's `.thumbnails` cache, `.gs*`, etc.) are excluded from the
  scan, so you're no longer offered thousands of cached thumbnails as "photos".

## [0.4.1] — 2026-06-30

### Added
- **Wireless phone backup (no tethering).** Set a **Phone backup folder** (File → "Phone backup
  folder (wireless)…", or the link on the home screen) — point it at the NAS folder your phone
  auto-uploads to (e.g. QNAP QuMagie/Qfile). It then appears under **Devices** as a one-tap
  source, so wirelessly-uploaded photos/videos flow straight into rename → organize with no
  cable and no phone tied up.

## [0.4.0] — 2026-06-29

### Added
- **Fast phone transfer (ADB).** Phone backups used Windows' MTP, which copies one file at a
  time and can take *hours to days* for a big camera roll. You can now switch on **fast
  transfer**, which uses ADB (`adb pull`) — typically many times faster. In the phone screen,
  tap **"⚡ Turn on fast transfer"**: it downloads the small ADB tool for you (one time); then
  enable **USB debugging** on the phone once (Settings → Developer options) and tap Allow. If
  ADB isn't set up or the phone isn't authorized, it automatically falls back to the old MTP
  method, so nothing breaks.

## [0.3.3] — 2026-06-29

### Added
- **Pick up where you left off.** When you reconnect your phone, photos you'd already pulled
  to your computer earlier are recognized — they're no longer re-offered as "new," so you only
  back up what's genuinely new. The summary shows "N new · M already pulled," and Review still
  lets you re-do any of them.

## [0.3.2] — 2026-06-29

### Clearer / more intuitive
- **AI actions no longer dead-end when AI is off.** Clicking "✨ Suggest with AI", Analyze,
  summarize, etc. without AI set up now opens the "turn on AI / pick a model" helper instead
  of flashing a toast that does nothing.
- Error messages now say "please try again" instead of the scary literal "unknown".
- The destination-map's primary button reads "Pick or type a folder" until you've chosen one
  (instead of a dead-looking "File here →").
- Menus stay open a bit longer so they don't vanish if your pointer drifts.
- The AI-settings close button now reassures that your changes are already saved.

### Fixed
- **Day grouping in the rename grid now shows every clip.** Previously each day header
  showed a count (e.g. "34 clips") but only one clip appeared under it, because the list
  wasn't sorted by day — so the same day repeated all over the list. Clips are now grouped
  by day (newest first), so "34 clips" actually shows all 34 together.

### Performance
- **Faster to open + lighter saves.** `config.json` had grown to ~1.6 MB (thousands of stale
  rename drafts + oversized save-points) and was parsed at launch and rewritten in full on
  every setting change. It's now slimmed and capped, roughly halving what the app loads at
  startup and writes on each save — so it opens quicker and feels snappier.

### Fixed / hardened (from a reliability + security audit)
- **Hung video tools can't wedge the app.** ffmpeg/ffprobe calls (posters, thumbnails, face
  frames, metadata, drive detection) now self-kill if they stall on a corrupt/odd clip,
  instead of deadlocking the preview pipeline or leaking processes.
- **Temp files don't pile up.** The thumbnail/poster scratch folder is cleared on startup.
- **config.json can't bloat unbounded** — the project "memory" ledger (and the AI-memory
  inbox) are now capped like every other store, so saves stay fast over time.
- **No accidental double-copy.** Starting a copy while one is already running is refused
  (it could have corrupted progress/cancel for the first).
- **Phone "what's new" is more accurate** — a video that failed to copy stays marked "new"
  (re-offered) instead of being recorded as backed-up.
- **Security hardening** — locked down window navigation/new-windows (defense-in-depth for the
  local-file viewer); fixed a file-handle leak on copy errors. (Audit found no command
  injection or XSS — the static-PowerShell + escaping patterns hold.)

## [0.3.1] — 2026-06-28

### Fixed
- **Phone scan now actually returns your photos.** The new album-scoped scan was passing the
  chosen albums in a way PowerShell collapsed into a single bogus name, so it matched no folder
  and showed “Nothing here” even for a 2,936-item Camera roll. Fixed the parsing — selecting
  Camera (and any other albums) now scans them correctly.

## [0.3.0] — 2026-06-28

### Changed
- **Phone backup, rebuilt around "what's new".** Connect your phone and it no longer scans
  the entire device or dumps a giant grid. Instead it:
  - **Asks what to back up from** — albums are shown as chips (Camera selected by default;
    Screenshots/WhatsApp/Download/etc. with counts) and it only scans what you pick.
  - **Shows just what's new** — it remembers what you've already backed up (per file) and
    offers a one-tap **“Back up N new”**, so you stop re-copying the same photos.
  - **Review / pick manually** is still one tap away for the full grid.
- **Running backups survive leaving the app.** Pulling/copying off a phone now shows the
  persistent task bubble — leave, come back, and tap it to see progress (no more "lost" task).

### Fixed
- "Select all" on the phone grid already respected the filter (0.2.1); the new chooser
  avoids the giant grid entirely for the common case.

## [0.2.2] — 2026-06-28

### Fixed
- **Phone reading tells "empty" from "couldn't read"** — if the phone is locked, on
  "Charging only", or disconnects mid-scan, you now get a clear "Couldn't read your phone…
  unlock and choose File transfer, then Rescan" message instead of a misleading "no photos".
- **Compression won't clobber same-named clips** — two source files that share a name but
  differ in format (e.g. `clip.mov` + `clip.mp4`) now produce two separate outputs instead
  of one silently overwriting/skipping the other.
- **NAS backup during Organize is verified** — files mirrored to the NAS at the Organize step
  are now content-verified (with one retry), matching the import-step guarantee, so a
  truncated/corrupt backup is never trusted.
- **Card clips date from the filename** — capture date is taken from the filename (how cameras
  name files) instead of the file's modified time, which is unreliable after card copies.
- Minor hardening: drive-polling can't double-start; removed a dead quit-handshake code path.

## [0.2.1] — 2026-06-28

### Fixed
- **Phones now open the device you actually tap** — selecting a real phone (e.g. an S23
  Ultra) no longer jumps to the "Simulated phone (testing)" entry. The simulated phone is
  also now off unless you explicitly turn it on (it was a dev/testing leftover).
- **Slow-to-wake phones are detected** — the phone-detection timeout was raised so a freshly
  plugged-in phone that takes a while to hand-shake over USB still shows up.
- **"Select all" on a phone respects the Photos/Videos filter** — it no longer secretly
  selects hidden items, and the checkbox reflects what's actually visible.
- **Card import is safer** — clips are marked "imported" and their saved names are cleared
  only **after** the copy is verified, so a bad copy is never skipped (or its name lost) on
  the next insert.
- **Photos-only cards can be backed up** — the Copy button is no longer greyed out when a
  card has only photos and no video.
- **"Undo last organize" works from the main Organize screen** — that run now records its
  moves, so you can reverse it (previously only the destination-map flow could be undone).
- **"Check for updates…" always reports back** — a manual check now shows "up to date" / an
  error instead of silently doing nothing.

## [0.2.0] — 2026-06-28

### Added
- **Automatic updates** — the installed Windows app now updates itself: it checks the release
  feed in the background, downloads new versions silently, and installs them when you quit (or
  right away via the tray's **Restart to install update**). No more re-downloading the installer.
- **One-command releases** — `npm run release` bumps the version, updates the changelog,
  syntax-checks, builds the installer, verifies it, tags & pushes, and publishes the Gitea
  release **and** the auto-update feed in a single step (`npm run release:dry` to preview).
- **In-app compression** — ffmpeg transcode (H.264 / H.265 presets) with live per-file
  progress, skip-existing, cancel, and partial-file cleanup. Plus a **compression mode**
  setting: `external` (watch-folder tool like Tdarr — the default, zero local CPU) or `app`.
- **Mega Analyze** — one button does faces → confirm (or 🤖 Auto-faces) → describe → name →
  tag, weaving recognised people into the names and **improving** any name you already wrote.
- **Photos in the AI flow (Organize screen)** — `Include photos` lists/analyzes/files photos
  like clips; face recognition now runs on still images; XMP embedded into JPGs.
- **🎬 Sort with me** — guided organize chat: watch a clip, say where it goes (tap or type),
  and it learns a filing rule so it stops guessing.
- **Global task UI** — a small task bubble → popup → full-screen "theater" with a live
  thumbnail conveyor, a per-step activity feed, ETAs, and cancel.
- **⚡ Quick analyze** — one vision call per subject (copied to siblings); ~minutes instead of
  hours on big batches. Resumable (skips already-analyzed clips).
- **Faces are confirm-first** — recognised faces are suggestions saved unconfirmed to a
  person's profile; you confirm/correct (type a name or tap a suggestion). Never auto-applied.
- **Data safety** — checksum verify before delete, NAS mirror with verify/resume, undo/move-log
  for filing, duplicate/already-imported detection, a session activity log.
- **Phone (MTP) import** — list/scan/copy photos & videos off a phone with no drive letter.
- **First-run setup wizard** (issue #1) — a guided onboarding modal that opens automatically on
  the first launch: point your **intake folder**, **Projects root**, and an optional **NAS
  backup**, pick/enable a local **AI vision model** (with a Browse-&-download shortcut), and run
  a **face-recognition check** — then hands off to the tour. Re-runnable anytime from
  **Help → Setup wizard…**, the Settings hub, and the command palette.
- **Pop-out preview, upgraded.** The preview window now shows **photos** (not just video),
  and gains a **Grid wall** mode: a live wall of every clip in scope (**Selected / All /
  Unnamed**) with an adjustable tile size and optional video playback — made for a second
  monitor, so you can eyeball all the footage on the big screen while you rename on the
  small one. **Click any tile to jump** to that clip on the Rename screen. Mode + settings
  are remembered between sessions.

### Changed
- **Organize, rebuilt as one screen.** The destination map is now a single **Plan** view that
  groups every clip by where it'll be filed, shows **how confident** each placement is and
  **why**, and floats the few it's unsure about into a **“Needs you”** section you fix inline
  (one-tap destination chips + “remember” to make it a rule) — then **File**. The old
  button-bar-of-modals (Sort with me / Suggest with AI / Filing rules / Refine) folds into one
  primary **✨ Suggest with AI** action + a **More** menu, with a **Folders** toggle for the full
  colour-coded tree. Much less “pile of separate features”.
- **Smarter placement.** Suggestions now use your **filing history**: the app remembers every
  project it's filed footage into (people, subjects, places, an AI summary) and both pre-files
  obvious repeats automatically (“matches your *Lawn Mowing* shoot”) and feeds that memory to
  the AI — so it reuses the right existing project instead of guessing from a blank slate.
- **Better destination picks + honest confidence.** When you have many projects, the app now
  shows the AI a **shortlist ranked toward the current batch** (so the right folder is always
  in view instead of buried among hundreds), with a sharper prompt and a worked example. It
  then **calibrates each placement's confidence** from where the clip is actually going —
  brand-new or unclear destinations are marked low and routed to **“Needs you”** rather than
  auto-filed, and clips of the same subject are kept together — so fewer clips land in the
  wrong folder and the ones it's unsure about reliably ask you first.
- **Tool-grade UI polish (in progress).** Settings/Preferences regrouped into clear, consistent
  labelled sections with card bodies and a steady spacing rhythm (no more ad-hoc margins), so it
  reads like a precise settings panel rather than a flat list. (First pass of a wider polish
  sweep across the core screens.)
- Genericised for public use: no baked-in personal projects/clients, defaults derive from the
  OS Videos folder, dev-only phone simulation off by default.
- Renamed the misleading "Compress, Rename & Delete" home action to "Import, Rename & Clear card".
- Suggest-with-AI asks far fewer questions (auto-accepts confident folder matches); typed
  categories autocomplete and register in one step.
- **Teaching a filing rule is now reliable.** When you describe a rule in plain English
  ("vlogs are their own thing, but timelapses go with the shoot"), the app no longer relies
  on an easily-flipped yes/no flag — it reads an explicit choice ("each day = its own
  project" vs "joins the day's project"), so it stops occasionally doing the exact opposite
  of what you said. It also splits a multi-part instruction into separate rules and won't
  treat a bare shot-type word (vlog, b-roll…) as a project folder.
- **Richer searchable metadata.** Filed clips now also get a **Places** tag branch (browse by
  location in digiKam/Lightroom, like People), and tag names containing slashes no longer
  split into bogus tag-tree levels.
- **Calmer, tool-grade motion** — pared back the celebratory/"delight" animation so the app
  reads as a precise utility. Removed the decorative progress-bar shimmer, the breathing
  "glow" pulses, and the sparkle-burst on the done screen; shortened entrances to ~120–200ms
  with standard easing (no bounce/overshoot). The task theater's frame no longer breathes and
  the thumbnail conveyor no longer flings — the moving scanline stays as the "actively
  scanning" signal. Motion now explains state instead of performing. Added full
  `prefers-reduced-motion` support (decorative loops off; functional spinners keep turning).

### Fixed
- **Filing can no longer drop or overwrite a clip.** Two different clips that happen to share
  a name and file size are now told apart by content (sampled checksum) and the second is
  safely versioned instead of being skipped. Cross-drive moves copy → **verify** → then
  delete the original, so a crash or error mid-move always leaves the source intact and never
  leaves a half-written file at the destination.
- **Autocomplete dropdown vanishing in the Name-batch dialog.** The subject/description
  suggestion list depended on a translucent acrylic background + `backdrop-filter`; stacked
  over the batch dialog's own blurred card it hit a Chromium/GPU nested-backdrop-filter bug
  that painted it invisible (it worked fine on the per-clip fields, which have no blurred
  ancestor). The combobox dropdown is now drawn with a solid, opaque surface so it shows
  everywhere.

### Known issues
- Vision models can hallucinate a subject → mis-placement (use 🎬 Sort with me / manual rename).
- Photos not yet in the Step-1 Rename grid ("Path B") — Organize screen only.

## [0.1.0]
- Initial internal build: USB/SD auto-detect, rename grid, copy-to-intake, delete-from-card,
  organize/finalize with XMP embed, local Ollama naming, bundled face recognition.
