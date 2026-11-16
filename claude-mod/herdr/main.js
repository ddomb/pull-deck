// Pull Deck in Herdr.app's sidebar: your open pull requests from the Pull Deck relay (viewer.sock,
// BRIDGE.md), the same rows and search as the Claude Code mod's pane, drawn with Herdr's theme.
//
// Props (all optional):
//   look:   "cards" | "lines" | "ledger"   how a row is drawn (default "cards")
//   scopes: ["mine", "reviewing", "assigned"]   which scope tabs show, in that order
//   fields: ["repo", "age", "review", "ci", "diff"]   which row facts show
//   every:  ms between relay reads (default 15000)
//   socket: the relay's viewer socket, for a second relay or a test one

import { View, div, svg } from 'gpui-kit'
import { v_flex, h_flex, InputState, Input, ScrollHandle } from 'gpui-base'
import { exec, home, theme, settings, props, checking, nextCommand, notify } from 'herdr'
import {
  SCOPES,
  NOT_IN_SNAPSHOT,
  toSnapshot,
  toFound,
  deckRows,
  shownScope,
  dockLabel,
  footnote,
  metaLine,
  openFailure,
  age,
} from './model.js'
import { CURL, curlArgs, defaultSocket, fromCurl } from './relay.js'

const EVERY_MS = 15_000
const FOLDED = 160
const ICON = name => `mods/workspace-chrome/${name}.svg`
const ALL_FIELDS = ['repo', 'age', 'review', 'ci', 'diff']

const fmt = n => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString('en-US'))

/** A chip's colour from Herdr's theme: the agents list's status colours, so the sidebar reads as one. */
const tone = (t, color) =>
  ({ success: t.ansi2 ?? t.done, error: t.blocked, warning: t.working, subtle: t.dim })[color] ?? t.dim

export default class PullDeck extends View {
  init(_props, cx) {
    this.snapshot = null
    this.raw = null
    this.picked = null
    this.query = ''
    this.found = null
    this.at = 0
    this.busy = null
    this.said = null
    this.width = null
    this.inputFocused = false
    this.handle = cx.focus_handle()
    this.scroll = ScrollHandle.new()
    this.input = InputState.new({ placeholder: 'Search: ABV-10637, 11780, words' })
    this.input.on('change', (_e, cx) => this.type(this.input.value(), cx))
    this.input.on('submit', (e, cx) => (e.secondary ? this.openAll(cx) : this.openSelected(cx)))
    this.input.on('focus', (_e, cx) => {
      this.inputFocused = true
      cx.notify()
    })
    this.input.on('blur', (_e, cx) => {
      this.inputFocused = false
      cx.notify()
    })
    if (checking()) return
    cx.timer.every(Number(props()?.every) || EVERY_MS, cx => this.reload(cx))
    // Ages ("5m") move on their own; a slow redraw keeps them honest without polling anything.
    cx.timer.every(60_000, cx => cx.notify())
    cx.spawn(async cx => {
      for (;;) this.command(await nextCommand(), cx)
    })
    this.reload(cx)
  }

  socket() {
    return props()?.socket || defaultSocket(home())
  }

  async call(path, body, seconds = 8) {
    try {
      const r = await exec(CURL, curlArgs(this.socket(), path, body, seconds), {
        timeout: (seconds + 2) * 1000,
      })
      return fromCurl(r.code, r.stdout)
    } catch {
      return { status: 0, text: '' }
    }
  }

  /** Reads the relay; redraws only when the answer changed (every redraw redraws the window). */
  reload(cx) {
    cx.spawn(async cx => {
      const { status, text } = await this.call('/state')
      const snapshot = toSnapshot(status, text)
      // fetchedAt moves on every extension refresh (about every 5 s) while the rows stay the same.
      const key = JSON.stringify({ ...snapshot, fetchedAt: null })
      if (key === this.raw) return
      this.raw = key
      this.snapshot = snapshot
      cx.notify()
    })
  }

  // Key commands ("pull-deck.open" in keys.json, or `herdr-app do pull-deck.open`). "search:ABV-1"
  // fills the field and searches without taking the keyboard; "focus" takes it.
  command(name, cx) {
    if (name.startsWith('search:')) {
      this.input.set_value(name.slice(7))
      return this.type(name.slice(7), cx)
    }
    if (name === 'focus' || name === 'search') return this.input.focus()
    if (name === 'open') return this.openSelected(cx)
    if (name === 'open-all') return this.openAll(cx)
    if (name === 'refresh') return this.reload(cx)
    if (name === 'down' || name === 'up') return this.move(name === 'down' ? 1 : -1, cx)
  }

