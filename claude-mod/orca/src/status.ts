// What the status bar item says for a snapshot: your pull request count, reviews waiting on you,
// and a danger tone when one of yours has failed checks or requested changes.
import { chips } from './model.js'
import type { Snapshot } from './protocol'

export type Status = { text: string; tone: 'neutral' | 'accent' | 'warning' | 'danger'; tooltip: string }

export function statusOf(snapshot: Snapshot): Status {
  if (snapshot.kind === 'down') return { text: 'Pull Deck', tone: 'warning', tooltip: snapshot.reason }
  if (snapshot.kind === 'onboarding')
    return { text: 'Pull Deck', tone: 'warning', tooltip: 'Connect GitHub in the Pull Deck extension.' }
  if (snapshot.kind === 'error') return { text: 'Pull Deck', tone: 'warning', tooltip: snapshot.message }
  const { mine, reviewing, assigned } = snapshot.scopes
  const more = (scope: 'mine' | 'reviewing' | 'assigned') => (snapshot.truncated.includes(scope) ? '+' : '')
  const hurt = mine.filter(pr => chips(pr).some(c => c.color === 'error')).length
  const text = `${mine.length}${more('mine')}${reviewing.length ? ` · ${reviewing.length}${more('reviewing')} to review` : ''}`
  const tooltip = [
    `Mine ${mine.length}${more('mine')} · Reviews ${reviewing.length}${more('reviewing')} · Assigned ${assigned.length}${more('assigned')}.`,
    hurt ? `${hurt} of yours ${hurt === 1 ? 'needs' : 'need'} attention: failed checks or changes requested.` : '',
    snapshot.isStale ? 'The list may be out of date.' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return { text, tone: hurt ? 'danger' : reviewing.length ? 'accent' : 'neutral', tooltip }
}
