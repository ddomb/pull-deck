// The panel <-> worker contract. The worker owns the relay (panels have no network); both panels
// draw from the Snapshot it answers, with the shared model.js the Herdr and Claude Code mods use.
import type { Found, Scope, Snapshot } from '../../types'

export type { Found, Scope, Snapshot }

/** How one open went: the first failure the relay reported, or whether it only focused a tab. */
export type Opened = { ok: true; focused: boolean } | { ok: false; message: string }

declare module 'orca' {
  interface PluginRequests {
    /** The relay's `GET /state`, reduced by toSnapshot. `force` skips the worker's 5 s reuse. */
    'deck.state': { input: { force?: boolean }; output: Snapshot }
    /** The relay's `POST /search`, ids best match first. */
    'deck.search': { input: { query: string }; output: Found }
    /** `POST /open` for one pull request. */
    'deck.open': { input: { prId: string }; output: Opened }
    /** `POST /open-all` for one scope. */
    'deck.openAll': { input: { scope: Scope }; output: Opened }
  }
}
