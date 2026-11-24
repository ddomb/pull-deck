// The components panel over a stand-in worker that answers from src/fixtures.ts. Its rows
// must be exactly the shared model's deckRows, the list the Herdr and Claude Code mods draw.
import { assert, mockHost, mount, test } from 'orca/testing'
import { searchReply, state } from './fixtures'
import { deckRows, toFound, toSnapshot } from './model.js'
import * as panel from './panel'
import type { Opened } from './protocol'

const snapshot = toSnapshot(200, JSON.stringify(state))
const search = ({ query }: { query: string }) => toFound(query, 200, JSON.stringify(searchReply(query)))

function host(opened: { prId?: string; scope?: string }[] = [], answer: Opened = { ok: true, focused: false }) {
  return mockHost({
    requests: {
      'deck.state': () => snapshot,
      'deck.search': search,
      'deck.open': ({ prId }) => (opened.push({ prId }), answer),
      'deck.openAll': ({ scope }) => (opened.push({ scope }), answer),
    },
  })
}

/** The drawn rows top to bottom, by the pr-<id> key each ListItem carries. */
const drawn = (view: Awaited<ReturnType<typeof mount>>) =>
  view.findAll({ type: 'ListItem' }).map(item => item.key)

test('draws the scope rows in the shared model order', async () => {
  const view = await mount(panel, { host: host() })
  if (snapshot.kind !== 'list') throw Error('fixture is not a list')
  assert.deepEqual(
    drawn(view),
    deckRows(snapshot, 'mine', null).map(row => `pr-${row.pr.id}`),
  )
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('search shows the bridge matches, and Enter opens the top one', async () => {
  const opened: { prId?: string }[] = []
  const view = await mount(panel, { host: host(opened) })
  if (snapshot.kind !== 'list') throw Error('fixture is not a list')
  await view.type({ label: 'Search' }, 'ci')
  assert.deepEqual(
    drawn(view),
    deckRows(snapshot, 'mine', search({ query: 'ci' })).map(row => `pr-${row.pr.id}`),
  )
  await view.submit({ label: 'Search' })
  assert.deepEqual(opened, [{ prId: 'pr-1003' }])
  await view.unmount()
})

test('a search with no match says the snapshot does not hold it', async () => {
  const view = await mount(panel, { host: host() })
  await view.type({ label: 'Search' }, 'zzzz-nomatch')
  assert.equal(view.findAll({ type: 'ListItem' }).length, 0)
  assert.ok(view.find({ text: /Not in your snapshot/ }))
  await view.unmount()
})

test('the dock opens the whole scope and shows a failure in words', async () => {
  const opened: { scope?: string }[] = []
  const view = await mount(panel, { host: host(opened, { ok: false, message: 'Tab could not be grouped' }) })
  await view.press({ text: /^Open \d+ in/ })
  assert.deepEqual(opened, [{ scope: 'mine' }])
  assert.ok(view.find({ text: /Tab could not be grouped/ }))
  await view.unmount()
})
