// The worker against a stand-in relay on a real Unix socket (relay-stub.mjs), answering the
// viewer routes with src/fixtures.ts.
import { afterEach, assert, mountWorker, test } from 'orca/testing'
import { searchReply, state } from './fixtures'
import { startRelay } from './relay-stub.mjs'
import * as main from './worker'

let relay: Awaited<ReturnType<typeof startRelay>> | null = null
let mounted: Awaited<ReturnType<typeof mountWorker>>[] = []
/** Every worker ends after its test, so a failed assertion cannot leave its status timer running. */
const start = async () => {
  const worker = await mountWorker(main)
  mounted.push(worker)
  return worker
}
afterEach(async () => {
  for (const worker of mounted) await worker.deactivate()
  mounted = []
  await relay?.stop()
  relay = null
})

test('reads the relay state and reuses it for a few seconds', async () => {
  relay = await startRelay(() => ({ status: 200, body: state }))
  const worker = await start()
  const first = await worker.request('deck.state', {})
  assert.equal(first.kind === 'list' && first.scopes.mine.length, 3)
  await worker.request('deck.state', {})
  assert.deepEqual(relay.hits, ['GET /state'])
  await worker.request('deck.state', { force: true })
  assert.deepEqual(relay.hits, ['GET /state', 'GET /state'])
})

test('puts the counts in the status bar, and only when they change', async () => {
  relay = await startRelay(() => ({ status: 200, body: state }))
  const worker = await start()
  await worker.request('deck.state', { force: true })
  await worker.request('deck.state', { force: true })
  const updates = worker.host.callsOf('statusBar.update')
  assert.deepEqual(updates, [
    {
      id: 'count',
      text: '3 · 1 to review',
      tone: 'danger',
      tooltip: 'Mine 3 · Reviews 1 · Assigned 0. 1 of yours needs attention: failed checks or changes requested.',
    },
  ])
  assert.deepEqual(worker.refusals, [])
})

test('says the bridge is down when nothing listens', async () => {
  relay = await startRelay()
  const worker = await start()
  assert.equal((await worker.request('deck.state', {})).kind, 'down')
})

test('searches with the typed text and keeps the bridge rank order', async () => {
  relay = await startRelay(({ url, body }) => ({ status: 200, body: url === '/search' ? searchReply(body.query) : state }))
  const worker = await start()
  assert.deepEqual(await worker.request('deck.search', { query: 'ci' }), {
    query: 'ci',
    kind: 'hits',
    prIds: ['pr-1003', 'pr-1002'],
    isStale: false,
  })
})

test('reports the first failed tab of an open', async () => {
  relay = await startRelay(() => ({
    status: 200,
    body: { ok: true, data: { failures: [{ message: 'Tab could not be grouped' }] } },
  }))
  const worker = await start()
  assert.deepEqual(await worker.request('deck.open', { prId: 'pr-1001' }), {
    ok: false,
    message: 'Tab could not be grouped',
  })
})

test('runs one open at a time, as the relay allows', async () => {
  let release = () => {}
  relay = await startRelay(({ url }) =>
    url === '/open-all'
      ? new Promise(resolve => (release = () => resolve({ status: 200, body: { ok: true, data: { focused: false } } })))
      : { status: 200, body: { ok: true, data: { focused: true } } },
  )
  const worker = await start()
  const all = worker.request('deck.openAll', { scope: 'mine' })
  while (relay.hits.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(await worker.request('deck.open', { prId: 'pr-1001' }), {
    ok: false,
    message: 'Another open is still running.',
  })
  release()
  assert.deepEqual(await all, { ok: true, focused: false })
  assert.deepEqual(await worker.request('deck.open', { prId: 'pr-1001' }), { ok: true, focused: true })
})
