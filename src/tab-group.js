// The idempotent open-into-a-group operation.
//
// Runs in the service worker, never in the popup: the first tab that gets
// created can take focus away from the popup, Chrome tears the popup document
// down, and every `await` after that point would never resume. A half-grouped
// set of tabs is exactly the failure the user asked us to avoid.

import { pullRequestKey } from './pr-url.js';

const NO_GROUP = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE

/** A pending navigation supersedes the committed URL, both toward and away from a PR. */
export function tabUrl(tab) {
  return tab.pendingUrl || tab.url || '';
}

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
export async function openIntoGroup(args) {
  let result;
  try {
    result = await fillGroup(args);
    return result;
  } finally {
    args.onProgress?.({
      kind: 'done',
      created: result?.created ?? 0,
      adopted: result?.adopted ?? 0,
      groupId: result?.groupId ?? null,
    });
  }
}

async function fillGroup({
  pullRequests,
  title,
  color,
  savedGroupId,
  onProgress = () => {},
  canContinue = async () => true,
}) {
  const focused = await currentWindowId();
  const group = await findGroup({ savedGroupId, title, windowId: focused });

  // New tabs are created in the group's own window so that grouping never
  // yanks tabs between windows behind the user's back.
  const targetWindowId = group ? group.windowId : focused;

  const inGroup = group ? await chrome.tabs.query({ groupId: group.id }) : [];
  const present = new Set();
  for (const tab of inGroup) {
    const key = pullRequestKey(tabUrl(tab));
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
    // Leave pinned tabs where they are: grouping one is at best a surprise,
    // and at worst it rejects and strands the whole batch ungrouped.
    if (tab.pinned) continue;
    const key = pullRequestKey(tabUrl(tab));
    if (key && !strays.has(key)) strays.set(key, tab.id);
  }

  // Which tab holds which pull request, so callers can focus one by id rather
  // than re-querying by URL (a freshly created tab often still has an empty
  // `url` with the destination in `pendingUrl`, so a URL query finds nothing).
  const tabIdByPr = {};
  const tabIdByKey = new Map();
  for (const tab of inGroup) {
    const key = pullRequestKey(tabUrl(tab));
    if (key && !tabIdByKey.has(key)) tabIdByKey.set(key, tab.id);
  }

  const missing = [],
    requested = new Set();
  const skipped = [];
  for (const pr of pullRequests) {
    const key = pullRequestKey(pr.url);
    if (!key) continue;
    if (requested.has(key)) continue;
    requested.add(key);
    if (present.has(key)) {
      skipped.push(pr.id);
      const existing = tabIdByKey.get(key);
      if (existing !== undefined) tabIdByPr[pr.id] = existing;
    } else missing.push({ ...pr, key });
  }

  const total = missing.length;
  // `kind`, not `type`: consumers wrap these as {type:'progress', ...event},
  // and a `type` here would overwrite that discriminator and silently strand
  // every progress update.
  onProgress({ kind: 'start', total, skipped: skipped.length });

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
      tabIdByPr,
    };
  }

  const tabIds = [];
  const opened = [];
  const failures = [];
  const warnings = [];
  let adopted = 0;
  let done = 0;

  for (const pr of missing) {
    let ok = true;
    try {
      if (!(await canContinue())) throw Error('The source page was closed or navigated away.');
      const strayId = strays.get(pr.key);
      if (strayId !== undefined) {
        tabIds.push(strayId);
        tabIdByPr[pr.id] = strayId;
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
        tabIdByPr[pr.id] = tab.id;
      }
      opened.push(pr.id);
    } catch (error) {
      ok = false;
      failures.push({ id: pr.id, message: String(error?.message ?? error) });
    }
    done++;
    onProgress({ kind: 'tab', done, total, id: pr.id, ok });
  }

  let groupId = group?.id ?? null;
  if (tabIds.length > 0) {
    try {
      if (!(await canContinue())) throw Error('The source page was closed or navigated away.');
      if (groupId !== null) await chrome.tabs.group({ tabIds, groupId });
      else
        groupId = await chrome.tabs.group({
          tabIds,
          createProperties: { windowId: targetWindowId },
        });
      for (const id of opened) onProgress({ kind: 'grouped', id, ok: true });
    } catch (error) {
      for (const id of opened)
        failures.push({
          id,
          message: `Tab remains open but could not be grouped: ${error.message}`,
        });
      opened.length = 0;
    }
    if (opened.length > 0) {
      try {
        await chrome.tabGroups.update(groupId, { title, color });
      } catch (error) {
        warnings.push(
          `Tabs were grouped, but the group name or color could not be updated: ${error.message}`
        );
      }
    }
  }

  return {
    created: tabIds.length - adopted,
    adopted,
    skipped: skipped.length,
    groupId,
    groupWindowId: targetWindowId,
    movedWindow: Boolean(group) && group.windowId !== focused,
    opened,
    failures,
    warnings,
    tabIdByPr,
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
    const key = pullRequestKey(tabUrl(tab));
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
