export type Scope = 'mine' | 'reviewing' | 'assigned'

export type PullRequest = {
  id: string
  number: number
  title: string
  url: string
  repo: string
  isDraft: boolean
  updatedAt: string
  additions: number
  deletions: number
  reviewDecision: string | null
  checks: string | null
  /** The extension's canonical identity, matched against the tab group's keys. */
  key: string | null
}

/** What the relay's viewer socket last said, reduced to what the pane draws. */
export type Snapshot =
  | { kind: 'down'; reason: string }
  | { kind: 'onboarding' }
  | { kind: 'error'; message: string }
  | {
      kind: 'list'
      scopes: Record<Scope, PullRequest[]>
      truncated: Scope[]
      isStale: boolean
      fetchedAt: number | null
      warning: string | null
      login: string | null
      groupTitle: string
      groupKeys: string[]
      isGroupElsewhere: boolean
    }

/** The relay's `POST /search` answer for one query, ids in the bridge's rank order. */
export type Found =
  | { query: string; kind: 'hits'; prIds: string[]; isStale: boolean }
  | { query: string; kind: 'failed'; message: string }

declare module 'claude-code' {
  interface PluginState {
    'pull-deck': {
      snapshot: Snapshot | null
      scope: Scope | null
      opening: string | null
      query: string
      found: Found | null
    }
  }
}
