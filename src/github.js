// GitHub GraphQL client.
//
// GraphQL rather than REST/search because a row shows review decision and CI
// rollup, and /search/issues returns neither: on REST that becomes two extra
// requests per pull request. One GraphQL document covers all three scopes, the
// viewer identity, and the rate-limit budget in a single round trip.

const ENDPOINT = 'https://api.github.com/graphql';

const SCOPE_QUERIES = {
  mine: 'is:pr is:open archived:false author:@me sort:updated-desc',
  reviewing: 'is:pr is:open archived:false review-requested:@me sort:updated-desc',
  assigned: 'is:pr is:open archived:false assignee:@me sort:updated-desc',
};

export const SCOPES = /** @type {const} */ (['mine', 'reviewing', 'assigned']);

const DOCUMENT = `
query PullDeck($mine: String!, $reviewing: String!, $assigned: String!, $first: Int!) {
  viewer { login avatarUrl(size: 64) }
  mine: search(query: $mine, type: ISSUE, first: $first) { pageInfo { hasNextPage } nodes { ...PullDeckPR } }
  reviewing: search(query: $reviewing, type: ISSUE, first: $first) { pageInfo { hasNextPage } nodes { ...PullDeckPR } }
  assigned: search(query: $assigned, type: ISSUE, first: $first) { pageInfo { hasNextPage } nodes { ...PullDeckPR } }
  rateLimit { remaining limit resetAt cost }
}

fragment PullDeckPR on PullRequest {
  id
  number
  title
  url
  isDraft
  updatedAt
  additions
  deletions
  reviewDecision
  headRefName
  repository { nameWithOwner }
  commits(last: 1) {
    nodes { commit { statusCheckRollup { state } } }
  }
}`;

/** Failure the UI can act on, rather than a generic throw. */
export class GitHubError extends Error {
  /**
   * @param {'badToken'|'forbidden'|'rateLimited'|'offline'|'server'|'malformed'|'partial'|'timeout'} kind
   * @param {string} message
   * @param {{retryAt?: Date}} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
    this.retryAt = extra.retryAt;
  }
}

function parseRetryAt(headers) {
  const retryAfter = headers.get('retry-after');
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return new Date(Date.now() + Number(retryAfter) * 1000);
  }
  const reset = headers.get('x-ratelimit-reset');
  if (headers.get('x-ratelimit-remaining') === '0' && reset && /^\d+$/.test(reset))
    return new Date(Number(reset) * 1000);
  return undefined;
}

/**
 * Fetch every scope plus the viewer in one request.
 * @param {string} token
 * @param {{first?: number, signal?: AbortSignal}} [options]
 */
export async function fetchPullRequests(token, options = {}) {
  const { first = 50, signal, timeoutMs = 15_000 } = options;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(abort, timeoutMs);

  try {
    return await requestPullRequests(token, first, controller.signal);
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Request superseded.', 'AbortError');
    if (controller.signal.aborted)
      throw new GitHubError('timeout', 'GitHub did not respond within 15 seconds. Try again.');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

async function requestPullRequests(token, first, signal) {
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        query: DOCUMENT,
        variables: { ...SCOPE_QUERIES, first },
      }),
    });
  } catch (cause) {
    if (cause?.name === 'AbortError') throw cause;
    throw new GitHubError('offline', 'Could not reach github.com.');
  }

  if (response.status === 401) {
    throw new GitHubError('badToken', 'GitHub rejected this token.');
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) throw new GitHubError('server', `GitHub returned ${response.status}.`);
    throw new GitHubError('malformed', 'GitHub sent a response Pull Deck could not read.');
  }

  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const types = errors.map((e) => e?.type);
  const messages = [payload?.message, ...errors.map((e) => e?.message)].filter(Boolean).join(' ');
  const limited =
    response.status === 429 ||
    ((!response.ok || errors.length > 0) &&
      response.headers.get('x-ratelimit-remaining') === '0') ||
    types.includes('RATE_LIMITED') ||
    /secondary rate limit|abuse detection/i.test(messages);
  if (limited)
    throw new GitHubError('rateLimited', 'GitHub rate limit reached.', {
      retryAt: parseRetryAt(response.headers) ?? new Date(Date.now() + 60_000),
    });
  if (response.status === 403)
    throw new GitHubError('forbidden', 'This token is not allowed to read those repositories.');
  if (!response.ok) throw new GitHubError('server', `GitHub returned ${response.status}.`);

  // GraphQL reports most failures inside a 200.
  if (errors.length > 0) {
    const first = errors[0]?.message || 'GitHub rejected the query.';
    if (types.includes('FORBIDDEN') || types.includes('INSUFFICIENT_SCOPES')) {
      throw new GitHubError('forbidden', first);
    }
    if (!payload.data?.viewer) throw new GitHubError('malformed', first);
    throw new GitHubError(
      'partial',
      'GitHub returned incomplete pull request data. The last complete list is retained.'
    );
  }

  const data = payload?.data;
  if (!data?.viewer?.login) {
    throw new GitHubError('malformed', 'GitHub did not return an account for this token.');
  }

  const scopes = {},
    truncated = {};
  for (const scope of SCOPES) {
    if (!Array.isArray(data[scope]?.nodes))
      throw new GitHubError('partial', `GitHub did not return the ${scope} list. Try again.`);
    truncated[scope] = Boolean(data[scope].pageInfo?.hasNextPage);
    scopes[scope] = data[scope].nodes.filter((node) => node && node.number).map(normalize);
  }

  return {
    viewer: { login: data.viewer.login, avatarUrl: data.viewer.avatarUrl },
    scopes,
    truncated,
    rateLimit: data.rateLimit ?? null,
    fetchedAt: Date.now(),
  };
}

/** Flatten a GraphQL node into the shape the UI renders. */
function normalize(node) {
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
  return {
    id: node.id,
    number: node.number,
    title: node.title,
    url: node.url,
    repo: node.repository?.nameWithOwner ?? '',
    // The branch, so a ticket id can be looked up without another round trip.
    // Always a string once fetched: `undefined` is how resolve-time code tells
    // a cache written before this field existed from one that simply has none.
    headRefName: node.headRefName ?? '',
    isDraft: Boolean(node.isDraft),
    updatedAt: node.updatedAt,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    reviewDecision: node.reviewDecision ?? null,
    checks: rollup,
  };
}

/** Distinct pull requests across every scope, newest first. */
export function mergeScopes(scopes) {
  const seen = new Map();
  for (const scope of SCOPES) {
    for (const pr of scopes[scope] ?? []) {
      if (!seen.has(pr.id)) seen.set(pr.id, pr);
    }
  }
  return [...seen.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
