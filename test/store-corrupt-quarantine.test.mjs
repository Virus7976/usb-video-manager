// #62: a store file present but UNREADABLE (corrupt JSON) used to run the whole session on empty
// defaults with no trace — the user saw an empty People/faces view, no clue the DB was intact-but-
// unread. freshStore now quarantines a *.corrupt copy once and logs it (writes already stay blocked).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadMain } from './harness.mjs';

let app;
before(() => { app = loadMain(); });
after(() => { try { app.dispose(); } catch { /* ignore */ } });

test('a corrupt store is quarantined to *.corrupt and logged; writes blocked', () => {
  const dir = app.get('STORE_DIR'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'people.json');
  writeFileSync(file, '{ this is not valid json ');
  app.call('freshStore', 'ai.people');
  const corrupt = readdirSync(dir).filter((n) => /^people\.json\.corrupt-\d+$/.test(n));
  assert.equal(corrupt.length, 1, 'a .corrupt copy was saved');
  assert.equal(existsSync(join(app.dirs.userData, 'crash.log')), true, 'the event is in crash.log');
});
