// Pull Deck as an Orca components panel: the Herdr mod's rows (deckRows, metaLine, dockLabel,
// footnote from the shared model.js), drawn with Orca's own controls and theme.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  IconButton,
  Input,
  List,
  ListItem,
  plugin,
  read,
  Row,
  set,
  Stack,
  Tab,
  Tabs,
  Text,
  type PanelContext,
  type Tone,
} from 'orca'
import { deckRows, dockLabel, footnote, metaLine, NOT_IN_SNAPSHOT, SCOPES, shownScope } from './model.js'
import type { Found, Opened, Scope, Snapshot } from './protocol'

const EVERY_MS = 15_000
const OPEN_MS = 40_000

const snapshot = atom<Snapshot | null>(null)
const picked = atom<Scope | null>('picked', null, { persist: 'plugin' })
const query = atom('')
const found = atom<Found | null>(null)
/** The pull request being opened, '*' for the whole scope, or null. */
const busy = atom<string | null>(null)
const said = atom<{ text: string; ok: boolean } | null>(null)

const TONE: Record<string, Tone> = { success: 'success', error: 'danger', warning: 'warning', subtle: 'neutral' }
const fmt = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString('en-US'))

async function reload(force = false) {
  try {
    set(snapshot, await plugin.request('deck.state', { force }))
  } catch (error) {
    set(snapshot, { kind: 'error', message: (error as Error).message })
  }
}

/** Every keystroke asks; a reply lands only if its text is still the field's. */
async function search(text: string) {
  set(query, text)
  if (!text.trim()) return set(found, null)
  const answer = await plugin.request('deck.search', { query: text })
  if (read(query) === text) set(found, answer)
}

async function open(input: { prId: string } | { scope: Scope }, mark: string) {
  if (read(busy)) return
  set(busy, mark)
  set(said, null)
  let result: Opened
  try {
    result =
      'prId' in input
        ? await plugin.request('deck.open', input, { timeoutMs: OPEN_MS })
        : await plugin.request('deck.openAll', input, { timeoutMs: OPEN_MS })
  } catch (error) {
    result = { ok: false, message: (error as Error).message }
  }
  set(busy, null)
  set(said, result.ok ? { text: result.focused ? 'Focused its tab in the browser' : 'Opened in the browser', ok: true } : { text: result.message, ok: false })
  await reload(true)
}

/** Enter in search: ask again for the current text, then open the top match. */
async function openTop(text: string) {
  await search(text)
  const snap = read(snapshot)
  const answer = read(found)
  if (snap?.kind !== 'list') return
  if (answer?.kind === 'failed') return set(said, { text: answer.message, ok: false })
  const top = deckRows(snap, scopeOf(snap), answer)[0]
  if (top) await open({ prId: top.pr.id }, top.pr.id)
}

const scopeOf = (snap: Snapshot | null) => shownScope(snap, read(picked))

export function setup(ctx: PanelContext): void {
  void reload()
  const timer = setInterval(() => {
    if (read(ctx.visible)) void reload()
  }, EVERY_MS)
  ctx.signal.addEventListener('abort', () => clearInterval(timer))
}

export default function Panel() {
  const snap = read(snapshot)
  return (
    <Stack gap="sm">
      <Header snap={snap} />
      <Body snap={snap} />
    </Stack>
  )
}

function Header({ snap }: { snap: Snapshot | null }) {
  return (
    <Row justify="between" align="center">
      <Text muted size="sm" weight="medium">
        Pull requests{snap?.kind === 'list' && snap.login ? ` · @${snap.login}` : ''}
      </Text>
      <IconButton icon="refresh" label="Refresh" variant="ghost" size="xs" onPress={() => reload(true)} />
    </Row>
  )
}

function Notice({ tone, title, body, retry }: { tone: Tone; title: string; body: string; retry?: boolean }) {
  return (
    <Callout tone={tone} title={title}>
      <Stack gap="xs">
        <Text size="sm">{body}</Text>
        {retry ? (
          <Row>
            <Button variant="ghost" size="xs" onPress={() => reload(true)}>
              Try again
            </Button>
          </Row>
        ) : null}
      </Stack>
    </Callout>
  )
}

