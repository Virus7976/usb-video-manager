// THE PHONE PAGE, IN A REAL BROWSER, AGAINST THE REAL SERVER.
//
// Everything before this exercised the API — routes, auth, the queue — via Fastify's `inject`. None
// of it ever RENDERED the page. That is a meaningful gap: the whole point of this feature is that he
// can use it on a phone, and "the API returns correct JSON" is not the same claim.
//
// It has already caught one bug that only appears when something actually loads the page: the stored
// thumbnail is a `file:///C:/Users/...` URL, which is a perfectly valid string the API happily
// returned, and a phone cannot resolve. This test exists so the next one of those is caught here
// rather than by him.
//
// Real Chromium, phone viewport, real HTTP. The server is pointed at a TEMP store — his real data is
// never involved.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const RUN = process.env.RUN_E2E === '1';
const require = createRequire(join(process.cwd(), 'server', 'server.js'));

const TOKEN = 'testtoken1234';
// ⚠ PORT 0 = let the OS pick a free one. A FIXED port made this test flaky: if a previous run's
// socket is still in TIME_WAIT, or anything else on the machine holds it, listen() throws in before()
// and every test in the file fails at once for a reason that has nothing to do with the code. Caught
// by an e2e run failing once and passing on retry — a flake I introduced, not an app bug.
let dir; let server; let browser; let page; let base;

before(async () => {
  if (!RUN) return;
  dir = mkdtempSync(join(tmpdir(), 'uvd-page-'));
  mkdirSync(join(dir, 'faces'), { recursive: true });
  // ⚠ A REAL, DECODABLE 1x1 PNG. My first fixture was a hand-rolled 1x1 JPEG that was structurally
  // valid (correct SOI/EOI, sane SOF dimensions) but whose quantization tables were all 0xFF —
  // Chromium refuses to decode it, so naturalWidth came back 0 and the test failed as though the APP
  // were broken. A fixture that cannot decode makes this test unable to distinguish "the image
  // pipeline is broken" from "my test data is rubbish", which is worse than no test.
  writeFileSync(join(dir, 'faces', 'aaa.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'));
  writeFileSync(join(dir, 'faces-pending.json'), JSON.stringify([
    { thumb: 'file:///C:/x/faces/aaa.png', suggest: { name: 'Josiah', dist: 0.3 }, clipKeys: ['k1'], descriptors: [[1]] },
    { thumb: 'file:///C:/x/faces/aaa.png', suggest: null, clipKeys: ['k2'], descriptors: [[2]] },
  ]));
  writeFileSync(join(dir, 'people.json'), JSON.stringify([
    { id: 'p1', name: 'Liam', thumb: 'file:///C:/x/faces/aaa.png', faces: [{ confirmed: true }] },
  ]));

  process.env.UVD_TOKEN = TOKEN;
  process.env.UVD_STORE_DIR = dir;
  // ⚠ '../server/server', not '../../': createRequire's base is server/server.js itself, so relative
  // paths resolve from server/ — NOT from this test file's directory. Getting that wrong fails in the
  // before() hook, which reports as every test in the file failing at once for no visible reason.
  server = require('../server/server').build({ logger: false });
  await server.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${server.server.address().port}`;

  browser = await chromium.launch({ headless: true });
  // A real phone viewport: the layout claims 48px tap targets and safe-area padding, and those are
  // only meaningful at this size.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  page = await ctx.newPage();
});
after(async () => {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await server?.close(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ⚠ IDEMPOTENT. The token lives in localStorage and PERSISTS across tests in this file, so on the
// second visit the pair form is already hidden and `page.fill('#tok')` waits 30s for an element that
// will never appear. Seeding the token directly is what makes each test independent of the order the
// others ran in. One test below still drives the real form, so that path stays covered.
const pair = async () => {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('uvd.token', t), TOKEN);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.card', { timeout: 8000 });
};

test('⚠ an unpaired phone is asked to pair, and shows no data', { skip: !RUN }, async () => {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pair:not(.hide)', { timeout: 5000 });
  const body = await page.textContent('body');
  assert.ok(!body.includes('Josiah'), '⚠ nothing about his footage before pairing');
  assert.match(await page.textContent('#sub'), /not paired/);
});

test('⚠ typing the token into the form pairs the phone', { skip: !RUN }, async () => {
  // pair() seeds localStorage directly so tests are order-independent — so this is the one place the
  // real form is driven, or that path would be untested.
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pair:not(.hide)', { timeout: 5000 });
  await page.fill('#tok', TOKEN);
  await page.click('#pairBtn');
  await page.waitForSelector('.card', { timeout: 8000 });
  assert.ok((await page.locator('.card').count()) > 0, 'the review loads after pairing');
});

test('⚠⚠ the review renders, and the face crops actually LOAD', { skip: !RUN }, async () => {
  // The bug this file exists for. `thumb` was a file:// URL — valid JSON, unusable image. An <img>
  // that 404s or fails to decode has naturalWidth 0, which is the only honest check.
  await pair();
  assert.equal(await page.locator('.card').count(), 2, 'both unanswered faces render');

  // ⚠ ONLY THE VISIBLE ONE. The crops are `loading="lazy"`, so a card below the fold legitimately has
  // not fetched its image — at a 390x844 phone viewport the second card is off-screen. My first
  // version asserted BOTH had loaded and failed, which read exactly like a broken image pipeline. The
  // laziness is deliberate and load-bearing: he has 414 pending faces, and 414 eager image requests
  // would stall a phone. So: assert the first loads, and assert the rest are lazy on purpose.
  const first = await page.evaluate(async () => {
    const i = document.querySelector('img.crop');
    if (!i.complete) await new Promise((r) => { i.onload = r; i.onerror = r; });
    return { w: i.naturalWidth, src: i.getAttribute('src') };
  });
  assert.ok(first.w > 0,
    `⚠ the visible crop failed to load (naturalWidth ${first.w}) — a file:// URL looks fine in JSON and renders nothing`);
  assert.match(first.src, /^blob:/,
    '⚠ fetched with the auth header and turned into a blob — an <img src> cannot send a header, so a ' +
    'direct /api/face-crop src 401s and renders nothing');

  // Scrolling brings the next one in, which proves lazy loading is working rather than broken.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('img.crop')];
    return imgs.length > 1 && imgs[1].complete && imgs[1].naturalWidth > 0;
  }, { timeout: 8000 });
});