  scopes() {
    const wanted = Array.isArray(props()?.scopes) ? props().scopes : null
    return wanted ? SCOPES.filter(s => wanted.includes(s.scope)) : SCOPES
  }

  fields() {
    const wanted = Array.isArray(props()?.fields) ? props().fields : ALL_FIELDS
    return new Set(wanted)
  }

  scope() {
    const shown = this.scopes()
    const scope = shownScope(this.snapshot, this.picked)
    return shown.some(s => s.scope === scope) ? scope : (shown[0]?.scope ?? 'mine')
  }

  searching() {
    return this.query.trim() !== '' && this.found?.query === this.query ? this.found : null
  }

  rows() {
    if (this.snapshot?.kind !== 'list') return []
    return deckRows(this.snapshot, this.scope(), this.searching())
  }

  // Every keystroke asks without waiting; a reply lands only if its query is still the field's text.
  type(text, cx) {
    this.query = text
    this.at = 0
    if (!text.trim()) {
      this.found = null
      return cx.notify()
    }
    cx.notify()
    cx.spawn(async cx => {
      const { status, text: reply } = await this.call('/search', { query: text }, 6)
      if (this.query !== text) return
      this.found = toFound(text, status, reply)
      this.at = 0
      cx.notify()
    })
  }

  move(by, cx) {
    const count = this.rows().length
    if (count === 0) return
    this.at = (this.at + by + count) % count
    this.scroll.scroll_to_item(this.at)
    cx.notify()
  }

  choose(scope, cx) {
    this.picked = scope
    this.at = 0
    cx.notify()
  }

  // Enter while searching asks again first, as the Claude Code pane does, rather than trusting a
  // reply that may be for older text; then it opens the selected match (the top one by default).
  // `busy` is set before the task starts, so Enter arriving twice (the field's submit and the key
  // handler, or a fast double press) opens once instead of earning the relay's 409.
  openSelected(cx) {
    if (this.busy) return
    this.busy = 'pending'
    const text = this.query
    cx.spawn(async cx => {
      try {
        if (text.trim()) {
          const { status, text: reply } = await this.call('/search', { query: text }, 6)
          if (this.query !== text) return
          this.found = toFound(text, status, reply)
          if (this.found.kind === 'failed') return this.say(this.found.message, false, cx)
        }
        const row = this.rows()[this.at] ?? this.rows()[0]
        if (row) await this.open('/open', { prId: row.pr.id }, row.pr.id, cx)
      } finally {
        if (this.busy === 'pending') this.busy = null
        cx.notify()
      }
    })
  }

  openAll(cx) {
    if (this.busy || this.snapshot?.kind !== 'list' || this.searching()) return
    const scope = this.scope()
    this.busy = '*'
    cx.spawn(async cx => this.open('/open-all', { scope }, '*', cx))
  }

  // One open at a time, as in the menu bar app; the relay allows one viewer open (409 otherwise).
  async open(path, body, busy, cx) {
    this.busy = busy
    this.said = null
    cx.notify()
    const { status, text } = await this.call(path, body, 35)
    this.busy = null
    const failure = openFailure(status, text)
    if (failure) {
      notify({ title: 'Pull Deck', body: failure, level: 'error' })
      this.say(failure, false, cx)
    } else {
      let focused = false
      try {
        focused = JSON.parse(text)?.data?.focused === true
      } catch {}
      this.say(focused ? 'Focused its tab in the browser' : 'Opened in the browser', true, cx)
    }
    this.raw = null
    this.reload(cx)
  }

  say(text, ok, cx) {
    this.said = { text, ok, at: Date.now() }
    cx.notify()
  }

  keys(e, cx) {
    const k = e.keystroke
    if (k === 'down' || k === 'up') this.move(k === 'down' ? 1 : -1, cx)
    else if (k === 'cmd-enter') this.openAll(cx)
    else if (k === 'enter' && !this.inputFocused) this.openSelected(cx)
    else if (k === '/' && !this.inputFocused) this.input.focus()
    else if (k === 'escape' && this.query) {
      this.input.set_value('')
      this.type('', cx)
    } else return
    cx.stop_propagation()
  }

  // ---------------------------------------------------------------- drawing

