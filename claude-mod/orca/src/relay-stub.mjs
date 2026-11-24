// A stand-in Pull Deck relay for the worker tests: a real HTTP server on a temporary Unix socket,
// pointed at by PULLDECK_VIEWER_SOCKET. JavaScript so the tests need no Node typings.
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function startRelay(route) {
  const dir = mkdtempSync(join(tmpdir(), 'pd-orca-'))
  const socket = join(dir, 'viewer.sock')
  process.env.PULLDECK_VIEWER_SOCKET = socket
  const hits = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => (body += chunk))
    req.on('end', async () => {
      hits.push(`${req.method} ${req.url}`)
      const reply = await route({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null })
      res.writeHead(reply.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  if (route) await new Promise(resolve => server.listen(socket, resolve))
  return {
    hits,
    stop: () =>
      new Promise(resolve => {
        const done = () => (rmSync(dir, { recursive: true, force: true }), resolve())
        if (route) server.close(done)
        else done()
      }),
  }
}
