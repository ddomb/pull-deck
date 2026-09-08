// Dev-only chrome stub for the generated shortcut-page preview.
//
// A module, not a classic script like preview-fixtures.js: module scripts run
// in document order, so this one installs `chrome` before resolve-page.js gets
// a chance to call it. It also lets the stub import the *real* matcher — the
// states you see here are produced by src/resolve.js, not by a second copy of
// the rules that would quietly disagree with it.

import { findMatches } from '../../../src/resolve.js';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') ?? 'default';
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

const ALL = [
  {
    id: 'a',
    number: 6081,
    title: 'Stop the session refresher from thundering on cold start',
    url: 'https://github.com/Above-Security/above/pull/6081',
    repo: 'Above-Security/above',
    headRefName: 'ddomb/ABV-4242-session-refresher',
    isDraft: false,
    updatedAt: hoursAgo(0.4),
    reviewDecision: 'APPROVED',
    checks: 'SUCCESS',
  },
  {
    id: 'b',
    number: 6099,
    title: 'Revert the refresher change while the rollout settles',
    url: 'https://github.com/Above-Security/above/pull/6099',
    repo: 'Above-Security/above',
    headRefName: 'ddomb/ABV-4242-revert',
    isDraft: false,
    updatedAt: hoursAgo(2),
    reviewDecision: 'REVIEW_REQUIRED',
    checks: 'PENDING',
  },
  {
    id: 'c',
    number: 887,
    title: 'Batch identity lookups behind a single debounced call',
    url: 'https://github.com/Above-Security/browser-extension/pull/887',
    repo: 'Above-Security/browser-extension',
    headRefName: 'ddomb/ABV-9001-batch-identity',
    isDraft: false,
    updatedAt: hoursAgo(9),
    reviewDecision: 'CHANGES_REQUESTED',
    checks: 'FAILURE',
  },
  {
    id: 'd',
    number: 231,
    title: 'Route every read through the primary replica',
    url: 'https://github.com/Above-Security/infra/pull/231',
    repo: 'Above-Security/infra',
    headRefName: 'ddomb/ABV-7777-primary-reads',
    isDraft: true,
    updatedAt: hoursAgo(30),
    reviewDecision: null,
    checks: 'SUCCESS',
  },
];

const all = scenario === 'nothing-open' ? [] : ALL;

function answer(query) {
  if (scenario === 'noToken') return { query, status: 'noToken', matches: [], all: [] };
  if (scenario === 'error') {
    return {
      query,
      status: 'error',
      error: { kind: 'offline', message: 'Could not reach github.com.' },
      matches: [],
      all: [],
    };
  }
  return { query, ...findMatches(query, all) };
}

// Typed loose on purpose: a literal here narrows `chrome` project-wide, and the
// editor then reports every real API the stub happens not to implement as an
// error in service-worker.js.
/** @type {any} */
const stub = {
  runtime: {
    async sendMessage(message) {
      await new Promise((r) => setTimeout(r, 120));
      if (message?.type === 'resolve') return { ok: true, data: answer(message.query ?? '') };
      if (message?.type === 'openShortcut')
        return {
          ok: true,
          data: { groupId: 12, opened: [message.prId], focused: true, failures: [] },
        };
      return { ok: false, error: { kind: 'unknown', message: `unhandled ${message?.type}` } };
    },
  },
  tabs: {
    // Two tabs, so dismissSelf takes its normal path rather than the
    // last-tab-in-the-window branch. It is stubbed out below regardless.
    async getCurrent() {
      return { id: 1, windowId: 1 };
    },
    async query() {
      return [{ id: 1 }, { id: 2 }];
    },
    async remove() {
      document.getElementById('foot').textContent = '(preview: this tab would close now)';
    },
  },
};

globalThis.chrome = stub;
