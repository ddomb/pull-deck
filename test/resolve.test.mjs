// The shortcut matcher.
//
// The asymmetry that shapes every test here: a miss costs a second of typing,
// a *wrong* hit sends you to somebody else's pull request and you may not
// notice until you have commented on it. So the boundary cases come first, and
// where the rules are uncertain they are written to return nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShortcut, findMatches, containsToken, SHORTCUT_HOSTS } from '../src/resolve.js';

const pr = (over = {}) => ({
  id: over.id ?? `id-${over.number ?? 1}`,
  number: 6081,
  title: 'Stop the session refresher thundering on cold start',
  url: 'https://github.com/Above-Security/above/pull/6081',
  repo: 'Above-Security/above',
  headRefName: 'ddomb/ABV-4242-session-refresher',
  isDraft: false,
  updatedAt: '2026-07-29T09:00:00Z',
  ...over,
});

/* ------------------------------------------------------------ URL parsing -- */

test('the shape the user asked for resolves to the ticket', () => {
  assert.deepEqual(parseShortcut('http://pull-dock/pr/abv-4242'), { query: 'abv-4242' });
});

test('the path prefix is optional and interchangeable', () => {
  for (const url of [
    'http://pull-dock/pr/abv-4242',
    'http://pull-dock/abv-4242',
    'http://pull-dock/pull/abv-4242',
    'http://pull-dock/go/abv-4242',
  ]) {
    assert.equal(parseShortcut(url).query, 'abv-4242', url);
  }
});

test('both spellings and the reserved-TLD form all work', () => {
  for (const host of ['pull-dock', 'pull-deck', 'pulldeck', 'pulldock']) {
    assert.equal(parseShortcut(`http://${host}/pr/abv-4242`)?.query, 'abv-4242', host);
    assert.equal(
      parseShortcut(`http://${host}.test/pr/abv-4242`)?.query,
      'abv-4242',
      `${host}.test`
    );
  }
});

test('every advertised host is one the parser actually accepts', () => {
  // These strings become the webNavigation event filter. A host listed there
  // but rejected here would wake the worker and then do nothing at all.
  for (const host of SHORTCUT_HOSTS) {
    assert.equal(parseShortcut(`http://${host}/x`)?.query, 'x', host);
  }
});

test('a real address is left alone', () => {
  assert.equal(parseShortcut('https://github.com/Above-Security/above/pull/6081'), null);
  assert.equal(parseShortcut('https://pull-deck.com/pr/abv-4242'), null, 'a real domain, not ours');
  assert.equal(parseShortcut('not a url'), null);
  assert.equal(parseShortcut('chrome://extensions'), null);
});

test('repo#number survives being parsed as a fragment', () => {
  assert.equal(parseShortcut('http://pull-dock/pr/above#6081').query, 'above#6081');
});

test('an escaped slash comes back as a slash', () => {
  assert.equal(parseShortcut('http://pull-dock/pr/feat%2Fabv-4242').query, 'feat/abv-4242');
});

test('a bare host asks for the whole list rather than failing', () => {
  assert.deepEqual(parseShortcut('http://pull-dock/'), { query: '' });
  assert.deepEqual(parseShortcut('http://pull-dock/pr/'), { query: '' });
});

/* ------------------------------------------------------- boundary matching */

test('a ticket id does not match a longer one', () => {
  // The whole reason this is not a substring search.
  assert.equal(containsToken('ddomb/ABV-42421-other', 'abv-4242'), false);
  assert.equal(containsToken('ddomb/ABV-4242-real', 'abv-4242'), true);
});

test('a truncated ticket id matches nothing', () => {
  assert.equal(containsToken('ddomb/ABV-4242-real', 'abv-424'), false);
});

test('the separators branch names actually use all count as boundaries', () => {
  for (const branch of [
    'ABV-4242',
    'feat/ABV-4242',
    'ABV-4242-fix',
    'ABV-4242_fix',
    'x/ABV-4242/y',
  ]) {
    assert.equal(containsToken(branch, 'abv-4242'), true, branch);
  }
});

test('matching ignores case in both directions', () => {
  assert.equal(containsToken('ddomb/abv-4242-x', 'ABV-4242'), true);
  assert.equal(containsToken('ddomb/ABV-4242-x', 'abv-4242'), true);
});

test('a regex metacharacter is matched literally, not compiled', () => {
  assert.equal(containsToken('fix (a+b) parsing', 'a+b'), true);
  assert.equal(containsToken('fix aaab parsing', 'a+b'), false);
});

/* --------------------------------------------------------------- ranking -- */

