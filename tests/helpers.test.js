// Unit tests for the pure helper functions exported by monday-helper.
// These don't hit the monday API; they test the local logic only.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { levenshtein, normalizeName, namesMatch, resolveValueArg } = require('../index.js');

// ---------- levenshtein ----------

test('levenshtein: identical strings → 0', () => {
  assert.equal(levenshtein('hello', 'hello'), 0);
  assert.equal(levenshtein('', ''), 0);
});

test('levenshtein: single edit', () => {
  assert.equal(levenshtein('cat', 'bat'), 1);
  assert.equal(levenshtein('cat', 'cats'), 1);
  assert.equal(levenshtein('cats', 'cat'), 1);
});

test('levenshtein: multiple edits', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
});

test('levenshtein: empty + non-empty', () => {
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('abc', ''), 3);
});

test('levenshtein: bails on very long strings (returns 999)', () => {
  const long = 'x'.repeat(400);
  assert.equal(levenshtein(long, 'short'), 999);
  assert.equal(levenshtein('short', long), 999);
});

// ---------- normalizeName ----------

test('normalizeName: lowercases', () => {
  assert.equal(normalizeName('Acme Corp'), 'acme corp');
});

test('normalizeName: strips trailing " - suffix"', () => {
  assert.equal(normalizeName('Process Q3 returns - Acme Roofing'), 'process q3 returns');
  assert.equal(normalizeName('Renew contract - vendor X'), 'renew contract');
});

test('normalizeName: leaves non-suffix hyphens alone', () => {
  // hyphen with no surrounding spaces is part of the name
  assert.equal(normalizeName('check-in call'), 'check-in call');
});

test('normalizeName: trims whitespace', () => {
  assert.equal(normalizeName('  spaced out  '), 'spaced out');
});

// ---------- namesMatch ----------

test('namesMatch: exact match', () => {
  assert.equal(namesMatch('Acme Corp', 'Acme Corp'), true);
});

test('namesMatch: case-insensitive', () => {
  assert.equal(namesMatch('Acme Corp', 'acme corp'), true);
  assert.equal(namesMatch('ACME CORP', 'Acme Corp'), true);
});

test('namesMatch: trailing suffix difference', () => {
  assert.equal(namesMatch('Renew - Acme Corp', 'Renew - Beta Vendor'), true);
});

test('namesMatch: small Levenshtein distance matches', () => {
  assert.equal(namesMatch('Process Q3 returns', 'Process Q4 returns'), true);
  assert.equal(namesMatch('Renew MSA', 'Renew NDA'), true);
});

test('namesMatch: substring containment', () => {
  assert.equal(namesMatch('Renew MSA', 'Renew MSA for Acme'), true);
});

test('namesMatch: different names do not match', () => {
  assert.equal(namesMatch('Process returns', 'Schedule meeting'), false);
  assert.equal(namesMatch('Q3 invoice review', 'Onboard new vendor'), false);
});

test('namesMatch: empty strings', () => {
  assert.equal(namesMatch('', ''), true);
});

// ---------- resolveValueArg ----------

test('resolveValueArg: raw JSON object string parses', () => {
  assert.deepEqual(resolveValueArg('{"a":1}'), { a: 1 });
});

test('resolveValueArg: non-JSON string falls through to raw', () => {
  assert.equal(resolveValueArg('plain string'), 'plain string');
});

test('resolveValueArg: @file with valid JSON loads it', () => {
  const tmp = path.join(os.tmpdir(), `mh-${Date.now()}.json`);
  fs.writeFileSync(tmp, '{"label":"Done"}');
  assert.deepEqual(resolveValueArg('@' + tmp), { label: 'Done' });
  fs.unlinkSync(tmp);
});

test('resolveValueArg: @missing-file throws clean error', () => {
  assert.throws(() => resolveValueArg('@/this/does/not/exist.json'), /file not found/);
});

test('resolveValueArg: @file with malformed JSON throws named error', () => {
  const tmp = path.join(os.tmpdir(), `mh-bad-${Date.now()}.json`);
  fs.writeFileSync(tmp, 'not json');
  assert.throws(() => resolveValueArg('@' + tmp), /invalid JSON/);
  fs.unlinkSync(tmp);
});

// ---------- exports surface ----------

test('exports include the documented helpers', () => {
  const idx = require('../index.js');
  for (const name of ['mondayQuery', 'loadToken', 'checkDuplicateItem', 'namesMatch', 'normalizeName', 'levenshtein', 'resolveValueArg']) {
    assert.equal(typeof idx[name], 'function', `missing export: ${name}`);
  }
});
