# Architecture — the remote/multi-client build

Decided with Jake on 2026-07-20, after a six-agent audit and three research agents. This file is the
plan of record. **Nothing here is built yet.** Work on it starts only after the data-safety backlog
in [`PROMPT.md`](PROMPT.md) §8d is closed — that is his explicit sequencing ("close safety data first
then build new").

---

## ⚠⚠ RULE 0 — BUILD EVERYTHING ON HIS COMPUTER. DO NOT TOUCH THE NAS.

His instruction, verbatim (2026-07-20): **"build everything on my computer. do not touch the nss"**.

That means, with no exceptions and no "just this once":

- **Never deploy, write, install, or configure anything on the NAS** (`192.168.50.137`,
  `jandjnas002`). Not Container Station, not Portainer, not a share, not a config file.
- **No Portainer-redeploy step** in any CI, even though `gour-landscaping`'s workflow has one and it
  is otherwise the right template. Copy the build; drop the deploy.
- Docker runs **locally on his Windows machine** (Docker Desktop / WSL2). The image is something he
  can move to the NAS himself, later, by hand, when he decides to.
- The NAS is reachable at `L:` and `Y:` as a *file destination the existing app already writes to*
  under his control. That is unchanged and is not what this rule is about. This rule is about not
  standing up services on it.
- Do not probe it either. On 2026-07-20 I sent two read-only HTTP GETs to `:8080` and `:5000` to
  identify the model before this rule existed. Nothing was written and nothing changed, but the
  correct behaviour from here is to ask him rather than to look.

The NAS already runs his landscaping stack and other containers. It is production for another
business. Nothing built here goes near it without him doing it deliberately.

---

## What he asked for, in his words

- Confirm faces, answer the app's questions, and upload footage **from his phone**, without being at
  the PC. He locks the phone and walks away mid-upload.
- Ship stock working on one computer, then be **customizable with rules** for his unique setup.
- A **step-list** pipeline UI (explicitly chosen over an n8n-style node canvas).
- **Integrations, specifically running the AI on a different computer.**
- Docker **on his machine**. Moving it to the NAS is his to do later, by hand — see Rule 0.
- Build order: **Docker → exe**, with the Flutter app as the phone client.
- Built methodically, backend first, each feature fully explored, modular, "zero bugs".

## The four answers that shaped this

| Question | His answer | What it forces |
|---|---|---|
| Import with the PC off? | **Phone upload yes, SD cards no** | ⚠ **Conflicts with Rule 0 — see below.** Card ingest stays in the exe regardless. |
| QNAP model | 8-bay, already runs many containers | **Moot — see Rule 0.** Everything runs locally on Windows. Recorded only so a future NAS move is informed. |
| Watching uploads? | **Locks the phone and walks away** | **Flutter is required.** iOS Safari kills backgrounded uploads. Resumable chunked upload on the server. |
| Public domain? | Configure later | Build it to bind locally and work on the LAN. Tailscale/reverse proxy is a later, separate decision that changes nothing above. |

---

## Languages — decided

| Component | Language | Why |
|---|---|---|
| **Shared core** | JavaScript (Node) | It already exists, debugged, with 1349 tests. Extraction, not a port. |
| **Docker backend / API** | Node + Fastify | Same language as the core, so the core is `require`d rather than reimplemented. Fastify for per-route JSON-schema validation — the request contract is declared once and both clients generate from it. |
| **Desktop exe** | Electron + Node — **unchanged** | 11,025 lines of ingest/verify/naming logic and a ~10% documented regression rate on small fixes. Rewriting it in Java (à la imperium-academy-desktop) or Go would re-derive every bug already paid for, including the photo-deleting one fixed 2026-07-20. |
| **Phone** | Flutter/Dart | Forced by background upload. Also matches how he already builds phone apps. |

**No TypeScript.** The 1349-test harness loads the real shipping `main.js` into a `vm` and reaches in
for top-level functions; a compile step between the tests and the shipping artifact breaks that. Use
JSDoc + `checkJs` if type safety is wanted. Revisit if the API passes ~5k lines.

**Two exceptions held in reserve, deliberately not decided now:** Python (InsightFace) only if
unattended *server-side* face embedding becomes a stated requirement — note it would invalidate the
existing 458 face descriptors, which are face-api.js embeddings. ONNX-in-Node is the middle path.

---

## The hard constraints

1. **A Linux container cannot see an SD card in his Windows PC.** `main-mod/05-windows-phone.js`
   (1,408 lines) is PowerShell + Windows Shell COM; drive detection is PowerShell WMI. Card ingest is
   permanently desktop-only. This is why the answer above matters: phone upload over HTTP needs no
   Windows involvement, so no Windows agent process is required.
2. ~~**`main-mod/` has no module boundaries.**~~ **SOLVED 2026-07-20 — this was the largest line item
   in the plan and it turned out to be avoidable.** The bundler only reads `main-mod/*.js`, so a
   separate **`core/`** of ordinary CommonJS modules can be required BY the bundled main.js and later
   by a Node server, with **no restructuring of main-mod at all**. Logic moves across one piece at a
   time. Proven end to end on `core/clip-key.js` (commit 939fe08): the require survives the
   concatenation verbatim, the vm test harness provides a real `require` resolved from the same base
   path the packaged app uses, and all ~1390 tests load unchanged.

   Three rules, all pinned by `test/core-modules-actually-ship.test.mjs`:
   - ⚠⚠ **`core/**/*` must be in `package.json` → `build.files`.** That list is an allowlist; a new
     top-level dir matches nothing, so electron-builder drops it — and every test still passes while
     the INSTALLED app fails to boot. No test could catch this, hence the guard.
   - ⚠ Require as `./core/x`, never `../core/x` — the line executes from main.js at the repo root.
   - ⚠ core/ modules must be **stateless**: the require cache is per-process while the vm context is
     per-`loadMain()`, so module-level state leaks between tests. Also what makes them server-usable.

   Still true: ~90 IPC handlers carry business logic inline, and each needs extracting into a callable
   function before it can be a route. But that is now incremental, not a prerequisite.
   - Start with `03-ai-ollama.js`, `07-naming-organize.js`, `10-ai-tools.js` (~3,200 lines): they
     touch no Electron API except `ipcMain.handle`, so they extract almost for free.
   - File by file, behind the existing suite. **Never a big-bang conversion** — see the whack-a-mole
     history in `AGENTS.md`.
3. **Progress streaming has no REST analogue.** Many handlers push progress via `evt.sender.send(...)`.
   Server-Sent Events is sufficient and simpler than WebSockets here.
4. **The copy/verify path must never gain a network hop.** The desktop keeps calling the core
   in-process. It must keep working with the backend down — this is his ingest tool.

5. ⚠⚠ **UNRESOLVED CONFLICT: "upload from my phone with the PC off" vs "build everything on my
   computer".** If the backend runs only on his Windows PC, then the PC must be awake to accept an
   upload — the two answers cannot both hold. Three ways out, none of them chosen yet:
   - **(a) The PC is effectively always on.** Likely true already — the app runs in the tray and
     Tdarr watches folders. Then there is no conflict at all and this is a non-issue. **Ask him.**
   - **(b) The phone queues locally and uploads when it can reach the PC.** The Flutter client holds
     the clip and drains the queue when the PC answers. Costs phone storage, no server change, and
     the resumable-upload work is needed anyway. This is the cheapest real answer.
   - **(c) Something always-on accepts uploads.** That is what the NAS was for, and Rule 0 forbids it
     without his say-so. Not to be assumed.
   Default to **(b)** unless he says the PC is always on, because (b) is correct either way.

---

## Remote AI — ~90% already built

`config.ai.endpoint` exists (`main-mod/01-core.js:410`, default `http://localhost:11434`) and
everything funnels through `aiEndpoint()` / `ollamaFetch()` (`main-mod/06-copy-transfer.js:618-649`).
Point it at the GPU box and set `OLLAMA_HOST=0.0.0.0:11434` there.

Bandwidth is a non-issue: contact-sheet JPEGs, ~2 MB worst case, ~2.7 MB base64-inflated — about
25 ms on gigabit against 5–30 s of inference. **Do not confuse this with splitting a GPU over the
network**, where every generated token pays a round trip. He wants the former.

Four things that genuinely need changing:

1. **Timeouts.** `ollamaFetch` defaults to 6000 ms, tuned against localhost. A cold model load on a
   remote box will blow through it.
2. **`/api/pull` and `/api/delete` bypass `ollamaFetch`** (`07-naming-organize.js:541`, `:667`) — they
   honour the endpoint but not the shared cancel token. They would also be mutating *another
   machine's* model store; decide deliberately whether that is allowed.
3. ⚠ **The single-GPU eviction logic becomes actively harmful.** The `keep_alive: 0` / `ollamaReleaseAll`
   dance exists because his 6 GB RTX 3060 is shared with the app ([[usb-app-single-gpu-rule]]). On a
   dedicated AI box the model *should* stay resident; evicting per phase costs a 10–30 s reload per
   call. This is a real regression that a config change alone would silently introduce.
4. **Failure semantics.** Localhost Ollama is up or the app is broken. A remote box can be asleep or
   rebooting — and he wants phone uploads to work with the PC off. **The pipeline needs a queue-and-
   retry state it currently has no concept of.** Uploads land whenever; processing happens when the
   AI box is awake.

---

## What to copy from his own repos

He said "built exactly like the Gourgess Lawns app". **That is the wrong model for the protocol**, and
following it literally produces an upload path that fails on video.

| | Gourgess Lawns | Imperium Academy |
|---|---|---|
| Data flow | phone → server, small JPEGs | **server holds video → phone** |
| Auth | scrapes CSRF from its own login page | QR pairing token |
| Transfer | multipart, 60 s timeout, **no resume** | **`If-Range` + `.part` + resume** |

**Take the protocol and client from Imperium, the deployment from Gourgess:**

- `imperium-academy-mobile/lib/services/downloads.dart` (811 lines) — production-grade resumable
  transfer: `If-Range` splice guard, detects a `200` where `206` was expected and truncates rather
  than concatenating mismatched bytes, free-space guard, stall watchdog. **Port nearly as-is; we need
  the upload mirror of it.**
- `imperium-academy-mobile/lib/services/hub.dart` — LAN/remote dual-address with `ensureReachable`
  probing, manifest caching. Solves "works at home and away" transparently.
- `imperium-academy-desktop/src/com/imperium/hub/ContentServer.java` — the endpoint table in its class
  doc is the API shape to mirror: unauthenticated `/health` for discovery/pairing, everything else
  token-gated via an `auth()` wrapper, `"api": N` version field with old-client compatibility.
- `gour-landscaping/Dockerfile`, `docker-compose.yml`, `.gitea/workflows/docker.yml` — two-stage
  build, migrations owned by one service, test-inside-the-built-image before push. Take all of that.
  ⚠ **Drop the Portainer redeploy step and `deploy/stack.yml`** — those target the NAS (Rule 0).
- `gour-landscaping/app/api/routes.py:52-73` — the `op_id` / `ProcessedSyncKey` idempotency pattern.

**Do NOT copy:** the HTML-scraping login (a template edit breaks the phone app silently); 6,776 lines
in one `routes.py`; `repo.dart` at 3,360 lines with no state management; ~120 flat `screen_*.dart`
files; committed APKs (5.4 GB of them); `String.equals` token comparison and the `?token=` query
fallback (use a constant-time compare and prefer the header once domain-exposed).

---

## Build order

Per his instruction — **Docker first, then the exe**, with Flutter as the phone client.

0. **Close the data-safety backlog** (`PROMPT.md` §8d). Not negotiable, his call.
1. **Extract the shared core.** `03`/`07`/`10` first. Behind the existing suite, file by file.
2. **The pipeline model** — an ordered `[{ step, enabled, config }]` in JSON, living in the shared
   core so desktop and phone render the *same* pipeline from the *same* definition rather than
   drifting. (This app has already shipped metadata preview drifting from actual embed twice.) This
   is the data model behind the step-list UI, and it is what makes "stock, then customizable" real.
3. **The Fastify API + queue**, in Docker **running locally on Windows**. Resumable chunked upload.
   SSE for progress. No NAS deployment at any point.
4. **The Flutter client** — pairing, face review, question answering, resumable upload.
5. **The exe** consumes the same core in-process, and gains the step-list UI.
6. Domain/reverse proxy/NAS move whenever HE wants it, done by him; nothing above changes.

## Open questions not yet settled

- Is the AI machine always on, or switched on per session? (Changes how aggressive the retry/queue
  policy should be.)
- Will anyone other than Jake ever use this — a second editor, a client reviewing footage? "Just me,
  forever" means the pairing token is enough and no account system is ever needed. Anyone else is a
  large, hard-to-reverse difference.
- Should the app still install/delete Ollama models once inference is remote? (See item 2 above.)
