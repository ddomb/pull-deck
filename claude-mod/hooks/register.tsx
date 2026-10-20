import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Scope } from '../types'
import { SCOPES, age, chips, dockLabel, footnote, openFailure, shownScope, toSnapshot } from './model'

const PANE = 'pull-deck'
const TITLE = 'Pull Deck'
const BASE = 'http://pull-deck'
const LIVE_MS = 5_000
const IDLE_MS = 60_000

// The menu bar app's accent, oklch(50% .118 190).
const ACCENT = '#007772'
const ACCENT_TINT = 'rgba(0, 119, 114, 0.10)'
const CHIP_TINT: Record<string, string> = {
  success: 'rgba(52, 199, 89, 0.14)',
  error: 'rgba(255, 69, 58, 0.14)',
  warning: 'rgba(255, 159, 10, 0.14)',
  subtle: 'rgba(142, 142, 147, 0.16)',
}
const STACK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="3" y="1.5" width="10" height="2" rx="1" fill="${ACCENT}" opacity=".55"/><rect x="1.5" y="4.5" width="13" height="10" rx="2.2" fill="${ACCENT}"/></svg>`
const CHECK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${ACCENT}"/><path d="M4.8 8.2l2.2 2.2 4.2-4.6" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`

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
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // The terminal has no Svg: it gets a glyph in the icon's place.
    const icon = (source: string, alt: string, size: number, fallback: string) =>
      'Svg' in elements ? (
        <elements.Svg source={source} alt={alt} width={size} height={size} />
      ) : (
        <Text color={ACCENT}>{fallback}</Text>
      )
    const now = Date.now()
    const current = await read($, snapshot)
    const scope = shownScope(current, await read($, picked))
    const busy = await read($, opening)

    const refresh = async () => {
      const { status, text } = await call($, '/state')
      lastPoll = Date.now()
      await update($, snapshot, () => toSnapshot(status, text))
    }
    const header = (
      <Box flexDirection="row" alignItems="center" gap={1}>
        {icon(STACK_ICON, 'Pull Deck', 18, '▤')}
        <Box flexDirection="column" flexGrow={1}>
          <Text weight="semibold">Pull Deck</Text>
          {current?.kind === 'list' && current.login && (
            <Text size="caption" dimColor>
              @{current.login}
            </Text>
          )}
        </Box>
        <Button key="refresh" plain label="↻" hotkey="g" onPress={refresh} />
      </Box>
    )
    const notice = (title: string, body: string, color?: 'warning' | 'error') => (
      <Box flexDirection="column" gap={1}>
        {header}
        <Box flexDirection="column" padding={1} borderStyle="round" borderColor="subtle">
          <Text weight="semibold" color={color}>
            {title}
          </Text>
          <Text dimColor>{body}</Text>
        </Box>
      </Box>
    )

    if (!current) return notice('Loading…', 'Asking the Pull Deck bridge for your pull requests.')
    if (current.kind === 'down') return notice('Not connected yet', current.reason, 'warning')
    if (current.kind === 'onboarding')
      return notice(
        'Connect GitHub',
        'Open the Pull Deck extension in Chrome and paste a personal access token. The token stays there.',
      )
    if (current.kind === 'error') return notice('GitHub said no', current.message, 'error')

    const rows = current.scopes[scope]
    const grouped = new Set(current.groupKeys)
    const isGrouped = (key: string | null) => key !== null && grouped.has(key)
    const pending = rows.filter(pr => !isGrouped(pr.key)).length
    const note = footnote(rows.length, pending, current.truncated.includes(scope), current.isGroupElsewhere)

    // One open at a time, as in the menu bar app; a press while one runs is dropped.
    const open = async (prId: string) => {
      if (busy) return
      await update($, opening, () => prId)
      const { status, text } = await call($, '/open', { prId })
      await update($, opening, () => null)
      const failure = openFailure(status, text)
      if (failure) $.ui.toast(failure)
      await refresh()
    }
    const openAll = async () => {
      if (busy || pending === 0) return
      await update($, opening, () => '*')
      const { status, text } = await call($, '/open-all', { scope })
      await update($, opening, () => null)
      const failure = openFailure(status, text)
      if (failure) $.ui.toast(failure)
      await refresh()
    }
    const choose = (next: Scope) => update($, picked, () => next)

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        <Box flexDirection="row" borderStyle="round" borderColor="subtle">
          {SCOPES.map(({ scope: s, label, hotkey }) => {
            const count = current.scopes[s].length
            return (
              <Box
                key={`tab-${s}`}
                flexGrow={1}
                justifyContent="center"
                backgroundColor={s === scope ? 'rgba(127, 127, 127, 0.28)' : undefined}
              >
                <Button
                  key={`scope-${s}`}
                  plain
                  label={count > 0 ? `${label}  ${count}` : label}
                  hotkey={hotkey}
                  onPress={() => choose(s)}
                />
              </Box>
            )
          })}
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor="subtle" overflow="hidden">
          {rows.length === 0 && (
            <Box padding={1}>
              <Text dimColor>No open pull requests here.</Text>
            </Box>
          )}
          {rows.map(pr => {
            const inGroup = isGrouped(pr.key)
            const badges = chips(pr)
            const dimmed = Boolean(busy) && busy !== pr.id
            const press = () => open(pr.id)
            return (
              <Box
                key={`row-${pr.id}`}
                flexDirection="row"
                gap={1}
                paddingX={1}
                paddingY={1}
                overflow="hidden"
                backgroundColor={inGroup ? ACCENT_TINT : undefined}
                hover={{ backgroundColor: 'rgba(127, 127, 127, 0.12)' }}
              >
                {/* The desktop draws a Button as one line and drops line breaks
                    in it, so each line of the row is its own Button, all opening
                    the same pull request: the row is clickable wherever it has text. */}
                <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} gap={0}>
                  <Button key={`pr-${pr.id}`} plain dimColor={dimmed} onPress={press}>
                    <Text weight="semibold">{busy === pr.id ? `Opening… ${pr.title}` : pr.title}</Text>
                  </Button>
                  {/* Colour inside a Button is dropped on the desktop, so the coloured
                      parts sit beside the buttons rather than in them. */}
                  <Box flexDirection="row" gap={1} alignItems="center">
                    <Button key={`meta-${pr.id}`} plain dimColor={dimmed} onPress={press}>
                      <Text size="caption" dimColor>
                        {`${pr.repo} #${pr.number} ${age(pr.updatedAt, now)}`}
                      </Text>
                    </Button>
                    <Text size="caption" color="success">{`+${pr.additions.toLocaleString('en-US')}`}</Text>
                    <Text size="caption" color="error">{`−${pr.deletions.toLocaleString('en-US')}`}</Text>
                  </Box>
                  {badges.length > 0 && (
                    <Box flexDirection="row" gap={1} marginTop={1}>
                      {badges.map(chip => (
                        <Text size="caption" weight="medium" color={chip.color} backgroundColor={CHIP_TINT[chip.color]}>
                          {` ${chip.glyph} ${chip.text} `}
                        </Text>
                      ))}
                    </Box>
                  )}
                </Box>
                {inGroup && icon(CHECK_ICON, `Already in ${current.groupTitle}`, 16, '✓')}
              </Box>
            )
          })}
        </Box>
        <Box flexDirection="column" alignItems="center" gap={1}>
          <Button
            key="open-all"
            variant="primary"
            label={busy === '*' ? 'Opening…' : dockLabel(rows.length, pending, current.groupTitle)}
            hotkey="o"
            dimColor={pending === 0 || Boolean(busy)}
            onPress={openAll}
          />
          {(note || current.isStale || current.warning) && (
            <Text size="caption" dimColor>
              {[note, current.isStale ? 'The list may be out of date.' : '', current.warning ?? '']
                .filter(Boolean)
                .join(' ')}
            </Text>
          )}
        </Box>
      </Box>
    )
  })
}
