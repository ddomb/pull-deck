import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

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

type Bridge = { state: unknown; status?: number; down?: boolean; open?: unknown }

/** Stands in for the engine beneath the plugin: the relay socket and the UI nouns. */
function engine(on: On, bridge: Bridge) {
  const seen = { fetches: [] as { url: string; method?: string; body?: string; socketPath?: string }[], toasts: [] as string[] }
  mock.env(on, { HOME: '/Users/someone', PULLDECK_VIEWER_SOCKET: SOCKET })
  mock.clock(on)
  on('http.fetch', async ($, e) => {
    seen.fetches.push({ url: e.url, method: e.init?.method, body: e.init?.body, socketPath: e.init?.socketPath })
    if (bridge.down) throw new Error('ENOENT')
    const body = e.url.endsWith('/state') ? { app: false, state: bridge.state, error: null } : bridge.open
    return { value: { status: bridge.status ?? 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.panes', async () => ({ value: [] }))
  on('ui.toast', async ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', async ($, e) => ({ value: { command: e.name } }))
  return seen
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
