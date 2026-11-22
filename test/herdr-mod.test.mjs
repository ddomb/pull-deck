// The Herdr.app mod (claude-mod/herdr/main.js) drawn against the same replays as the Claude Code mod's
// parity test (claude-mod/tests/herdr-parity.test.ts): both must list the relay's rows in the relay's
// order, and the bridge's search ranking as it arrived.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/herdr-loader.mjs', import.meta.url);
const { runtime, walk } = await import('./helpers/herdr-runtime.mjs?herdr');
const { default: PullDeck } = await import('../claude-mod/herdr/main.js');
const { toSnapshot, toFound } = await import('../claude-mod/herdr/model.js');
const { curlArgs, fromCurl } = await import('../claude-mod/herdr/relay.js');
const { live, fifty } = await import('../claude-mod/tests/herdr-fixtures.js');

const { loadState, resolveShortcut, searchPullRequests } = await import('../src/app-state.js');
const { fakeChrome, cached } = await import('./helpers/chrome.mjs');
const { lookupFetch } = await import('./helpers/outside.mjs');

const cx = { focus_handle: () => ({ is_focused: () => false, focus() {} }), notify() {} };

/** The mod as Herdr would hold it after the relay answered `reply` and, optionally, a search. */
function draw(reply, { scope = null, query = null, props = {} } = {}) {
  runtime.props = props;
  const view = new PullDeck();
  view.init(props, cx);
  view.snapshot = toSnapshot(200, JSON.stringify(reply.state));
  view.picked = scope;
  if (query !== null) {
    const data = reply.replies.find((r) => r.query === query).data;
    view.query = query;
    view.found = toFound(query, 200, JSON.stringify({ ok: true, error: null, data }));
  }
  return walk(view.render().node);
}
const rowIds = (nodes) =>
  nodes.flatMap((n) =>
    typeof n.id === 'string' && n.id.startsWith('pd-row-') ? [n.id.slice(7)] : []
  );
const texts = (nodes) => nodes.flatMap((n) => n.text);

for (const [name, reply] of [
  ['live capture', live],
  ['50 pull requests', fifty],
]) {
  test(`${name}: each scope draws the relay's rows in the relay's order`, () => {
    for (const scope of ['mine', 'reviewing', 'assigned']) {
      for (const look of ['cards', 'lines', 'ledger']) {
        const want = reply.state.state.scopes[scope].map((pr) => pr.id);
        assert.deepEqual(
          rowIds(draw(reply, { scope, props: { look } })),
          want,
          `${scope} (${look})`
        );
      }
    }
  });

  test(`${name}: each recorded search draws the bridge's ranking`, () => {
    for (const { query, data } of reply.replies) {
      const nodes = draw(reply, { query });
      assert.deepEqual(rowIds(nodes), data.prIds, query);
      const empty = texts(nodes).some((t) => t.startsWith('Not in your snapshot'));
      assert.equal(empty, data.prIds.length === 0, `${query} says not in snapshot only when empty`);
    }
  });
}

test('the scope tabs and row facts follow the props', () => {
  const two = draw(fifty, { props: { scopes: ['mine', 'reviewing'] } }).map((n) => n.id);
  assert.ok(two.includes('pd-scope-reviewing') && !two.includes('pd-scope-assigned'));
  const nodes = draw(fifty, { props: { scopes: ['reviewing'], fields: ['review'] } });
  const ids = nodes.map((n) => n.id).filter(Boolean);
  assert.ok(!ids.some((id) => id.startsWith('pd-scope-')), 'one scope draws no switcher');
  assert.ok(
    texts(nodes).includes('Review requests') && texts(nodes).includes('12'),
    'its name and count head the block'
  );
  assert.deepEqual(
    rowIds(nodes),
    fifty.state.state.scopes.reviewing.map((pr) => pr.id)
  );
  assert.ok(!texts(nodes).some((t) => /^\+\d/.test(t)), 'no diff size without the diff field');
});

test('the open-all button goes when every shown row is already in the group', () => {
  const ids = (reply) => draw(reply).map((n) => n.id);
  assert.ok(ids(live).includes('pd-open-all'), 'some rows are not in the group yet');
  const state = structuredClone(live.state);
  state.state.group.keys = state.state.scopes.mine.map((pr) => pr.key);
  assert.ok(!ids({ ...live, state }).includes('pd-open-all'), 'all of them are');
});

test('a state the relay cannot give rows for says why, with no rows', () => {
  const cases = [
    [
      { state: { app: false, state: null, error: null } },
      'The extension has not sent any pull requests yet.',
    ],
    [{ state: { app: true, state: { stage: 'onboarding' }, error: null } }, 'Connect GitHub'],
  ];
  for (const [reply, words] of cases) {
    const nodes = draw(reply);
    assert.deepEqual(rowIds(nodes), []);
    assert.ok(texts(nodes).includes(words), words);
  }
});

test('curl results become the relay status the model reads', () => {
  assert.deepEqual(fromCurl(0, '{"pong":true}\n200'), { status: 200, text: '{"pong":true}' });
  assert.deepEqual(fromCurl(0, '{"error":"busy"}\n409'), { status: 409, text: '{"error":"busy"}' });
  assert.deepEqual(fromCurl(7, '000'), { status: 0, text: '' }, 'nothing listens on the socket');
  assert.deepEqual(fromCurl(28, ''), { status: 0, text: '' }, 'timed out');
  const args = curlArgs('/s.sock', '/search', { query: 'a"b' }, 6);
  assert.deepEqual(args.slice(-3), [
    '--data-binary',
    '{"query":"a\\"b"}',
    'http://pull-deck/search',
  ]);
  assert.ok(args.includes('--unix-socket') && args.includes('/s.sock'));
});

test('a lookup outside my scopes leaves every Herdr row and search as it was', async () => {
  const h = fakeChrome({ cache: cached({ fetchedAt: Date.now() }) });
  const reply = async () => ({
    state: { app: true, state: await loadState(), error: null },
    replies: await Promise.all(
      ['ABV-13945', '14561'].map(async (query) => {
        const found = await searchPullRequests(query);
        return {
          query,
          data: { status: found.status, prIds: found.matches.map((pr) => pr.id), stale: false },
        };
      })
    ),
  });
  const drawn = (r) =>
    JSON.stringify([
      ...['mine', 'reviewing', 'assigned'].map((scope) => draw(r, { scope })),
      ...r.replies.map(({ query }) => draw(r, { query })),
    ]);

  const before = await reply();
  globalThis.fetch = lookupFetch();
  assert.equal((await resolveShortcut('ABV-13945')).matches[0].number, 14561);
  assert.equal((await resolveShortcut('14561')).matches[0].number, 14561);
  const after = await reply();
  assert.equal(h.calls.fetches, 0, 'only the lookups went out');
  assert.deepEqual(after, before);
  assert.equal(drawn(after), drawn(before));
  assert.ok(
    texts(draw(after, { query: 'ABV-13945' })).some((t) => t.startsWith('Not in your snapshot'))
  );
});
