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
    }

declare module 'claude-code' {
  interface PluginState {
    'pull-deck': {
      snapshot: Snapshot | null
      scope: Scope | null
      opening: string | null
    }
  }
}
