// Identity for a pull request tab.
//
// The whole "don't open it twice" promise rests on this file. A PR that is
// already open is rarely sitting at the canonical URL: it is at /files, or
// /commits, or carries #issuecomment-123, or ?w=1 from a whitespace-diff
// toggle. Matching full URL strings misses every one of those and duplicates
// the tab, so identity is the (host, owner, repo, number) tuple instead.

/**
 * @param {string} url
 * @returns {string|null} A stable key like "github.com/acme/api#4120", or null
 *   if the URL is not a pull request page.
 */
export function pullRequestKey(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  // /{owner}/{repo}/pull/{number}[/anything]
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 4) return null;
  const [owner, repo, kind, number] = parts;
  if (kind !== 'pull' && kind !== 'pulls') return null;
  if (!/^\d+$/.test(number)) return null;

  const host = parsed.host.toLowerCase().replace(/^www\./, '');
  return `${host}/${owner.toLowerCase()}/${repo.toLowerCase()}#${Number(number)}`;
}

/** True when both URLs point at the same pull request, ignoring sub-path. */
export function isSamePullRequest(a, b) {
  const ka = pullRequestKey(a);
  return ka !== null && ka === pullRequestKey(b);
}
