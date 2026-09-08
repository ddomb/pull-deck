import { parseShortcut } from './resolve.js';

/** The entire original URL follows this prefix; its ampersands are not outer parameters. */
export function shortcutFromLocation(location) {
  const prefix = '?shortcut=';
  if (location.search.startsWith(prefix)) {
    return parseShortcut(location.search.slice(prefix.length) + location.hash);
  }
  return null;
}

/** A delayed worker command may act only while its originating document is current. */
export function sourceGuard(sender) {
  const tabId = sender?.tab?.id;
  const expectedURL = sender?.url;
  const documentId = sender?.documentId;
  return async () => {
    if (
      typeof tabId !== 'number' ||
      !documentId ||
      !expectedURL?.startsWith(chrome.runtime.getURL('src/resolve.html'))
    )
      return false;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url !== expectedURL || (tab.pendingUrl && tab.pendingUrl !== expectedURL))
        return false;
      const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
      return frame?.documentId === documentId;
    } catch {
      return false;
    }
  };
}