const LIST = [
  pr({ id: 'a', number: 6081, headRefName: 'ddomb/ABV-4242-session-refresher' }),
  pr({
    id: 'b',
    number: 6082,
    title: 'Batch identity lookups',
    repo: 'Above-Security/browser-extension',
    url: 'https://github.com/Above-Security/browser-extension/pull/6082',
    headRefName: 'ddomb/ABV-9001-batching',
  }),
  pr({
    id: 'c',
    number: 4242,
    title: 'Unrelated work that happens to be numbered 4242',
    repo: 'Above-Security/infra',
    url: 'https://github.com/Above-Security/infra/pull/4242',
    headRefName: 'ddomb/ABV-7777-infra',
  }),
];

test('the public matcher never falls back to partial ticket matches', () => {
  assert.equal(findMatches('abv-424', [pr()]).status, 'none');
  assert.equal(findMatches('abv-4242', [pr({ headRefName: 'feat/ABV-42421' })]).status, 'none');
});

test('explicit PR numbers and qualified repositories do not become text searches', () => {
  assert.equal(findMatches('42', [pr({ title: 'Fix ticket 42', number: 99 })]).status, 'none');
  assert.equal(findMatches('wrong#99', [pr({ title: 'wrong#99', number: 99 })]).status, 'none');
});

test('the example from the request resolves to exactly one pull request', () => {
  const found = findMatches('abv-4242', LIST);
  assert.equal(found.status, 'one');
  assert.equal(found.matches[0].url, 'https://github.com/Above-Security/above/pull/6081');
});

test('an exact pull request number outranks a ticket that merely contains it', () => {
  // "4242" is both PR #4242 and part of ABV-4242. The explicit number wins.
  const found = findMatches('4242', LIST);
  assert.equal(found.status, 'one');
  assert.equal(found.matches[0].id, 'c');
});

test('a leading hash is the same request', () => {
  assert.equal(findMatches('#6081', LIST).matches[0].id, 'a');
});

test('repo#number disambiguates across repositories', () => {
  assert.equal(findMatches('browser-extension#6082', LIST).matches[0].id, 'b');
  assert.equal(findMatches('Above-Security/above#6081', LIST).matches[0].id, 'a');
  assert.equal(findMatches('above/6081', LIST).matches[0].id, 'a', 'slash separator too');
});

test('a repo that does not have that number matches nothing', () => {
  assert.equal(findMatches('infra#6081', LIST).status, 'none');
});

test('ties are never broken, they are handed back', () => {
  // A stacked branch and its follow-up carry the same ticket. Picking one is
  // the wrong-hit failure this whole file exists to avoid.
  const stacked = [
    pr({ id: 'x', number: 10, headRefName: 'ddomb/ABV-4242-part-one' }),
    pr({ id: 'y', number: 11, headRefName: 'ddomb/ABV-4242-part-two' }),
  ];
  const found = findMatches('abv-4242', stacked);
  assert.equal(found.status, 'many');
  assert.equal(found.matches.length, 2);
});

test('a branch match beats a title match', () => {
  const list = [
    pr({ id: 'title', number: 1, headRefName: 'chore/cleanup', title: 'Revert ABV-4242' }),
    pr({ id: 'branch', number: 2, headRefName: 'ddomb/ABV-4242-fix', title: 'Session fix' }),
  ];
  const found = findMatches('abv-4242', list);
  assert.equal(found.status, 'one');
  assert.equal(found.matches[0].id, 'branch');
});

test('a malformed ticket suffix cannot win as a loose substring', () => {
  const list = [pr({ id: 'loose', number: 1, headRefName: 'ddomb/ABV-4242fix', title: 'Session' })];
  assert.equal(findMatches('abv-4242', list).status, 'none');

  // ...but never over a real token match elsewhere in the list.
  const mixed = [...list, pr({ id: 'token', number: 2, headRefName: 'ddomb/ABV-4242-fix' })];
  const found = findMatches('abv-4242', mixed);
  assert.equal(found.status, 'one');
  assert.equal(found.matches[0].id, 'token');
});

test('a miss reports none and still hands back the full list to browse', () => {
  const found = findMatches('abv-0000', LIST);
  assert.equal(found.status, 'none');
  assert.deepEqual(found.matches, []);
  assert.equal(found.all.length, 3);
});

test('an empty query asks for everything rather than matching nothing', () => {
  const found = findMatches('', LIST);
  assert.equal(found.status, 'empty');
  assert.equal(found.all.length, 3);
});

test('a cache written before branch names existed cannot invent a match', () => {
  // Every PR here predates headRefName. Nothing must match on branch, and
  // nothing must throw. app-state.js refetches on exactly this shape.
  const old = LIST.map(({ headRefName: _headRefName, ...rest }) => rest);
  assert.equal(findMatches('abv-4242', old).status, 'none');
  assert.equal(findMatches('6081', old).status, 'one', 'numbers still work');
});

test('junk input is a miss, not a crash', () => {
  for (const junk of [null, undefined, '   ', '///', '#', '#abc']) {
    assert.doesNotThrow(() => findMatches(junk, LIST), String(junk));
  }
  assert.equal(findMatches('   ', LIST).status, 'empty');
  assert.equal(findMatches(undefined, null).status, 'empty');
});
