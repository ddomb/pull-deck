import { mergeScopes } from './github.js';

export async function refreshBadge(cache, settings) {
  const count = settings.badgeEnabled && cache ? mergeScopes(cache.scopes).length : 0;
  await chrome.action.setBadgeBackgroundColor({ color: '#1d7f8c' });
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
}
