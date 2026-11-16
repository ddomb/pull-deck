import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { deckRows, metaLine, shownScope, toFound, toSnapshot } from '../herdr/model.js'
import type { Scope } from '../types'
import { fifty, live } from './herdr-fixtures.js'

// The Herdr.app mod (herdr/main.js) draws exactly deckRows(...) for its list and its search, so these
// replay one relay reply through that function and through this pane, and ask for the same rows in
// the same order, with the same second line.

type Replay = { state: unknown; replies: { query: string; data: unknown }[] }

const PANE = {
  component: 'Pane',
  requestId: 'pull-deck',
  props: {
    title: 'Pull Deck',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 200 },
    view: {},
  },
} as const

function relay(on: On, replay: Replay) {
  on('env.get', async ($, e) => ({
    value: e.name === 'PULLDECK_VIEWER_SOCKET' ? '/fake/viewer.sock' : '/Users/someone',
  }))
  on('http.fetch', async ($, e) => {
    const query = e.url.endsWith('/search') ? JSON.parse(String(e.init?.body ?? '{}')).query : null
    const body =
      query === null ? replay.state : { ok: true, error: null, data: replay.replies.find(r => r.query === query)?.data }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', async () => ({ value: [] }))
  on('ui.toast', async () => ({ value: undefined }))
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
}

async function mount($: Engine) {
  await $.command.run({
    command: 'pull-deck',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  return $.ui.mount({ plugin: 'pull-deck', surface: 'desktop', ...PANE })
}

/** The pane's rows top to bottom: each row's title button is keyed pr-<id>. */
async function drawnIds(ui: Awaited<ReturnType<typeof mount>>) {
  const buttons = await ui.findAll({ type: 'Button' })
  return buttons.flatMap(b => (typeof b.key === 'string' && b.key.startsWith('pr-') ? [b.key.slice(3)] : []))
}

/** What the Herdr mod draws for the same reply: deckRows over the same snapshot. */
function herdrRows(replay: Replay, scope: Scope, query: string | null) {
  const snapshot = toSnapshot(200, JSON.stringify(replay.state))
  if (snapshot.kind !== 'list') throw new Error(`fixture is not a list: ${snapshot.kind}`)
  const reply = query === null ? null : replay.replies.find(r => r.query === query)
  const found = reply ? toFound(query!, 200, JSON.stringify({ ok: true, error: null, data: reply.data })) : null
  return { snapshot, rows: deckRows(snapshot, scope, found) }
}

for (const [name, replay] of [
  ['live capture', live],
  ['50 pull requests', fifty],
] as const) {
  test(`${name}: every scope lists the same rows in the same order as the Herdr mod`, async ($, on) => {
    relay(on, replay)
    const ui = await mount($)
    const { snapshot } = herdrRows(replay, 'mine', null)
    for (const scope of ['mine', 'reviewing', 'assigned'] as const) {
      await ui.press({ key: `scope-${scope}` })
      const { rows } = herdrRows(replay, scope, null)
      expect(await drawnIds(ui), `${scope} order`).toEqual(rows.map(r => r.pr.id))
      const relayed = (replay.state as { state: { scopes: Record<Scope, { id: string }[]> } }).state.scopes[scope]
      expect(await drawnIds(ui), `${scope} is the relay's order`).toEqual(relayed.map(pr => pr.id))
      for (const { pr, labels } of rows.slice(0, 5)) {
        const meta = await ui.find({ key: `meta-${pr.id}` })
        expect(meta?.text, `${scope} ${pr.id} second line`).toContain(metaLine(pr, labels, Date.now()))
      }
    }
    expect(shownScope(snapshot, null)).toBe('mine')
    await ui.unmount()
  })

  test(`${name}: every recorded search shows the bridge's ranking, the same as the Herdr mod`, async ($, on) => {
    relay(on, replay)
    const ui = await mount($)
    for (const { query } of replay.replies) {
      await ui.input({ key: 'search', text: query, kind: 'change' })
      const { rows } = herdrRows(replay, 'mine', query)
      expect(await drawnIds(ui), `${query} order`).toEqual(rows.map(r => r.pr.id))
      const ranked = (replay.replies.find(r => r.query === query)!.data as { prIds: string[] }).prIds
      expect(await drawnIds(ui), `${query} is the bridge's ranking`).toEqual(ranked)
      for (const { pr, labels } of rows.slice(0, 3)) {
        const meta = await ui.find({ key: `meta-${pr.id}` })
        expect(meta?.text, `${query} ${pr.id} names its scope`).toContain(metaLine(pr, labels, Date.now()))
      }
    }
    await ui.unmount()
  })
}

test('the live capture has rows and a multi-match search, so the order checks are not vacuous', () => {
  const { rows } = herdrRows(live, 'mine', null)
  expect(rows.length).toBeGreaterThan(1)
  expect(herdrRows(live, 'mine', 'abv').rows.length).toBeGreaterThan(1)
  expect(herdrRows(fifty, 'mine', null).rows.length).toBe(50)
  expect(herdrRows(fifty, 'mine', 'nightly').rows.length).toBeGreaterThan(1)
})
