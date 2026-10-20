import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Scope } from '../types'
import { SCOPES, age, chips, openFailure, shownScope, toSnapshot } from './model'

const PANE = 'pull-deck'
const TITLE = 'Pull Deck'
const BASE = 'http://pull-deck'
const LIVE_MS = 5_000
const IDLE_MS = 60_000

const snapshot = atom({ plugin: 'pull-deck', key: 'snapshot' } as const, null)
const picked = atom({ plugin: 'pull-deck', key: 'scope' } as const, null)
const opening = atom({ plugin: 'pull-deck', key: 'opening' } as const, null)

/** The relay serves viewers here; PULLDECK_VIEWER_SOCKET overrides it, as for the relay. */
async function socketPath($: EngineInterface): Promise<string> {
  const override = await $.env.get('PULLDECK_VIEWER_SOCKET')
  if (override) return override
  return `${await $.env.get('HOME')}/Library/Application Support/PullDeck/viewer.sock`
}

/** HTTP to the relay; status 0 when nothing listens on the socket. */
async function call($: EngineInterface, path: string, body?: unknown) {
  try {
    const res = await $.http.fetch(`${BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      socketPath: await socketPath($),
    })
    return { status: res.status, text: res.text }
  } catch {
    return { status: 0, text: '' }
  }
}

export const register: Register = on => {
  let lastPoll = 0

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'pull-deck', description: 'Show your open pull requests from Pull Deck' })
    const poll = async () => {
      // Where a surface cannot list panes, poll as if the pane were shown.
      const isShown = await $.ui.panes().then(
        panes => panes.some(pane => pane.id === PANE && pane.isShown),
        () => true,
      )
      if (!isShown && Date.now() - lastPoll < IDLE_MS) return
      lastPoll = Date.now()
      const { status, text } = await call($, '/state')
      await update($, snapshot, () => toSnapshot(status, text))
    }
    $.clock.every(LIVE_MS, () => void poll())
    void poll()
    return started
  })

  on('command.run', { command: 'pull-deck' }, async $ => {
    const { status, text } = await call($, '/state')
    lastPoll = Date.now()
    await update($, snapshot, () => toSnapshot(status, text))
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    return { text: opened.isPlaced ? 'Pull Deck pane opened.' : `Pull Deck pane not shown: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = Date.now()
    const current = await read($, snapshot)
    const scope = shownScope(current, await read($, picked))
    const busy = await read($, opening)

    if (!current) return <Text dimColor>Loading…</Text>
    if (current.kind === 'down') return <Text color="warning">{current.reason}</Text>
    if (current.kind === 'onboarding')
      return <Text>Connect a GitHub token in the Pull Deck extension popup.</Text>
    if (current.kind === 'error') return <Text color="error">{current.message}</Text>

    const rows = current.scopes[scope]
    // One open at a time, as in the menu bar app; a press while one runs is dropped.
    const open = async (prId: string) => {
      if (busy) return
      await update($, opening, () => prId)
      const { status, text } = await call($, '/open', { prId })
      await update($, opening, () => null)
      const failure = openFailure(status, text)
      if (failure) $.ui.toast(failure)
    }
    const openAll = async () => {
      if (busy || rows.length === 0) return
      await update($, opening, () => '*')
      const { status, text } = await call($, '/open-all', { scope })
      await update($, opening, () => null)
      const failure = openFailure(status, text)
      if (failure) $.ui.toast(failure)
    }
    const choose = (next: Scope) => update($, picked, () => next)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          {SCOPES.map(({ scope: s, label, hotkey }) => (
            <Button
              key={`scope-${s}`}
              label={`${label} ${current.scopes[s].length}`}
              hotkey={hotkey}
              variant={s === scope ? 'primary' : 'secondary'}
              onPress={() => choose(s)}
            />
          ))}
          <Button
            key="open-all"
            label={busy === '*' ? 'Opening…' : 'Open all'}
            hotkey="o"
            dimColor={rows.length === 0 || Boolean(busy)}
            onPress={openAll}
          />
        </Box>
        <Box flexDirection="column">
          {rows.length === 0 && <Text dimColor>No open pull requests here.</Text>}
          {rows.map(pr => (
            <Button key={`pr-${pr.id}`} plain dimColor={Boolean(busy) && busy !== pr.id} onPress={() => open(pr.id)}>
              {busy === pr.id ? 'Opening… ' : ''}
              {pr.title}
              <Text dimColor>
                {'  '}
                {pr.repo} #{pr.number} · {age(pr.updatedAt, now)} ·{' '}
              </Text>
              <Text color="diffAdded">+{pr.additions}</Text>
              <Text dimColor> </Text>
              <Text color="diffRemoved">−{pr.deletions}</Text>
              {chips(pr).map(chip => (
                <Text color={chip.color}>
                  {'  '}
                  {chip.text}
                </Text>
              ))}
            </Button>
          ))}
        </Box>
        <Text dimColor>
          {current.fetchedAt ? `Updated ${age(new Date(current.fetchedAt).toISOString(), now)} ago` : ''}
          {current.truncated.includes(scope) ? ' · showing the 50 most recently updated' : ''}
          {current.isStale ? ' · list may be out of date' : ''}
          {current.warning ? ` · ${current.warning}` : ''}
        </Text>
      </Box>
    )
  })
}
