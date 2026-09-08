import { fetchPullRequests, GitHubError } from './github.js';
import { readSettings, writeSettings, withSettingsLock } from './store.js';
import { refreshBadge } from './badge.js';
import { serializeError } from './errors.js';

export const CACHE_TTL_MS = 60_000;
export const LIVE_INTERVAL_MS = 5_000;
const MIN_INTERVAL_MS = 4_000;
let epoch = 0;
let inFlight = null;

export function mayFetchNow(cache, now = Date.now()) {
  if (!cache?.fetchedAt) return true;
  const remaining = cache.rateLimit?.remaining;
  if (typeof remaining === 'number' && remaining < 100) {
    const resetAt = Date.parse(cache.rateLimit?.resetAt ?? '');
    return Number.isFinite(resetAt) && now >= resetAt;
  }
  return (
    now - cache.fetchedAt >=
    (typeof remaining === 'number' && remaining < 500 ? 60_000 : MIN_INTERVAL_MS)
  );
}

export const isStale = (cache) => !cache || Date.now() - cache.fetchedAt > CACHE_TTL_MS;
export const authEpoch = () => epoch;

function invalidate() {
  epoch++;
  inFlight?.controller.abort();
  inFlight = null;
  return epoch;
}

async function currentFor(entry) {
  const settings = await readSettings();
  return entry.epoch === epoch &&
    settings.token === entry.token &&
    settings.authRevision === entry.revision
    ? settings
    : null;
}

async function performRefresh(entry) {
  try {
    const allowed = await withSettingsLock(async () => {
      const current = await currentFor(entry);
      if (!current || Date.now() < current.nextFetchAt || !mayFetchNow(current.cache)) return false;
      await writeSettings({ nextFetchAt: Date.now() + MIN_INTERVAL_MS });
      return true;
    });
    if (!allowed || entry.epoch !== epoch) return;
    const cache = await fetchPullRequests(entry.token, { signal: entry.controller.signal });
    await withSettingsLock(async () => {
      const current = await currentFor(entry);
      if (!current) return;
      await writeSettings({ cache, lastError: null, fetchFailures: 0 });
      await refreshBadge(cache, current);
    });
  } catch (error) {
    await withSettingsLock(async () => {
      const current = await currentFor(entry);
      if (!current) return;
      const failures = current.fetchFailures + 1;
      const fallback = Date.now() + Math.min(15 * 60_000, 10_000 * 2 ** Math.min(failures - 1, 7));
      const serialized = serializeError(error);
      const deadline = Date.parse(serialized.retryAt ?? '');
      await writeSettings({
        lastError: serialized,
        fetchFailures: failures,
        nextFetchAt: Number.isFinite(deadline) ? deadline : fallback,
      });
    });
  }
}

/** All ordinary callers share one request and one persisted cooldown. */
export async function refreshSnapshot({ force = false, branches = false } = {}) {
  const started = epoch;
  const settings = await readSettings();
  if (started !== epoch) return refreshSnapshot();
  if (!settings.token) return settings;
  if (inFlight?.epoch === epoch) {
    await inFlight.promise;
    return readSettings();
  }
  const missingBranches =
    branches &&
    Object.values(settings.cache?.scopes ?? {})
      .flat()
      .some((pr) => typeof pr.headRefName !== 'string');
  if (!force && !isStale(settings.cache) && !missingBranches) return settings;
  if (Date.now() < settings.nextFetchAt || !mayFetchNow(settings.cache)) return settings;

  const entry = {
    epoch,
    token: settings.token,
    revision: settings.authRevision,
    controller: new AbortController(),
    promise: null,
  };
  inFlight = entry;
  entry.promise = performRefresh(entry).finally(() => {
    if (inFlight === entry) inFlight = null;
  });
  await entry.promise;
  return readSettings();
}

export async function forgetAccount() {
  const changed = invalidate();
  await withSettingsLock(async () => {
    if (changed !== epoch) return;
    const settings = await readSettings();
    await writeSettings({
      token: '',
      cache: null,
      lastError: null,
      nextFetchAt: 0,
      fetchFailures: 0,
      authRevision: settings.authRevision + 1,
    });
    await refreshBadge(null, settings);
  });
  return changed;
}

export async function connectAccount(token) {
  const trimmed = String(token ?? '').trim();
  if (!trimmed) throw new GitHubError('badToken', 'Paste a token first.');
  const changed = await forgetAccount();
  if (changed !== epoch) return readSettings();
  const entry = { epoch: changed, controller: new AbortController(), promise: null };
  inFlight = entry;
  entry.promise = (async () => {
    const cache = await fetchPullRequests(trimmed, { signal: entry.controller.signal });
    await withSettingsLock(async () => {
      if (changed !== epoch) return;
      const settings = await readSettings();
      await writeSettings({
        token: trimmed,
        cache,
        lastError: null,
        authRevision: settings.authRevision + 1,
        nextFetchAt: Date.now() + MIN_INTERVAL_MS,
      });
      await refreshBadge(cache, settings);
    });
  })().finally(() => {
    if (inFlight === entry) inFlight = null;
  });
  try {
    await entry.promise;
  } catch (error) {
    if (changed === epoch) throw error;
  }
  return readSettings();
}
