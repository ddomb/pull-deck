// `orca plugin check` renders the panel once per scenario. Each answers deck.state itself, so the
// check shows every state the Herdr mod draws without a live relay.
import { defineCheck } from 'orca/testing'
import { list, searchReply } from './fixtures'
import { toFound, toSnapshot } from './model.js'
import type { Snapshot } from './protocol'

const answer = (snapshot: Snapshot) => ({
  requests: {
    'deck.state': () => snapshot,
    'deck.search': ({ query }: { query: string }) => toFound(query, 200, JSON.stringify(searchReply(query))),
  },
})

export default defineCheck({
  list: answer(list),
  down: answer(toSnapshot(0, '')),
  onboarding: answer({ kind: 'onboarding' }),
  error: answer({ kind: 'error', message: 'GitHub answered 401: the token was revoked.' }),
  empty: answer({ ...list, scopes: { mine: [], reviewing: [], assigned: [] } }),
  truncatedStale: answer({ ...list, truncated: ['mine'], isStale: true }),
})
