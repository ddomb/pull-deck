// The "never open the same PR twice" promise is exactly as good as this file.
// Run with: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pullRequestKey, isSamePullRequest } from '../src/pr-url.js';

const CANONICAL = 'https://github.com/abovesec/platform-api/pull/4120';

test('canonical PR url produces a key', () => {
  assert.equal(pullRequestKey(CANONICAL), 'github.com/abovesec/platform-api#4120');
});

test('sub-paths are the same pull request', () => {
  // These are the URLs a real already-open tab is actually sitting at.
  for (const suffix of ['/files', '/commits', '/checks', '/files/abc123', '/commits/deadbeef']) {
    assert.ok(
      isSamePullRequest(CANONICAL, CANONICAL + suffix),
      `${suffix} should match the canonical url`
    );
  }
});

test('query strings and fragments are the same pull request', () => {
  for (const tail of [
    '?w=1',
    '#issuecomment-1234567',
    '/files?w=1#diff-abc',
    '?diff=split&w=1',
    '/files#diff-9f8a7b',
  ]) {
    assert.ok(isSamePullRequest(CANONICAL, CANONICAL + tail), `${tail} should match`);
  }
});

test('trailing slash is the same pull request', () => {
  assert.ok(isSamePullRequest(CANONICAL, `${CANONICAL}/`));
});

test('case differences in owner and repo still match', () => {
  assert.ok(
    isSamePullRequest(CANONICAL, 'https://github.com/AboveSec/Platform-API/pull/4120')
  );
});

test('leading zeros in the number normalize', () => {
  assert.equal(
    pullRequestKey('https://github.com/abovesec/platform-api/pull/04120'),
    'github.com/abovesec/platform-api#4120'
  );
});

test('www prefix normalizes', () => {
  assert.ok(isSamePullRequest(CANONICAL, 'https://www.github.com/abovesec/platform-api/pull/4120'));
});

test('different pull requests do not collide', () => {
  const others = [
    'https://github.com/abovesec/platform-api/pull/4121',
    'https://github.com/abovesec/other-repo/pull/4120',
    'https://github.com/otherorg/platform-api/pull/4120',
    // A different host entirely, e.g. GitHub Enterprise.
    'https://git.internal.example/abovesec/platform-api/pull/4120',
  ];
  for (const url of others) {
    assert.ok(!isSamePullRequest(CANONICAL, url), `${url} must not match`);
  }
});

test('non-pull-request urls yield no key', () => {
  const notPrs = [
    'https://github.com/abovesec/platform-api',
    'https://github.com/abovesec/platform-api/issues/4120',
    'https://github.com/abovesec/platform-api/pulls',
    'https://github.com/abovesec/platform-api/pull/not-a-number',
    'https://github.com/notifications',
    'chrome://newtab',
    'about:blank',
    '',
    undefined,
    null,
    'not a url at all',
  ];
  for (const url of notPrs) {
    assert.equal(pullRequestKey(url), null, `${url} should not produce a key`);
  }
});

test('an unmatchable url never equals another unmatchable url', () => {
  // Two ungrouped chrome:// tabs must not be treated as the same PR.
  assert.ok(!isSamePullRequest('chrome://newtab', 'chrome://newtab'));
  assert.ok(!isSamePullRequest(undefined, undefined));
});

test('the /pulls/123 variant is accepted', () => {
  assert.equal(
    pullRequestKey('https://github.com/abovesec/platform-api/pulls/4120'),
    'github.com/abovesec/platform-api#4120'
  );
});
