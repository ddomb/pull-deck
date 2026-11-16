// The Herdr mod reaches the relay's viewer socket through curl: a Herdr mod can run programs but
// cannot dial a Unix socket (its `net` module is TCP only). These turn one request into curl's
// arguments and curl's result back into the (status, text) pair the shared model reads.

export const CURL = '/usr/bin/curl'

/** Where the relay serves viewers (BRIDGE.md, "Viewer socket"). */
export const defaultSocket = home => `${home}/Library/Application Support/PullDeck/viewer.sock`

/** curl arguments for one viewer request. The status code goes on its own last line. */
export function curlArgs(socket, path, body, seconds) {
  const args = ['-sS', '--max-time', String(seconds), '-w', '\n%{http_code}', '--unix-socket', socket]
  if (body !== undefined) {
    args.push('-X', 'POST', '-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(body))
  }
  args.push(`http://pull-deck${path}`)
  return args
}

/** curl's exit code and stdout as the relay's (status, text). Status 0 when nothing answered. */
export function fromCurl(code, stdout) {
  if (code !== 0) return { status: 0, text: '' }
  const cut = stdout.lastIndexOf('\n')
  const status = Number(stdout.slice(cut + 1))
  if (!Number.isInteger(status) || status < 100) return { status: 0, text: '' }
  return { status, text: stdout.slice(0, Math.max(cut, 0)) }
}
