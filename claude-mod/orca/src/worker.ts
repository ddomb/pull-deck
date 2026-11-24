// The plugin's worker: the only part that reaches the Pull Deck relay. Panels cannot open a socket,
// so they ask this over plugin.request; it speaks HTTP over the relay's viewer socket (BRIDGE.md,
// "Viewer socket") with Node's own http module.
import { request } from 'node:http'
import type { OrcaWorkerApi } from 'orca/worker'
import { openFailure, toFound, toSnapshot } from './model.js'
import type { Opened } from './protocol'
import { statusOf } from './status'

const socket = () =>
  process.env.PULLDECK_VIEWER_SOCKET || `${process.env.HOME}/Library/Application Support/PullDeck/viewer.sock`
const REUSE_MS = 5_000
/** How often the status bar item rereads the relay; Orca keeps this worker running for it. */
const STATUS_MS = 30_000

type Reply = { status: number; text: string }

/** One viewer request. Status 0 when nothing answered, as the shared model expects. */
function call(path: string, body: unknown, seconds: number): Promise<Reply> {
  return new Promise(resolve => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = request(
      {
        socketPath: socket(),
        path,
        method: data === undefined ? 'GET' : 'POST',
        headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(new TextEncoder().encode(data).length) },
        timeout: seconds * 1000,
      },
      res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', chunk => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
        res.on('error', () => resolve({ status: 0, text: '' }))
      },
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve({ status: 0, text: '' }))
    req.end(data)
  })
}

function opened({ status, text }: Reply): Opened {
  const failure = openFailure(status, text)
  if (failure) return { ok: false, message: failure }
  let focused = false
  try {
    focused = JSON.parse(text)?.data?.focused === true
  } catch {}
  return { ok: true, focused }
}

let timer: ReturnType<typeof setInterval> | undefined

export default function activate(orca: OrcaWorkerApi): void {
  // Every open panel polls; one relay read serves them all for a few seconds.
  let last: { at: number; reply: Promise<Reply> } | null = null
  // The last thing the status bar was told, so an unchanged count sends nothing.
  let shown = ''
  // The relay allows one viewer open at a time (409 otherwise), so two panels never race it.
  let opening = false

  const state = async (force = false) => {
    if (force || !last || Date.now() - last.at > REUSE_MS) last = { at: Date.now(), reply: call('/state', undefined, 8) }
    const { status, text } = await last.reply
    const snapshot = toSnapshot(status, text)
    const next = JSON.stringify(statusOf(snapshot))
    if (next !== shown) {
      shown = next
      void orca.host.call('statusBar.update', { id: 'count', ...statusOf(snapshot) }).catch(() => (shown = ''))
    }
    return snapshot
  }

  orca.panels.handle('deck.state', ({ force }) => state(force))
  void state()
  timer = setInterval(() => void state(), STATUS_MS)

  orca.panels.handle('deck.search', async ({ query }) => {
    const { status, text } = await call('/search', { query }, 6)
    return toFound(query, status, text)
  })

  const open = async (path: string, body: unknown): Promise<Opened> => {
    if (opening) return { ok: false, message: 'Another open is still running.' }
    opening = true
    try {
      const result = opened(await call(path, body, 35))
      last = null
      return result
    } finally {
      opening = false
    }
  }
  orca.panels.handle('deck.open', ({ prId }) => open('/open', { prId }))
  orca.panels.handle('deck.openAll', ({ scope }) => open('/open-all', { scope }))
}

export function deactivate(): void {
  clearInterval(timer)
}
