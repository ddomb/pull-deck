import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

import { cases, replies } from './search-fixtures'

const SOCKET = '/fake/viewer.sock'
const PANE = { component: 'Pane', requestId: 'pull-deck', props: {
    title: 'Pull Deck',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const pr = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  number: Number(id.replace(/\D/g, '')) || 1,
  title: `Title ${id}`,
  url: `https://github.com/acme/api/pull/${id}`,
  repo: 'acme/api',
  isDraft: false,
  updatedAt: new Date(0).toISOString(),
  additions: 10,
  deletions: 2,
  reviewDecision: null,
  checks: null,
  key: `github.com/acme/api#${id}`,
  ...extra,
})

const listState = {
  stage: 'list',
  scopes: {
    mine: [],
    reviewing: [pr('PR_1', { reviewDecision: 'APPROVED', checks: 'FAILURE' }), pr('PR_2', { isDraft: true })],
    assigned: [pr('PR_3')],
  },
  truncated: { reviewing: true },
  stale: false,
  fetchedAt: 0,
  error: null,
  viewer: { login: 'octo' },
  settings: { groupTitle: 'Pull Requests' },
  group: { keys: ['github.com/acme/api#PR_1'], otherWindow: false },
}

type Bridge = { state: unknown; status?: number; down?: boolean; open?: unknown; search?: (query: string, clock: MockClock) => unknown }

/** Stands in for the engine beneath the plugin: the relay socket and the UI nouns. */
function engine(on: On, bridge: Bridge) {
  const seen = { fetches: [] as { url: string; method?: string; body?: string; socketPath?: string }[], toasts: [] as string[] }
  mock.env(on, { HOME: '/Users/someone', PULLDECK_VIEWER_SOCKET: SOCKET })
  const clock = mock.clock(on)
  on('http.fetch', async ($, e) => {
    seen.fetches.push({ url: e.url, method: e.init?.method, body: e.init?.body, socketPath: e.init?.socketPath })
    if (bridge.down) throw new Error('ENOENT')
    const body = e.url.endsWith('/state')
      ? { app: false, state: bridge.state, error: null }
      : e.url.endsWith('/search')
        ? await bridge.search?.(JSON.parse(e.init?.body ?? '{}').query, clock)
        : bridge.open
    return { value: { status: bridge.status ?? 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', async () => ({ value: [] }))
  on('ui.toast', async ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  return { ...seen, clock }
}

async function openPane($: Engine) {
  await $.command.run({
    command: 'pull-deck',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
}

test('lists the first scope with rows, with the menu app chips, on every surface', async ($, on) => {
  const seen = engine(on, { state: listState })
  await openPane($)
  expect(seen.fetches[0]).toEqual(expect.objectContaining({ url: 'http://pull-deck/state', socketPath: SOCKET }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pull-deck', surface, ...PANE })
    expect(await ui.find({ key: 'pr-PR_1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Approved' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Checks failed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /50 most recently updated/ })).toBeDefined()
    expect(await ui.find({ key: 'pr-PR_3' })).toBeUndefined()
    await ui.unmount()
  }
})

test('pressing a row opens that pull request through the relay', async ($, on) => {
  const seen = engine(on, { state: listState, open: { ok: true, data: { focused: true, failures: [] }, error: null } })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'pull-deck', surface: 'desktop', ...PANE })
  await ui.press({ key: 'pr-PR_2' })
  const open = seen.fetches.find(f => f.url === 'http://pull-deck/open')
  expect(open?.method).toBe('POST')
  expect(JSON.parse(open?.body ?? '{}')).toEqual({ prId: 'PR_2' })
  expect(seen.toasts).toEqual([])
})

test('a failed open is told as a toast', async ($, on) => {
  const seen = engine(on, {
    state: listState,
    open: { ok: true, data: { failures: [{ message: 'Tab could not be grouped.' }] }, error: null },
  })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'pull-deck', surface: 'terminal', ...PANE })
  await ui.press({ key: 'meta-PR_1' })
  expect(seen.toasts).toEqual(['Tab could not be grouped.'])
})

test('scope buttons switch the list, and open all sends that scope', async ($, on) => {
  const seen = engine(on, { state: listState, open: { ok: true, data: { failures: [] }, error: null } })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'pull-deck', surface: 'terminal', ...PANE })
  await ui.press({ key: 'scope-assigned' })
  expect(await ui.find({ key: 'pr-PR_3' })).toBeDefined()
  expect(await ui.find({ key: 'pr-PR_1' })).toBeUndefined()
  await ui.press({ key: 'open-all' })
  const all = seen.fetches.find(f => f.url === 'http://pull-deck/open-all')
  expect(JSON.parse(all?.body ?? '{}')).toEqual({ scope: 'assigned' })
})

test('an unreachable bridge says what to do', async ($, on) => {
  engine(on, { state: null, down: true })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'pull-deck', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: /bridge is not reachable/ })).toBeDefined()
})

test('no token points at the popup', async ($, on) => {
  engine(on, { state: { stage: 'onboarding' } })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'pull-deck', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /personal access token/ })).toBeDefined()
})

