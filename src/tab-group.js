// The idempotent open-into-a-group operation.
//
// Runs in the service worker, never in the popup: the first tab that gets
// created can take focus away from the popup, Chrome tears the popup document
// down, and every `await` after that point would never resume. A half-grouped
// set of tabs is exactly the failure the user asked us to avoid.

import { pullRequestKey } from './pr-url.js';

const NO_GROUP = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE

/**
 * Locate the group we should be filling.
 *
 * Identity is the saved id first, title second. Title-only lookup breaks the
 * moment the user renames the group in Chrome, and then we would helpfully
 * create a second one.
 *
 * @returns {Promise<chrome.tabGroups.TabGroup|null>}
 */
export async function findGroup({ savedGroupId, title, windowId }) {
  if (typeof savedGroupId === 'number' && savedGroupId !== NO_GROUP) {
    try {
      const group = await chrome.tabGroups.get(savedGroupId);
      if (group) return group;
    } catch {
      // Group was closed since we last saw it; fall through to the title match.
    }
  }

  if (!title) return null;
  let matches = [];
  try {
    matches = await chrome.tabGroups.query({ title });
  } catch {
    return null;
  }
  if (matches.length === 0) return null;
  // Prefer one in the window the user is looking at.
  return matches.find((g) => g.windowId === windowId) ?? matches[0];
}

/**
 * Open every pull request into the target group, skipping any already there.
 *
 * @param {object} args
 * @param {{url: string, id: string}[]} args.pullRequests
 * @param {string} args.title
 * @param {chrome.tabGroups.Color} args.color
 * @param {number|null} args.savedGroupId
 * @param {(event: object) => void} [args.onProgress]
 */
export async function openIntoGroup({
  pullRequests,
  title,
  color,
  savedGroupId,
  onProgress = () => {},
}) {
  const focused = await currentWindowId();
  const group = await findGroup({ savedGroupId, title, windowId: focused });

  // New tabs are created in the group's own window so that grouping never
  // yanks tabs between windows behind the user's back.
  const targetWindowId = group ? group.windowId : focused;

  const inGroup = group ? await chrome.tabs.query({ groupId: group.id }) : [];
  const present = new Set();
  for (const tab of inGroup) {
    const key = pullRequestKey(tab.url ?? tab.pendingUrl);
    if (key) present.add(key);
  }

  // Reading tab.url needs the "tabs" permission. Without it Chrome returns
  // undefined rather than failing, the diff below matches nothing, and every
  // click silently duplicates the whole set. Say so loudly instead.
  if (inGroup.length > 0 && inGroup.every((tab) => tab.url === undefined)) {
    console.error(
      'Pull Deck: tab URLs are unreadable, so duplicate detection cannot work. ' +
        'The "tabs" permission is missing from manifest.json.'
    );
  }

  // Tabs already open in the same window but sitting outside the group: move
  // them in rather than opening a second copy.
  const strays = new Map();
  for (const tab of await chrome.tabs.query({ windowId: targetWindowId })) {
    if (group && tab.groupId === group.id) continue;
    const key = pullRequestKey(tab.url ?? tab.pendingUrl);
    if (key && !strays.has(key)) strays.set(key, tab.id);
  }

  const missing = [];
  const skipped = [];
  for (const pr of pullRequests) {
    const key = pullRequestKey(pr.url);
    if (!key) continue;
    if (present.has(key)) skipped.push(pr.id);
    else missing.push({ ...pr, key });
  }

  const total = missing.length;
  onProgress({ type: 'start', total, skipped: skipped.length });

  if (total === 0) {
    return {
      created: 0,
      adopted: 0,
      skipped: skipped.length,
      groupId: group?.id ?? null,
      groupWindowId: group?.windowId ?? null,
      movedWindow: false,
      opened: [],
      failures: [],
    };
  }

  const tabIds = [];
  const opened = [];
  const failures = [];
  let adopted = 0;
  let done = 0;

  for (const pr of missing) {
    try {
      const strayId = strays.get(pr.key);
      if (strayId !== undefined) {
        tabIds.push(strayId);
        strays.delete(pr.key);
        adopted++;
      } else {
        // active:false keeps focus (and the popup) where it is.
        const tab = await chrome.tabs.create({
          url: pr.url,
          active: false,
          windowId: targetWindowId,
        });
        tabIds.push(tab.id);
      }
      opened.push(pr.id);
    } catch (error) {
      failures.push({ id: pr.id, message: String(error?.message ?? error) });
    }
    done++;
    onProgress({ type: 'tab', done, total, id: pr.id, ok: failures.at(-1)?.id !== pr.id });
  }

  let groupId = group?.id ?? null;
  if (tabIds.length > 0) {
    if (groupId !== null) {
      await chrome.tabs.group({ tabIds, groupId });
    } else {
      groupId = await chrome.tabs.group({
        tabIds,
        createProperties: { windowId: targetWindowId },
      });
    }
    // Re-assert title and colour: cheap, and it repairs a renamed group.
    await chrome.tabGroups.update(groupId, { title, color });
  }

  onProgress({ type: 'done', created: tabIds.length - adopted, adopted, groupId });

  return {
    created: tabIds.length - adopted,
    adopted,
    skipped: skipped.length,
    groupId,
    groupWindowId: targetWindowId,
    movedWindow: Boolean(group) && group.windowId !== focused,
    opened,
    failures,
  };
}

/** How many of these pull requests are already sitting in the group. */
export async function readGroupState({ savedGroupId, title }) {
  const focused = await currentWindowId();
  const group = await findGroup({ savedGroupId, title, windowId: focused });
  if (!group) return { groupId: null, keys: [], otherWindow: false };

  const tabs = await chrome.tabs.query({ groupId: group.id });
  const keys = [];
  for (const tab of tabs) {
    const key = pullRequestKey(tab.url ?? tab.pendingUrl);
    if (key) keys.push(key);
  }
  return { groupId: group.id, keys, otherWindow: group.windowId !== focused };
}

async function currentWindowId() {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (win?.id !== undefined) return win.id;
  } catch {
    /* fall through */
  }
  return chrome.windows.WINDOW_ID_CURRENT;
}
