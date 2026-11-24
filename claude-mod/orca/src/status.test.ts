// The status bar item's words and tone for each snapshot.
import { assert, test } from 'orca/testing'
import { list } from './fixtures'
import { toSnapshot } from './model.js'
import { statusOf } from './status'


test('counts yours and the reviews waiting, in danger when one of yours is failing', () => {
  const status = statusOf(list)
  assert.equal(status.text, '3 · 1 to review')
  assert.equal(status.tone, 'danger')
  assert.match(status.tooltip, /Mine 3 · Reviews 1 · Assigned 0\. 1 of yours needs attention/)
})

test('is accent with only reviews waiting, and neutral with nothing to do', () => {
  const calm = list.scopes.mine.filter(pr => pr.checks !== 'FAILURE')
  assert.equal(statusOf({ ...list, scopes: { ...list.scopes, mine: calm } }).tone, 'accent')
  assert.equal(statusOf({ ...list, scopes: { mine: calm, reviewing: [], assigned: [] } }).tone, 'neutral')
})

test('marks a truncated scope and warns when the bridge is down', () => {
  assert.equal(statusOf({ ...list, truncated: ['mine'] }).text, '3+ · 1 to review')
  const down = statusOf(toSnapshot(0, ''))
  assert.equal(down.tone, 'warning')
  assert.match(down.tooltip, /bridge is not reachable/)
})
