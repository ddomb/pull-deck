// Turning "abv-4242" into one specific pull request.
//
// The shortcut URL is not a real address: no DNS zone owns `pull-dock`, and the
// request is never meant to leave the browser. The service worker catches the
// navigation and replaces it with the pull request the shorthand names.
//
// Everything here is pure — no chrome APIs, no network — because the matching
// rules are the part that can be quietly wrong. A *miss* is a mild annoyance;
// a *wrong hit* silently sends you to somebody else's pull request, and you may
// not notice until you have already commented on it. The tests exist for that
// asymmetry, and the boundary rules below are written to fail closed.

/** Hostnames the shortcut answers to. Both spellings, because both get typed. */
const STEMS = ['pull-deck', 'pull-dock', 'pulldeck', 'pulldock'];

/**
 * A single-label host works, but a corporate DNS search list can append its own
 * suffix and turn `pull-dock` into something that genuinely resolves. `.test`
 * is reserved by RFC 6761. Declarative redirects, rather than DNS behavior,
 * keep shortcut HTTP requests local when the extension is enabled.
 */
export const SHORTCUT_HOSTS = STEMS.flatMap((stem) => [stem, `${stem}.test`]);

const HOSTS = new Set(SHORTCUT_HOSTS);

/** Leading path segments that only say "this is a pull request". */
const NOISE = new Set(['pr', 'prs', 'pull', 'pulls', 'go']);

const ALNUM = /[a-z0-9]/;

function decodeSafe(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // a stray % is not worth throwing over
  }
}

/**
 * Read the shorthand out of a shortcut URL.
 *
 * Deliberately lenient about shape: `/pr/abv-4242`, `/abv-4242` and
 * `/pull/abv-4242` all mean the same thing, and nobody should have to remember
 * which one it was.
 *
 * @param {string} url
 * @returns {{query: string}|null} null when this is not a shortcut URL at all.
 */
export function parseShortcut(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!HOSTS.has(parsed.hostname.toLowerCase())) return null;

  const segments = parsed.pathname.split('/').filter(Boolean).map(decodeSafe);
  while (segments.length > 0 && NOISE.has(segments[0].toLowerCase())) segments.shift();

  let query = segments.join('/');
  if (!query) query = parsed.searchParams.get('q') ?? '';
  // "owner/repo#6081" arrives with the number parsed off as a fragment.
  if (parsed.hash) query += parsed.hash;

  return { query: query.trim() };
}

/**
 * Does `needle` appear in `haystack` as a whole token?
 *
 * The trailing guard is the one that matters. Plain substring matching says
 * "abv-424" is in "ABV-4242" and that "abv-4242" is in "ABV-42421" — two
 * different pull requests, both silently wrong. Requiring a non-alphanumeric
 * character (or an end) on each side rejects both, while still allowing the
 * separators branch names actually use: `feat/ABV-4242-sso`, `ABV-4242_fix`.
 */
export function containsToken(haystack, needle) {
  const hay = String(haystack ?? '').toLowerCase();
  const key = String(needle ?? '').toLowerCase();
  if (!hay || !key) return false;

  for (let at = hay.indexOf(key); at !== -1; at = hay.indexOf(key, at + 1)) {
    const before = at === 0 ? '' : hay[at - 1];
    const after = hay[at + key.length] ?? '';
    if (!ALNUM.test(before) && !ALNUM.test(after)) return true;
  }
  return false;
}

/** "acme/api#4120" or "acme/api/4120" or "api#4120" → the repo and the number. */
function splitRepoNumber(query) {
  const match = /^(.*?)[#/](\d+)$/.exec(query);
  if (!match || !match[1]) return null;
  return { repo: match[1].replace(/\/+$/, ''), number: Number(match[2]) };
}

/** `part` may name the repo alone ("api") or with its owner ("acme/api"). */
function repoMatches(fullName, part) {
  if (!fullName || !part) return false;
  if (fullName === part) return true;
  return fullName.slice(fullName.indexOf('/') + 1) === part;
}

/**
 * How good a match this pull request is, lowest wins. null means no match.
 *
 * The order encodes intent: an explicit number is unambiguous, a ticket id in
 * the branch is what the shortcut is for, and a loose substring is the last
 * resort that only runs when nothing better matched anywhere in the list.
 */
function tierFor(query, pr) {
  const q = query.toLowerCase();
  const branch = String(pr.headRefName ?? '');
  const title = String(pr.title ?? '');

  const explicit = splitRepoNumber(q);
  if (explicit) {
    return explicit.number === pr.number &&
      repoMatches(String(pr.repo ?? '').toLowerCase(), explicit.repo)
      ? 0
      : null;
  }

  const bare = q.replace(/^#/, '');
  if (/^\d+$/.test(bare)) return Number(bare) === pr.number ? 1 : null;

  if (containsToken(branch, q)) return 2;
  if (containsToken(title, q)) return 3;
  if (/^[a-z][a-z0-9]*-\d+$/.test(q)) return null;
  if (branch.toLowerCase().includes(q)) return 4;
  if (title.toLowerCase().includes(q)) return 5;
  return null;
}

/**
 * Which open pull requests does this shorthand name?
 *
 * Only the best tier is returned, and ties are never broken. Two pull requests
 * carrying the same ticket is ordinary — a stacked branch, a revert, a
 * cherry-pick to a release branch — and guessing between them is exactly the
 * wrong-hit failure this file is built to avoid. The caller shows a chooser.
 *
 * @param {string} query
 * @param {object[]} pullRequests
 * @returns {{status: 'one'|'many'|'none'|'empty', matches: object[], all: object[]}}
 */
export function findMatches(query, pullRequests) {
  const q = String(query ?? '').trim();
  const all = Array.isArray(pullRequests) ? pullRequests : [];
  if (!q) return { status: 'empty', matches: [], all };

  let best = Infinity;
  const scored = [];
  for (const pr of all) {
    const tier = tierFor(q, pr);
    if (tier === null) continue;
    scored.push({ pr, tier });
    if (tier < best) best = tier;
  }

  const matches = scored.filter((entry) => entry.tier === best).map((entry) => entry.pr);
  if (matches.length === 0) return { status: 'none', matches: [], all };
  return { status: matches.length === 1 ? 'one' : 'many', matches, all };
}
