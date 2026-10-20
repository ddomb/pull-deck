import type { PullRequest, Scope, Snapshot } from '../types'

export const SCOPES: readonly { scope: Scope; label: string; hotkey: string }[] = [
  { scope: 'mine', label: 'Mine', hotkey: 'm' },
  { scope: 'reviewing', label: 'Reviews', hotkey: 'r' },
  { scope: 'assigned', label: 'Assigned', hotkey: 'a' },
]

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const messageOf = (value: unknown): string | null =>
  isObject(value) && typeof value.message === 'string' ? value.message : null

const DOWN =
  'The Pull Deck bridge is not reachable. Open Chrome with the Pull Deck extension; install the bridge once by opening Pull Deck.app.'

/** The relay's `GET /state` answer, checked field by field: it is outside data. */
export function toSnapshot(status: number, text: string): Snapshot {
  if (status === 0) return { kind: 'down', reason: DOWN }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { kind: 'error', message: `The bridge answered ${status} with something that is not JSON.` }
  }
  if (!isObject(body)) return { kind: 'error', message: 'The bridge answered with an unexpected shape.' }
  if (status !== 200) return { kind: 'error', message: messageOf(body) ?? String(body.error ?? status) }
  const state = body.state
  if (!isObject(state)) {
    return {
      kind: 'error',
      message: messageOf(body.error) ?? 'The extension has not sent any pull requests yet.',
    }
  }
  if (state.stage === 'onboarding') return { kind: 'onboarding' }
  if (state.stage !== 'list') {
    return { kind: 'error', message: messageOf(state.error) ?? 'The extension could not load pull requests.' }
  }
  const raw = isObject(state.scopes) ? state.scopes : {}
  const truncated = isObject(state.truncated) ? state.truncated : {}
  const scopes = {} as Record<Scope, PullRequest[]>
  for (const { scope } of SCOPES) {
    const list = Array.isArray(raw[scope]) ? raw[scope] : []
    scopes[scope] = list.filter(isObject).flatMap(toPullRequest)
  }
  return {
    kind: 'list',
    scopes,
    truncated: SCOPES.map(s => s.scope).filter(scope => truncated[scope] === true),
    isStale: state.stale === true,
    fetchedAt: typeof state.fetchedAt === 'number' ? state.fetchedAt : null,
    warning: messageOf(state.error),
    login: isObject(state.viewer) && typeof state.viewer.login === 'string' ? state.viewer.login : null,
    groupTitle:
      isObject(state.settings) && typeof state.settings.groupTitle === 'string'
        ? state.settings.groupTitle
        : 'Pull Requests',
    groupKeys:
      isObject(state.group) && Array.isArray(state.group.keys)
        ? state.group.keys.filter((key): key is string => typeof key === 'string')
        : [],
    isGroupElsewhere: isObject(state.group) && state.group.otherWindow === true,
  }
}

function toPullRequest(pr: Json): PullRequest[] {
  if (typeof pr.id !== 'string' || typeof pr.title !== 'string' || typeof pr.url !== 'string') return []
  return [
    {
      id: pr.id,
      number: typeof pr.number === 'number' ? pr.number : 0,
      title: pr.title,
      url: pr.url,
      repo: typeof pr.repo === 'string' ? pr.repo : '',
      isDraft: pr.isDraft === true,
      updatedAt: typeof pr.updatedAt === 'string' ? pr.updatedAt : '',
      additions: typeof pr.additions === 'number' ? pr.additions : 0,
      deletions: typeof pr.deletions === 'number' ? pr.deletions : 0,
      reviewDecision: typeof pr.reviewDecision === 'string' ? pr.reviewDecision : null,
      checks: typeof pr.checks === 'string' ? pr.checks : null,
      key: typeof pr.key === 'string' ? pr.key : null,
    },
  ]
}

/** The scope the pane shows: the person's pick, else the first with rows. */
export function shownScope(snapshot: Snapshot | null, picked: Scope | null): Scope {
  if (picked) return picked
  if (snapshot?.kind !== 'list') return 'mine'
  return SCOPES.find(({ scope }) => snapshot.scopes[scope].length > 0)?.scope ?? 'mine'
}

export type Chip = { text: string; glyph: string; color: 'success' | 'error' | 'warning' | 'subtle' }

/** The menu bar app's badges (MenuContent.swift badgeItems), as words. */
export function chips(pr: PullRequest): Chip[] {
  const out: Chip[] = []
  if (pr.isDraft) out.push({ text: 'Draft', glyph: '◌', color: 'subtle' })
  if (pr.reviewDecision === 'APPROVED') out.push({ text: 'Approved', glyph: '✓', color: 'success' })
  else if (pr.reviewDecision === 'CHANGES_REQUESTED') out.push({ text: 'Changes', glyph: '⊖', color: 'error' })
  else if (pr.reviewDecision === 'REVIEW_REQUIRED' && !pr.isDraft)
    out.push({ text: 'In review', glyph: '◷', color: 'subtle' })
  if (pr.checks === 'FAILURE' || pr.checks === 'ERROR') out.push({ text: 'Checks failed', glyph: '✕', color: 'error' })
  else if (pr.checks === 'PENDING' || pr.checks === 'EXPECTED')
    out.push({ text: 'Checks running', glyph: '◌', color: 'warning' })
  return out
}

/** The menu bar app's dock footnote (MenuContent.swift footnote). */
export function footnote(total: number, pending: number, isTruncated: boolean, isElsewhere: boolean): string {
  if (isTruncated) return 'Showing the 50 most recently updated pull requests.'
  if (isElsewhere) return 'The group lives in another window.'
  const already = total - pending
  if (already > 0 && pending > 0) return `${already} already there, so ${already === 1 ? 'it stays' : 'they stay'} put.`
  return ''
}

/** The dock button's words (MenuContent.swift dock). */
export function dockLabel(total: number, pending: number, groupTitle: string): string {
  if (pending === 0) return total === 0 ? 'Nothing to open' : `All ${total} in “${groupTitle}”`
  return `Open ${pending} in “${groupTitle}”`
}

export function age(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const minutes = Math.max(0, Math.round((now - then) / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** The first failure an open reported, or why the call itself failed. */
export function openFailure(status: number, text: string): string | null {
  if (status === 0) return DOWN
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return `The bridge answered ${status}.`
  }
  if (!isObject(body)) return `The bridge answered ${status}.`
  if (status !== 200) return typeof body.error === 'string' ? body.error : `The bridge answered ${status}.`
  if (body.ok !== true) return messageOf(body.error) ?? 'The extension could not open it.'
  const failures = isObject(body.data) && Array.isArray(body.data.failures) ? body.data.failures : []
  return failures.length > 0 ? (messageOf(failures[0]) ?? 'A tab could not be opened.') : null
}
