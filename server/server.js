// The local HTTP backend. Read-only, token-gated, LAN-facing.
//
// Shape borrowed from imperium-academy-desktop's ContentServer — Jake's own working pattern, and the
// right one for this app: an unauthenticated /health for discovery and pairing, everything else
// behind a token, and an explicit `api` version number so an older phone client can be detected
// rather than silently mis-parsing.
//
// NOT borrowed from the Gourgess Lawns app, despite it being the one he named: that client
// authenticates by scraping the CSRF token out of its own login page, which breaks silently whenever
// the HTML changes. A real token endpoint is the better half of his two patterns.
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const Fastify = require('fastify');
const store = require('../core/store-read');
const queue = require('../core/action-queue');
const upload = require('../core/upload');

const API_VERSION = 1;
const PORT = Number(process.env.UVD_PORT) || 8787;
const HOST = process.env.UVD_HOST || '0.0.0.0';
const TOKEN = process.env.UVD_TOKEN || '';
const STORE_DIR = process.env.UVD_STORE_DIR || undefined;
// Where phone uploads land. Its OWN directory, never the intake folder or the Projects tree — the
// desktop ingests from here on its own terms, exactly as it already does for phone pulls.
const UPLOAD_DIR = process.env.UVD_UPLOAD_DIR || path.join(store.storeDir(STORE_DIR), 'phone-uploads');

// ⚠ REFUSE TO START WITHOUT A TOKEN.
//
// This binds 0.0.0.0 by default so a phone can reach it, and it serves an index of who is in his
// footage. Defaulting to "no token = open" would mean a single forgotten env var silently exposes
// that to every device on the network — including whatever else is on a shared or guest WiFi.
// Failing loudly at startup is the only version of this that cannot go wrong quietly.
function requireToken() {
  if (TOKEN && TOKEN.length >= 8) return;
  // eslint-disable-next-line no-console
  console.error(
    'Refusing to start: set UVD_TOKEN to at least 8 characters.\n' +
    'It gates every /api route. Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(16).toString(\'hex\'))"',
  );
  process.exit(1);
}

