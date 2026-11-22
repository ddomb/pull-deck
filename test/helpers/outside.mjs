// GitHub answers for pull requests outside the viewer's scopes, built from
// test/fixtures/outside-lookup.json: real hit lists for real tickets, with
// branch and title words replaced by "w" and the author prefix by "dev/".
import { readFileSync } from 'node:fs';

export const outsideCases = JSON.parse(
  readFileSync(new URL('../fixtures/outside-lookup.json', import.meta.url), 'utf8')
);

/** The hit list GitHub returned for this ticket and query form ("quoted" or "plain"). */
export const outsideCase = (ticket, query = 'quoted') =>
  outsideCases.find((c) => c.ticket === ticket && c.query === query);

/** A recorded hit as the GraphQL node the lookup document asks for. */
export const node = (hit) => ({
  id: `PR_${hit.number}`,
  number: hit.number,
  title: hit.title,
  url: `https://github.com/Above-Security/above/pull/${hit.number}`,
  isDraft: false,
  updatedAt: '2026-11-22T08:06:10Z',
  additions: 1,
  deletions: 1,
  reviewDecision: null,
  headRefName: hit.headRefName,
  repository: { nameWithOwner: 'Above-Security/above' },
  commits: { nodes: [] },
});

const rateLimit = { remaining: 4800, limit: 5000, resetAt: '2026-11-22T10:00:00Z', cost: 1 };

/** Answers the two lookup documents from the fixture; anything else is a test bug. */
export function lookupFetch(calls = []) {
  return async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.variables.q !== undefined) {
      const ticket = /"([^"]+)"/.exec(body.variables.q)[1];
      const hits = outsideCase(ticket)?.hits ?? [];
      return Response.json({
        data: {
          search: { pageInfo: { hasNextPage: false }, nodes: hits.map(node) },
          rateLimit,
        },
      });
    }
    if (body.variables.number !== undefined) {
      const hit = outsideCases
        .flatMap((c) => c.hits)
        .find((h) => h.number === body.variables.number);
      if (!hit)
        return Response.json({
          data: { repository: { pullRequest: null }, rateLimit },
          errors: [{ type: 'NOT_FOUND', path: ['repository', 'pullRequest'], message: 'Nope' }],
        });
      return Response.json({ data: { repository: { pullRequest: node(hit) }, rateLimit } });
    }
    throw Error(`Unexpected GitHub document: ${body.query.slice(0, 80)}`);
  };
}
