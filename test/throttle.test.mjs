// Two surfaces now ask for fresh data every five seconds. `mayFetchNow` is the
// single choke point that decides what actually reaches GitHub, so it is the
// only thing standing between "live" and spending an hour's API budget in
// twenty minutes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayFetchNow, LIVE_INTERVAL_MS } from '../src/app-state.js';

const cache = ({ age = 0, remaining = 4900, resetIn = 3_600_000 } = {}) => ({
  fetchedAt: Date.now() - age,
  rateLimit: {
    remaining,
    limit: 5000,
    resetAt: new Date(Date.now() + resetIn).toISOString(),
  },
});

test('the very first fetch is always allowed', () => {
  assert.equal(mayFetchNow(null), true);
  assert.equal(mayFetchNow({}), true);
});

test('a healthy budget allows the live cadence', () => {
  // 5s ticks against a 4s floor: every tick gets through.
  assert.equal(mayFetchNow(cache({ age: LIVE_INTERVAL_MS })), true);
});

test('but never faster than the hard floor, however often it is asked', () => {
  assert.equal(mayFetchNow(cache({ age: 0 })), false);
  assert.equal(mayFetchNow(cache({ age: 1_000 })), false);
  assert.equal(mayFetchNow(cache({ age: 3_999 })), false);
  assert.equal(mayFetchNow(cache({ age: 4_000 })), true);
});

test('two surfaces polling at once cannot double the spend', () => {
  // Both tick at the same instant; the second one is refused because the
  // throttle is keyed on the shared cache, not on the caller.
  const shared = cache({ age: 5_000 });
  assert.equal(mayFetchNow(shared), true);
  const afterFirstFetch = { ...shared, fetchedAt: Date.now() };
  assert.equal(mayFetchNow(afterFirstFetch), false);
});

test('a low budget stretches the interval to a minute', () => {
  assert.equal(mayFetchNow(cache({ age: 5_000, remaining: 400 })), false);
  assert.equal(mayFetchNow(cache({ age: 30_000, remaining: 400 })), false);
  assert.equal(mayFetchNow(cache({ age: 60_000, remaining: 400 })), true);
});

test('an exhausted budget coasts on cache until the window resets', () => {
  assert.equal(
    mayFetchNow(cache({ age: 10 * 60_000, remaining: 50, resetIn: 60_000 })),
    false,
    'not even after ten minutes, while the window is still open'
  );
  assert.equal(
    mayFetchNow(cache({ age: 10 * 60_000, remaining: 50, resetIn: -1_000 })),
    true,
    'but immediately once it has reset'
  );
});

test('a missing resetAt fails closed rather than hammering', () => {
  const broken = { fetchedAt: Date.now() - 600_000, rateLimit: { remaining: 10 } };
  assert.equal(mayFetchNow(broken), false);
});

test('an absent rateLimit block is treated as healthy', () => {
  // GraphQL can return partial data; a missing budget must not wedge polling.
  assert.equal(mayFetchNow({ fetchedAt: Date.now() - 5_000 }), true);
  assert.equal(mayFetchNow({ fetchedAt: Date.now() - 100 }), false, 'floor still applies');
});

test('the advertised live interval clears the hard floor', () => {
  // If these ever cross, every other tick would silently be a no-op.
  assert.ok(
    LIVE_INTERVAL_MS >= 4_000,
    `live interval ${LIVE_INTERVAL_MS}ms is below the fetch floor`
  );
});

test('sustained polling stays inside the hourly budget', () => {
  // ~3 points per GraphQL round trip, 5,000 per hour.
  const perHour = 3_600_000 / LIVE_INTERVAL_MS;
  const points = perHour * 3;
  assert.ok(points < 5_000, `${points} points/hour would exhaust the budget`);
  assert.ok(points > 1_000, 'sanity: this is meant to be a real cost, not a rounding error');
});