test('⚠ crops are lazy, because he has hundreds of faces', { skip: !RUN }, async () => {
  // 414 eager image requests on a phone is a stalled page. This is a deliberate property, so it is
  // asserted rather than left to chance.
  await pair();
  // Laziness is now an IntersectionObserver (the fetch is deferred), not just the attribute — the
  // attribute alone does nothing once the src is set from JS.
  const state = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img.crop')];
    return { total: imgs.length, loaded: imgs.filter((i) => i.dataset.loaded).length, lazyAttr: imgs.every((i) => i.loading === 'lazy') };
  });
  assert.equal(state.lazyAttr, true, 'the attribute is kept for browsers without IntersectionObserver');
  assert.ok(state.loaded < state.total || state.total === 1,
    `⚠ off-screen crops are not fetched — ${state.loaded} of ${state.total} loaded`);
});

test('a suggested name is offered as a one-tap Yes', { skip: !RUN }, async () => {
  await pair();
  const first = page.locator('.card').first();
  assert.match(await first.textContent(), /Is this Josiah\?/, 'it asks, rather than assuming');
  assert.equal(await first.locator('button.yes').count(), 1, 'and Yes is one tap');
});

test('an UNsuggested face asks who it is, with existing people as chips', { skip: !RUN }, async () => {
  await pair();
  const second = page.locator('.card').nth(1);
  assert.match(await second.textContent(), /Who is this\?/);
  // Typing a name on a phone is the thing that stops him answering — the chips are the point.
  assert.ok((await second.locator('.chip').count()) >= 1, 'his existing people are one-tap');
  assert.match(await second.locator('.chip').first().textContent(), /Liam/);
});