function Body({ snap }: { snap: Snapshot | null }) {
  if (!snap) return <Notice tone="neutral" title="Loading…" body="Asking the Pull Deck bridge for your pull requests." />
  if (snap.kind === 'down') return <Notice tone="warning" title="Not connected" body={snap.reason} retry />
  if (snap.kind === 'onboarding')
    return (
      <Notice
        tone="warning"
        title="Connect GitHub"
        body="Open the Pull Deck extension in Chrome and paste a personal access token. The token stays there."
      />
    )
  if (snap.kind === 'error') return <Notice tone="danger" title="Couldn’t load pull requests" body={snap.message} retry />

  const scope = scopeOf(snap)
  const text = read(query)
  const answer = text.trim() && read(found)?.query === text ? read(found) : null
  const rows = deckRows(snap, scope, answer)
  const empty = answer
    ? answer.kind === 'failed'
      ? answer.message
      : rows.length === 0
        ? NOT_IN_SNAPSHOT
        : null
    : rows.length === 0
      ? 'No open pull requests here.'
      : null
  const now = Date.now()
  const opening = read(busy)

  return (
    <Stack gap="sm">
      <Tabs label="Scope" value={scope} onChange={value => set(picked, value as Scope)}>
        {SCOPES.map(({ scope: s, label }) => {
          const count = snap.scopes[s].length
          return <Tab key={s} value={s} label={count ? `${label} ${count}${snap.truncated.includes(s) ? '+' : ''}` : label} />
        })}
      </Tabs>
      <Input
        label="Search"
        labelHidden
        type="search"
        placeholder="Search: ABV-10637, 11780, words"
        value={text}
        onChange={search}
        onSubmit={openTop}
      />
      {empty ? (
        <Text muted size="sm">
          {empty}
        </Text>
      ) : (
        <List label="Pull requests">
          {rows.map(({ pr, labels, chips, inGroup }) => (
            <ListItem
              key={`pr-${pr.id}`}
              icon={opening === pr.id || opening === '*' ? 'refresh' : inGroup ? 'check' : undefined}
              disabled={Boolean(opening) && opening !== pr.id && opening !== '*'}
              onPress={() => open({ prId: pr.id }, pr.id)}
            >
              <Stack gap="xs">
                <Text truncate>{pr.title}</Text>
                <Row gap="xs" align="center" wrap>
                  {chips.map(c => (
                    <Badge key={c.text} tone={TONE[c.color]}>{`${c.glyph} ${c.text}`}</Badge>
                  ))}
                  <Text muted size="xs" truncate>
                    {metaLine(pr, labels, now)}
                  </Text>
                  <Text tone="success" size="xs">{`+${fmt(pr.additions)}`}</Text>
                  <Text tone="danger" size="xs">{`−${fmt(pr.deletions)}`}</Text>
                </Row>
              </Stack>
            </ListItem>
          ))}
        </List>
      )}
      {answer?.kind === 'hits' && answer.isStale ? (
        <Text muted size="xs">
          The list may be out of date.
        </Text>
      ) : null}
      {answer ? null : <Dock snap={snap} scope={scope} />}
    </Stack>
  )
}

function Dock({ snap, scope }: { snap: Extract<Snapshot, { kind: 'list' }>; scope: Scope }) {
  const rows = snap.scopes[scope]
  const grouped = new Set(snap.groupKeys)
  const pending = rows.filter(pr => !(pr.key !== null && grouped.has(pr.key))).length
  const note = footnote(rows.length, pending, snap.truncated.includes(scope), snap.isGroupElsewhere)
  const message = read(said)
  const line = [message?.text, note, snap.isStale ? 'The list may be out of date.' : '', snap.warning ?? '']
    .filter(Boolean)
    .join(' ')
  const opening = read(busy)
  const showButton = !(pending === 0 && rows.length > 0)
  return (
    <Box padding="none" gap="xs" direction="column">
      {showButton ? (
        <Button
          variant="solid"
          tone="accent"
          disabled={pending === 0 || Boolean(opening)}
          onPress={() => open({ scope }, '*')}
        >
          {opening === '*' ? 'Opening…' : dockLabel(rows.length, pending, snap.groupTitle)}
        </Button>
      ) : null}
      {line ? (
        <Text size="xs" tone={message && !message.ok ? 'danger' : undefined} muted={!message || message.ok}>
          {line}
        </Text>
      ) : null}
    </Box>
  )
}
