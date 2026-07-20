# The local backend

Serves the face review and the AI's open questions over HTTP, so they can be answered from a phone
instead of only at the PC. Open `http://<pc-ip>:8787/` on the phone.

**It reads every store and writes none of them.** Answering queues an *instruction* into
`phone-actions.jsonl` — a file nothing else writes — and the desktop app applies it later through its
own handlers. That is deliberate: the desktop owns atomic writes, the read-failure quarantine, the
caps, the prunes and the single undo record, and a second writer would race all of it. It also means
answering on the couch cannot fail because the PC is busy or asleep; the answer just waits.

## Why this has its OWN package.json

`server/` depends on Fastify (49 transitive packages). The desktop app must not inherit that: its
installer is already 135 MB, and `package.json` → `build.files` is an allowlist that would have to
grow to ship them. Keeping the dependency here means the desktop app's dependency tree is untouched
by anything the backend ever needs.

`core/` is shared by both and has **no dependencies at all** — that is a rule, not a coincidence.

## Running it

```
cd server
npm install          # once
UVD_TOKEN=<something> npm start
```

Then from the phone, on the same network: `http://<pc-ip>:8787/health`

- `UVD_TOKEN`   — required for every `/api/*` route. If unset the server refuses to start rather
                  than serving an unauthenticated archive.
- `UVD_PORT`    — default 8787.
- `UVD_HOST`    — default 0.0.0.0 so the phone can reach it. Set 127.0.0.1 to keep it local-only.
- `UVD_STORE_DIR` — point at a COPY of the store instead of the live one. Recommended while testing.

## Docker

`Dockerfile` and `docker-compose.yml` are here and ready, but **Docker is not installed on this
machine** — that is a deliberate non-action, not an oversight. Installing Docker Desktop is a large
system change and is Jake's call. Until then `npm start` runs the same server directly.

⚠ The compose file binds the store directory **read-only** (`:ro`), and that is still correct: the
server never writes a store. The action queue lives in the same directory, so when the desktop-side
consumer lands, the queue file will need its own writable mount rather than dropping `:ro` wholesale.

## What this is NOT

It does not deploy to the NAS. See `ARCHITECTURE.md` Rule 0 — everything is built and run on Jake's
computer, and moving it to the NAS is his to do by hand, later.