  render() {
    const t = theme()
    const root = v_flex()
      .id('pull-deck')
      .on_size_change((size, cx) => {
        const width = size.width / (settings().zoom || 1)
        if (Math.abs(width - (this.width ?? 0)) < 1) return
        this.width = width
        cx.notify()
      })
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.keys(e, cx))
      .on_click(() => {
        if (!this.inputFocused) this.handle.focus()
      })
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
    if (this.width !== null && this.width < FOLDED) return root.items_center().justify_center().child(this.rail(t))
    const snap = this.snapshot
    root.child(this.header(t, snap))
    if (!snap) return root.child(this.notice(t, 'Loading…', 'Asking the Pull Deck bridge for your pull requests.'))
    if (snap.kind === 'down') return root.child(this.notice(t, 'Not connected', snap.reason, 'working', true))
    if (snap.kind === 'onboarding')
      return root.child(
        this.notice(
          t,
          'Connect GitHub',
          'Open the Pull Deck extension in Chrome and paste a personal access token. The token stays there.',
          'working',
        ),
      )
    if (snap.kind === 'error')
      return root.child(this.notice(t, 'Couldn’t load pull requests', snap.message, 'blocked', true))
    const dock = this.dock(t, snap)
    // One scope needs no switcher: its count moves into the header.
    return root
      .when(this.scopes().length > 1, el => el.child(this.tabs(t, snap)))
      .child(this.search(t))
      .child(this.list(t, snap))
      .when(Boolean(dock), el => el.child(dock))
  }

  rail(t) {
    const snap = this.snapshot
    const count = snap?.kind === 'list' ? snap.scopes[this.scope()].length : null
    return v_flex()
      .items_center()
      .gap(4)
      .child(
        svg(ICON('git-compare'))
          .size(15)
          .text_color(snap?.kind === 'list' ? t.muted : t.working),
      )
      .child(
        div()
          .text_size(10)
          .text_color(t.dim)
          .child(count === null ? '' : String(count)),
      )
  }

  header(t, snap) {
    const login = snap?.kind === 'list' && snap.login ? `@${snap.login}` : ''
    return h_flex()
      .px(16)
      .h(41)
      .pt(14)
      .pb(5)
      .flex_none()
      .items_center()
      .gap(6)
      .child(
        div()
          .text_size(11.5)
          .font_medium()
          .text_color(t.dim)
          .child(
            this.scopes().length === 1
              ? { mine: 'My pull requests', reviewing: 'Review requests', assigned: 'Assigned to me' }[
                  this.scopes()[0].scope
                ]
              : 'Pull requests',
          ),
      )
      .when(this.scopes().length === 1 && snap?.kind === 'list', el =>
        el.child(
          div()
            .text_size(11)
            .text_color(t.dim)
            .child(String(snap.scopes[this.scope()].length) + (snap.truncated.includes(this.scope()) ? '+' : '')),
        ),
      )
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).opacity(0.7).child(login))
      .child(
        div()
          .id('pd-refresh')
          .text_color(t.dim)
          .cursor_pointer()
          .hover(s => s.text_color(t.foreground))
          .tooltip('Refresh')
          .on_click((_e, cx) => {
            this.raw = null
            this.reload(cx)
          })
          .child(svg(ICON('clock')).size(13)),
      )
  }

  notice(t, title, body, tone, retry = false) {
    return v_flex()
      .mx(12)
      .mt(2)
      .p(10)
      .gap(4)
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.surface)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(
            div()
              .size(7)
              .rounded(4)
              .flex_none()
              .bg(tone ? t[tone] : t.dim),
          )
          .child(div().text_size(12.5).font_medium().text_color(t.foreground).child(title)),
      )
      .child(div().text_size(11.5).text_color(t.muted).child(body))
      .when(retry, el =>
        el.child(
          div()
            .id('pd-retry')
            .mt(2)
            .text_size(11.5)
            .text_color(t.accent)
            .cursor_pointer()
            .hover(s => s.text_color(t.foreground))
            .on_click((_e, cx) => {
              this.raw = null
              this.reload(cx)
            })
            .child('Try again'),
        ),
      )
  }

  tabs(t, snap) {
    const scope = this.scope()
    return h_flex()
      .mx(12)
      .p(2)
      .gap(2)
      .flex_none()
      .rounded(8)
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .children(
        this.scopes().map(({ scope: s, label }) => {
          const on = s === scope && !this.searching()
          const count = snap.scopes[s].length
          return h_flex()
            .id(`pd-scope-${s}`)
            .flex_1()
            .h(24)
            .gap(5)
            .items_center()
            .justify_center()
            .rounded(6)
            .cursor_pointer()
            .when(on, el => el.bg(t.selected))
            .when(!on, el => el.hover(st => st.bg(t.hover)))
            .on_click((_e, cx) => this.choose(s, cx))
            .child(
              div()
                .text_size(12)
                .text_color(on ? t.foreground : t.muted)
                .when(on, el => el.font_medium())
                .child(label),
            )
            .when(count > 0, el =>
              el.child(
                div()
                  .text_size(10.5)
                  .text_color(on ? t.muted : t.dim)
                  .child(String(count) + (snap.truncated.includes(s) ? '+' : '')),
              ),
            )
        }),
      )
  }

  search(t) {
    return h_flex()
      .mx(12)
      .mt(8)
      .h(30)
      .flex_none()
      .px(9)
      .gap(7)
      .items_center()
      .rounded(8)
      .border_1()
      .border_color(this.inputFocused ? t.accent : t.border)
      .bg(t.background)
      .child(svg(ICON('search')).size(13).text_color(t.dim))
      .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground))
      .child(
        div()
          .text_size(10.5)
          .text_color(t.dim)
          .child(this.inputFocused ? '↵ open' : '/'),
      )
  }

  list(t, snap) {
    const found = this.searching()
    const rows = this.rows()
    const now = Date.now()
    const look = props()?.look ?? 'cards'
    const empty = found
      ? found.kind === 'failed'
        ? found.message
        : rows.length === 0
          ? NOT_IN_SNAPSHOT
          : null
      : rows.length === 0
        ? 'No open pull requests here.'
        : null
    return v_flex()
      .id('pd-list')
      .flex_1()
      .min_h(0)
      .mt(6)
      .px(8)
      .track_scroll(this.scroll)
      .overflow_y_scrollbar()
      .when(Boolean(empty), el => el.child(div().px(8).py(6).text_size(12).text_color(t.dim).child(empty)))
      .children(rows.map((row, i) => this.row(t, row, i, now, look, snap)))
      .when(Boolean(found?.isStale), el =>
        el.child(div().px(8).py(4).text_size(11).text_color(t.dim).child('The list may be out of date.')),
      )
  }

  row(t, { pr, labels, chips, inGroup }, i, now, look, snap) {
    const fields = this.fields()
    const selected = i === this.at && (this.inputFocused || this.handle.is_focused?.() || this.query !== '')
    const opening = this.busy === pr.id || this.busy === '*'
    const dimmed = Boolean(this.busy) && !opening
    const shown = chips.filter(c =>
      c.text === 'Checks failed' || c.text === 'Checks running' ? fields.has('ci') : fields.has('review'),
    )
    // With every fact shown this is the Claude Code pane's line; fewer facts drop their part.
    const metaText =
      fields.has('repo') && fields.has('age')
        ? metaLine(pr, labels, now)
        : [
            labels?.join(' · '),
            fields.has('repo') ? pr.repo : '',
            `#${pr.number}`,
            fields.has('age') ? age(pr.updatedAt, now) : '',
          ]
            .filter(Boolean)
            .join(' · ')
    const diff = fields.has('diff')
      ? h_flex()
          .flex_none()
          .gap(4)
          .text_size(11)
          .child(
            div()
              .text_color(t.ansi2 ?? t.done)
              .child(`+${fmt(pr.additions)}`),
          )
          .child(
            div()
              .text_color(t.blocked)
              .child(`−${fmt(pr.deletions)}`),
          )
      : null
    const mark = opening
      ? svg(ICON('spinner')).size(13).flex_none().text_color(t.accent).spin(900)
      : inGroup
        ? svg(ICON('circle-check')).size(13).flex_none().text_color(t.accent)
        : null
    const base = v_flex()
      .id(`pd-row-${pr.id}`)
      .flex_none()
      .px(8)
      .rounded(8)
      .cursor_pointer()
      .when(selected, el => el.bg(t.selected))
      .when(!selected, el => el.hover(s => s.bg(t.hover)))
      .when(dimmed, el => el.opacity(0.5))
      .tooltip(`${pr.title}\n${pr.repo} #${pr.number}`)
      .on_click((_e, cx) => {
        this.at = i
        if (this.busy) return
        this.busy = pr.id
        cx.spawn(async cx => this.open('/open', { prId: pr.id }, pr.id, cx))
      })

    if (look === 'lines') {
      // One line per pull request: CI and review as dots, then the title, then the diff.
      const ci = shown.find(c => c.text.startsWith('Checks'))
      const review = shown.find(c => !c.text.startsWith('Checks'))
      return base.child(
        h_flex()
          .h(30)
          .gap(8)
          .items_center()
          .child(
            div()
              .size(7)
              .flex_none()
              .rounded(4)
              .when(Boolean(ci), el => el.bg(tone(t, ci.color)))
              .when(!ci, el => el.border(1.5).border_color(t.dim)),
          )
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(pr.title))
          .when(Boolean(review), el =>
            el.child(div().flex_none().text_size(11).text_color(tone(t, review.color)).child(review.glyph)),
          )
          .when(Boolean(diff), el => el.child(diff))
          .when(Boolean(mark), el => el.child(mark)),
      )
    }

    if (look === 'ledger') {
      // The number first, as people say it ("11780"), then the title; facts as words underneath.
      return base.py(6).child(
        h_flex()
          .gap(10)
          .items_start()
          .child(
            div()
              .w(44)
              .flex_none()
              .text_size(11.5)
              .font_medium()
              .text_color(inGroup ? t.accent : t.muted)
              .child(`#${pr.number}`),
          )
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(2)
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(pr.title))
                  .when(Boolean(mark), el => el.child(mark)),
              )
              .child(
                h_flex()
                  .gap(8)
                  .items_center()
                  .text_size(11)
                  .child(
                    div()
                      .flex_1()
                      .min_w(0)
                      .truncate()
                      .text_color(t.dim)
                      .child(
                        [
                          ...shown.map(c => c.text),
                          labels ? labels.join(' · ') : '',
                          fields.has('age') ? age(pr.updatedAt, now) : '',
                        ]
                          .filter(Boolean)
                          .join(' · '),
                      ),
                  )
                  .when(Boolean(diff), el => el.child(diff)),
              ),
          ),
      )
    }

    // cards (default): two lines. The title on one line (the tooltip has all of it), then the
    // status chips, the facts and the diff size.
    return base
      .py(4)
      .gap(1)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(pr.title))
          .when(Boolean(mark), el => el.child(mark)),
      )
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .text_size(11)
          .children(
            shown.map(c =>
              h_flex()
                .flex_none()
                .h(16)
                .px(5)
                .items_center()
                .rounded(4)
                .bg(tone(t, c.color) + '22')
                .text_size(10)
                .font_medium()
                .text_color(tone(t, c.color))
                .child(`${c.glyph} ${c.text}`),
            ),
          )
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(metaText))
          .when(Boolean(diff), el => el.child(diff)),
      )
  }

  dock(t, snap) {
    const scope = this.scope()
    const rows = snap.scopes[scope]
    const grouped = new Set(snap.groupKeys)
    const pending = rows.filter(pr => !(pr.key !== null && grouped.has(pr.key))).length
    const searching = Boolean(this.searching())
    const note = searching ? '' : footnote(rows.length, pending, snap.truncated.includes(scope), snap.isGroupElsewhere)
    const said = this.said && Date.now() - this.said.at < 8_000 ? this.said : null
    const line = [said?.text, note, snap.isStale ? 'The list may be out of date.' : '', snap.warning ?? '']
      .filter(Boolean)
      .join(' ')
    const can = !searching && pending > 0 && !this.busy
    // Every row already sits in the group: there is nothing for the button to do, so it goes.
    const button = !searching && !(pending === 0 && rows.length > 0)
    if (!button && !line) return null
    return v_flex()
      .flex_none()
      .px(12)
      .pt(6)
      .pb(10)
      .gap(5)
      .border_t(1)
      .border_color(t.border)
      .when(button, el =>
        el.child(
          h_flex()
            .id('pd-open-all')
            .h(28)
            .px(10)
            .gap(8)
            .items_center()
            .rounded(7)
            .when(can, el =>
              el
                .bg(t.solid)
                .cursor_pointer()
                .hover(s => s.opacity(0.9)),
            )
            .when(!can, el => el.bg(t.surface))
            .on_click((_e, cx) => this.openAll(cx))
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(12)
                .font_medium()
                .text_color(can ? t.solid_foreground : t.dim)
                .child(this.busy === '*' ? 'Opening…' : dockLabel(rows.length, pending, snap.groupTitle)),
            )
            .child(
              div()
                .text_size(10.5)
                .text_color(can ? t.solid_foreground : t.dim)
                .opacity(0.7)
                .child('⌘↵'),
            ),
        ),
      )
      .when(Boolean(line), el =>
        el.child(
          div()
            .text_size(11)
            .text_color(said && !said.ok ? t.blocked : t.dim)
            .child(line),
        ),
      )
  }
}
