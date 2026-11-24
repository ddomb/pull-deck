// A relay `GET /state` reply and `/search` answers for the tests and check scenarios, shaped as
// the relay sends them (BRIDGE.md, "Viewer socket"), with made-up ids, titles, repo and login.
import { toSnapshot } from './model.js'

const pr = (n: number, extra: Record<string, unknown>) => ({
  id: `pr-${n}`,
  number: n,
  title: `ABV-${n}: ${extra.title ?? 'Change'}`,
  url: `https://github.com/acme/above/pull/${n}`,
  repo: 'acme/above',
  key: `github.com/acme/above#${n}`,
  updatedAt: '2026-11-24T09:00:00Z',
  isDraft: false,
  reviewDecision: null,
  checks: 'SUCCESS',
  additions: 120,
  deletions: 14,
  ...extra,
})

export const state = {
  app: true,
  error: null,
  state: {
    stage: 'list',
    viewer: { login: 'octo' },
    settings: { groupTitle: 'Pull Requests' },
    group: { keys: ['github.com/acme/above#1003'], otherWindow: false },
    truncated: {},
    stale: false,
    fetchedAt: 1,
    scopes: {
      mine: [
        pr(1001, { title: 'Cache the shard plan', checks: 'PENDING', additions: 225, deletions: 20 }),
        pr(1002, { title: 'Shorten the coverage job', reviewDecision: 'APPROVED' }),
        pr(1003, { title: 'Start CI on draft PRs', isDraft: true, checks: 'FAILURE', additions: 12_400 }),
      ],
      reviewing: [pr(2001, { title: 'Retry Slack sends on 429', reviewDecision: 'REVIEW_REQUIRED' })],
      assigned: [],
    },
  },
}

export const replies: Record<string, string[]> = {
  ci: ['pr-1003', 'pr-1002'],
  abv: ['pr-1001', 'pr-1002', 'pr-1003', 'pr-2001'],
  'zzzz-nomatch': [],
}

/** What the relay's `/search` answers for one query. */
export const searchReply = (query: string) => ({
  ok: true,
  error: null,
  data: { status: 'many', prIds: replies[query] ?? [], stale: false },
})

/** The state reply as the worker answers it. */
export const list = (() => {
  const snapshot = toSnapshot(200, JSON.stringify(state))
  if (snapshot.kind !== 'list') throw Error('the fixture state is not a list')
  return snapshot
})()
