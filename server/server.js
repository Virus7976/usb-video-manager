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

const API_VERSION = 1;
const PORT = Number(process.env.UVD_PORT) || 8787;
const HOST = process.env.UVD_HOST || '0.0.0.0';
const TOKEN = process.env.UVD_TOKEN || '';
const STORE_DIR = process.env.UVD_STORE_DIR || undefined;

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
  const app = Fastify({ logger, bodyLimit: 1024 * 1024 });

  // Discovery + pairing. Unauthenticated ON PURPOSE, and therefore says nothing about his footage:
  // no counts, no names, no paths. Just enough for a client to confirm it found the right service
  // and learn whether it needs a token.
  app.get('/health', async () => ({
    ok: true,
    name: 'usb-video-manager',
    api: API_VERSION,
    needsToken: true,
  }));

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

  // Every write route is deliberately absent. Confirming a face from the phone will hand the desktop
  // app an instruction rather than touching these files — the desktop owns atomic writes, the
  // read-failure quarantine, the caps and the undo record, and a second writer would race all of it.
  // See the note at the top of core/store-read.js.
  app.post('/api/*', async (req, reply) => {
    reply.code(501);
    return { ok: false, error: 'This backend is read-only for now — writes go through the desktop app.' };
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