// Constant-time compare. The reference implementation used String.equals, which leaks length and
// content through timing — noted as a do-not-copy when that code was reviewed. timingSafeEqual
// throws on length mismatch, so the lengths are compared first, separately and harmlessly.
function tokenOk(given) {
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(TOKEN, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function build({ logger = false } = {}) {
  // 64 MB body limit: chunks are the unit of retry, so they want to be big enough to be efficient
  // and small enough that losing one to a dropped connection costs little. The phone picks the size;
  // this is the ceiling.
  const app = Fastify({ logger, bodyLimit: 64 * 1024 * 1024 });
  // ⚠ Video chunks are RAW BYTES. Without this, Fastify tries to JSON-parse them and every upload
  // fails with a parse error that says nothing about what actually went wrong.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (req, body, done) => done(null, body));

  // Discovery + pairing. Unauthenticated ON PURPOSE, and therefore says nothing about his footage:
  // no counts, no names, no paths. Just enough for a client to confirm it found the right service
  // and learn whether it needs a token.
  app.get('/health', async () => ({
    ok: true,
    name: 'usb-video-manager',
    api: API_VERSION,
    needsToken: true,
  }));

  // The phone page itself. Same origin as the API on purpose: no CORS to get wrong, and the token
  // never crosses an origin boundary. Unauthenticated because it contains no data — it ASKS for the
  // token and then fetches everything itself.
  app.get('/', async (req, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return require('node:fs').createReadStream(path.join(__dirname, 'public', 'review.html'));
  });

  // Everything below is token-gated.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // Header only. The reference accepted `?token=` as a fallback, which puts the secret into
    // browser history, proxy logs and screenshots — the kind of leak that is invisible until it
    // isn't. A header costs the client one line.
    if (!tokenOk(req.headers['x-pair-token'])) {
      reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
  });

  // Is the desktop app's data actually readable? Answered honestly so the phone can distinguish
  // "you have no faces to review" from "the store is missing or corrupt" — a distinction this app
  // has been bitten by before.
  app.get('/api/status', async () => {
    const health = store.storeHealth({ dir: STORE_DIR });
    const broken = Object.entries(health).filter(([, v]) => v.present && !v.ok).map(([k]) => k);
    return {
      ok: broken.length === 0,
      api: API_VERSION,
      storeDir: store.storeDir(STORE_DIR),
      stores: health,
      broken,
    };
  });

  // The review itself. Descriptors are stripped in core/store-read — the phone needs a thumbnail and
  // a name, not 12 MB of face vectors.
  app.get('/api/faces/pending', async (req, reply) => {
    try {
      const items = store.pendingFaces({ dir: STORE_DIR });
      return { ok: true, count: items.length, items };
    } catch (err) {
      // A corrupt store must not read as "no faces" — that is the failure mode this whole app keeps
      // being bitten by. Say what happened.
      reply.code(err.code === 'ESTORECORRUPT' ? 409 : 500);
      return { ok: false, error: err.message, store: err.store || null };
    }
  });

  // Stream a face crop. This exists because the stored thumb is a `file:///C:/...` URL the phone
  // cannot resolve — see cropNameFromThumb in core/store-read.js.
  //
  // The name comes off a query string, so it is hostile input by default; core/faceCropPath rejects
  // anything with a separator, anything not matching a strict filename pattern, and anything that
  // resolves outside the faces directory. If it returns '' this route 404s rather than guessing.
  app.get('/api/face-crop', async (req, reply) => {
    const full = store.faceCropPath((req.query || {}).name, { dir: STORE_DIR });
    if (!full) { reply.code(404); return { ok: false, error: 'no such crop' }; }
    const ext = path.extname(full).toLowerCase();
    const type = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
    // Crops are content-addressed by a random name and never rewritten in place, so they cache hard.
    reply.header('Content-Type', type).header('Cache-Control', 'private, max-age=86400');
    return reply.send(require('node:fs').createReadStream(full));
  });

  app.get('/api/people', async (req, reply) => {
    try {
      return { ok: true, people: store.people({ dir: STORE_DIR }) };
    } catch (err) {
      reply.code(err.code === 'ESTORECORRUPT' ? 409 : 500);
      return { ok: false, error: err.message, store: err.store || null };
    }
  });

  app.get('/api/questions', async (req, reply) => {
    try {
      const q = store.questions({ dir: STORE_DIR });
      return { ok: true, count: q.length, questions: q };
    } catch (err) {
      reply.code(err.code === 'ESTORECORRUPT' ? 409 : 500);
      return { ok: false, error: err.message, store: err.store || null };
    }
  });

  // ⚠⚠ THE ONLY WRITE, AND IT DOES NOT TOUCH A SINGLE STORE.
  //
  // An answer from the phone is APPENDED as an instruction to phone-actions.jsonl — a file nothing
  // else writes — and the desktop app applies it later through its own handlers. The desktop keeps
  // sole ownership of faces-pending.json, people.json and the rest, along with its atomic writes,
  // read-failure quarantine, caps, prunes and undo record. One writer per file, always.
  //
  // The consequence he actually cares about: answering on the couch cannot fail because the PC is
  // busy or asleep. The worst case is the answer waits in the queue.
  app.post('/api/actions', async (req, reply) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const r = queue.append(body, { dir: store.storeDir(STORE_DIR), at: Date.now(), source: 'phone' });
    if (!r.ok) { reply.code(400); return r; }
    return { ok: true, id: r.id, queued: true };
  });

  // What is waiting to be applied. The phone shows this so a queued answer is visibly QUEUED rather
  // than looking like it silently did nothing.
  app.get('/api/actions', async () => {
    const pending = queue.read({ dir: store.storeDir(STORE_DIR) });
    return { ok: true, count: pending.length, actions: pending };
  });

  // ─── RESUMABLE UPLOAD ──────────────────────────────────────────────────────────────────────────
  // He locks the phone and walks away mid-upload, so a 4 GB clip WILL be interrupted. A plain
  // multipart POST restarts from zero each time, which means it effectively never finishes. These
  // three routes let the phone ask "how much did you get?" and send only the remainder.

  app.post('/api/upload/begin', async (req, reply) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    // Refuse before a single byte if it cannot possibly fit. Finding out at 95% is the worst moment.
    try {
      const need = Number(b.size) || 0;
      const st = await require('node:fs').promises.statfs(require('node:fs').existsSync(UPLOAD_DIR)
        ? UPLOAD_DIR : path.dirname(UPLOAD_DIR));
      const free = st.bsize * st.bavail;
      if (need && free && need > free - (512 * 1024 * 1024)) {
        reply.code(507);
        return { ok: false, error: `Not enough room: needs ${Math.round(need / 1e6)} MB, ${Math.round(free / 1e6)} MB free.` };
      }
    } catch { /* cannot measure — proceed; finish() still verifies the byte count */ }
    const r = upload.begin({ dir: UPLOAD_DIR, name: b.name, size: b.size, at: Date.now() });
    if (!r.ok) { reply.code(400); return r; }
    return r;
  });

  // Resume: how much is already here. The phone asks this before sending anything.
  app.get('/api/upload/:id', async (req, reply) => {
    const r = upload.status({ dir: UPLOAD_DIR, id: req.params.id });
    if (!r.ok) reply.code(404);
    return r;
  });

  // A chunk, as raw bytes. `offset` must match what is on disk — see appendChunk for why a mismatch
  // is refused rather than appended.
  app.put('/api/upload/:id', async (req, reply) => {
    const r = upload.appendChunk({
      dir: UPLOAD_DIR, id: req.params.id,
      offset: (req.query || {}).offset, buf: req.body,
    });
    if (!r.ok) { reply.code(r.expected === undefined ? 400 : 409); return r; }
    return r;
  });

  app.post('/api/upload/:id/finish', async (req, reply) => {
    const r = upload.finish({ dir: UPLOAD_DIR, id: req.params.id });
    if (!r.ok) { reply.code(409); return r; }
    return r;
  });

  // Any OTHER write is still refused, loudly. Silently accepting and dropping would be the worst
  // possible version of this.
  app.post('/api/*', async (req, reply) => {
    reply.code(501);
    return { ok: false, error: 'Only /api/actions accepts writes — everything else goes through the desktop app.' };
  });

  return app;
}

async function start() {
  requireToken();
  const app = build({ logger: true });
  await app.listen({ port: PORT, host: HOST });
  // eslint-disable-next-line no-console
  console.log(`store: ${store.storeDir(STORE_DIR)}`);
}

if (require.main === module) start().catch((err) => { console.error(err); process.exit(1); });

module.exports = { build, tokenOk, API_VERSION };