test('grouped rows are marked, and the dock opens the rest like the menu app', async ($, on) => {
  engine(on, { state: { ...listState, truncated: {} } })
  await openPane($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pull-deck', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: '@octo' })).toBeDefined()
    expect((await ui.find({ key: 'open-all' }))?.text).toBe('Open 1 in “Pull Requests”')
    expect(await ui.find({ type: 'Text', text: '1 already there, so it stays put.' })).toBeDefined()
    await ui.unmount()
  }
})


const NOT_IN_SNAPSHOT = 'Not in your snapshot. Pull Deck holds Mine, Reviews and Assigned, up to 50 each.'
const fixtureState = {
  ...listState,
  truncated: {},
  group: { keys: [], otherWindow: false },
  scopes: Object.fromEntries(
    (['mine', 'reviewing', 'assigned'] as const).map(scope => [
      scope,
      cases.pullRequests
        .filter(fixture => fixture.scope === scope)
        .map(({ id, number, repo, title, url }) => pr(id, { number, repo, title, url })),
    ]),
  ),
}
/** The relay's `POST /search` answer, from the JS bridge's recorded reply to that query. */
const recorded = (query: string) => {
  const reply = replies.replies.find(r => r.query === query)
  if (!reply) throw new Error(`no recorded reply for ${query}`)
  return { ok: true, data: reply.data, error: null }
}
const opened = { ok: true, data: { focused: true, failures: [] }, error: null }

test('every query in the shared table shows its matches across scopes, or says it is not in the snapshot', async ($, on) => {
  engine(on, { state: fixtureState, search: recorded })
  await openPane($)
  const ids = cases.pullRequests.map(fixture => fixture.id)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pull-deck', surface, ...PANE })
    for (const { query, expect: want } of cases.cases) {
      await ui.input({ key: 'search', text: query, kind: 'change' })
      for (const id of ids) {
        const row = await ui.find({ key: `pr-${id}` })
        if (want.includes(id)) expect(row, `${query} shows ${id}`).toBeDefined()
        else expect(row, `${query} hides ${id}`).toBeUndefined()
      }
      const message = await ui.find({ type: 'Text', text: NOT_IN_SNAPSHOT })
      if (want.length === 0) expect(message, `${query} says not in snapshot`).toBeDefined()
      else expect(message, `${query} has matches`).toBeUndefined()
      expect(await ui.find({ key: 'open-all' }), `${query} hides the dock`).toBeUndefined()
    }
    await ui.unmount()
  }
})

test('a match names its scope, even outside the scope tab that is showing', async ($, on) => {
  engine(on, { state: fixtureState, search: recorded })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'pull-deck', surface: 'terminal', ...PANE })
  await ui.input({ key: 'search', text: '10637', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /^Reviews · acme\/above #10637/ })).toBeDefined()
})

test('Enter opens the top match through the relay, and an emptied field brings the list back', async ($, on) => {
  const seen = engine(on, { state: fixtureState, search: recorded, open: opened })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'pull-deck', surface: 'desktop', ...PANE })
  await ui.input({ key: 'search', text: 'abv10637', kind: 'change' })
  expect(seen.fetches.some(f => f.url === 'http://pull-deck/open')).toBe(false)
  await ui.input({ key: 'search', text: 'abv10637' })
  const open = seen.fetches.find(f => f.url === 'http://pull-deck/open')
  expect(JSON.parse(open?.body ?? '{}')).toEqual({ prId: 'pr-a' })
  await ui.input({ key: 'search', text: '', kind: 'change' })
  expect(await ui.find({ key: 'open-all' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: NOT_IN_SNAPSHOT })).toBeUndefined()
})

test('Enter on a query with no match opens nothing', async ($, on) => {
  const seen = engine(on, { state: fixtureState, search: recorded, open: opened })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'pull-deck', surface: 'terminal', ...PANE })
  await ui.input({ key: 'search', text: 'ABV-99999' })
  expect(seen.fetches.some(f => f.url === 'http://pull-deck/open')).toBe(false)
  expect(await ui.find({ type: 'Text', text: NOT_IN_SNAPSHOT })).toBeDefined()
})

test('a reply for an older query never replaces the latest one', async ($, on) => {
  const seen = engine(on, {
    state: fixtureState,
    search: async (query, clock) => {
      if (query === '11212') await clock.sleep(1_000)
      return recorded(query)
    },
  })
  await openPane($)
  const ui = await $.ui.mount({ plugin: 'pull-deck', surface: 'terminal', ...PANE })
  await ui.input({ key: 'search', text: '11212', kind: 'change' })
  await ui.input({ key: 'search', text: '10637', kind: 'change' })
  expect(await ui.find({ key: 'pr-pr-b' })).toBeDefined()
  await seen.clock.advance(1_000)
  expect(seen.fetches.filter(f => f.url === 'http://pull-deck/search')).toHaveLength(2)
  expect(await ui.find({ key: 'pr-pr-b' })).toBeDefined()
  expect(await ui.find({ key: 'pr-pr-d' })).toBeUndefined()
})