test('⚠⚠ tap targets are big enough to use one-handed', { skip: !RUN }, async () => {
  // 48px is not decoration: this is pressed repeatedly, with a thumb, on a moving phone. A layout
  // that renders 30px buttons is a layout he stops using.
  await pair();
  const small = await page.evaluate(() => [...document.querySelectorAll('.card button')]
    .map((b) => ({ t: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height) }))
    .filter((b) => b.h < 44));
  assert.deepEqual(small, [], `⚠ every control is at least 44px tall — too small: ${JSON.stringify(small)}`);
});

test('the page never scrolls sideways on a phone', { skip: !RUN }, async () => {
  await pair();
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(over <= 1, `⚠ horizontal overflow of ${over}px — a phone layout must not scroll sideways`);
});

test('⚠⚠ answering queues it, and SAYS it is queued rather than done', { skip: !RUN }, async () => {
  // The honesty property. The desktop applies it later; claiming "done" here would be the same
  // success-over-nothing-happened failure fixed repeatedly in the desktop app.
  await pair();
  const before = await page.locator('.card').count();
  await page.locator('.card').first().locator('button.yes').click();
  await page.waitForSelector('.card .who:text-matches("Queued")', { timeout: 5000 });
  const txt = await page.locator('.card').first().textContent();
  assert.match(txt, /Queued/, 'it says queued');
  assert.match(txt, /next time the app runs on your PC/i, '⚠ and explains that it has not landed yet');
  assert.equal(await page.locator('.card').count(), before, 'the card stays, rewritten in place');

  // And it really reached the server.
  const q = await page.evaluate(async (t) => {
    const r = await fetch('/api/actions', { headers: { 'X-Pair-Token': t } });
    return r.json();
  }, TOKEN);
  assert.equal(q.count, 1, 'one instruction is waiting');
  assert.equal(q.actions[0].type, 'face.confirm');
  assert.equal(q.actions[0].name, 'Josiah');
  // ⚠ Keyed by the CROP FILENAME, not a list index — indices shift when the desktop rescans, and an
  // answer applied to a shifted index would confirm the wrong person.
  assert.equal(q.actions[0].clusterId, 'aaa.png', 'identified by a stable id');
});

test('⚠ the buttons for an answered card are gone, so it cannot be answered twice', { skip: !RUN }, async () => {
  await pair();
  await page.locator('.card').first().locator('button.yes').click();
  await page.waitForSelector('.card .who:text-matches("Queued")', { timeout: 5000 });
  assert.equal(await page.locator('.card').first().locator('button').count(), 0, 'no controls remain on it');
});

test('⚠⚠ a rejected token is reported, not silently ignored', { skip: !RUN }, async () => {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('uvd.token', 'wrongtoken99'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pair:not(.hide)', { timeout: 5000 });
  assert.match(await page.textContent('#pairErr'), /rejected/i, '⚠ he is told, rather than shown an empty list');
});

test('⚠⚠ a BROKEN store says so — it never looks like "no faces left"', { skip: !RUN }, async () => {
  // The failure mode this whole app keeps being bitten by, checked at the last mile: the phone must
  // not render a corrupt store as a finished review.
  const good = readFileSync(join(dir, 'faces-pending.json'), 'utf8');
  writeFileSync(join(dir, 'faces-pending.json'), '{ not json');
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => localStorage.setItem('uvd.token', t), TOKEN);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#empty:not(.hide)', { timeout: 5000 });
    const txt = await page.textContent('#empty');
    assert.match(txt, /Could not read/i, '⚠ it says the store is unreadable…');
    assert.ok(!/every face has been answered/i.test(txt), '…and NOT that he is finished');
    assert.match(txt, /Nothing has been changed/i, 'and reassures him nothing was touched');
  } finally {
    writeFileSync(join(dir, 'faces-pending.json'), good);
  }
});
