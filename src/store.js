// Everything persisted, in one place, with one shape.
//
// Service workers are torn down after 30 seconds of inactivity, so module-level
// variables are not storage. Anything that has to outlive a click lives here.

export const GROUP_COLORS = /** @type {const} */ ([
  // chrome.tabGroups.Color, exactly: note British "grey".
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]);

const DEFAULTS = {
  token: '',
  groupTitle: 'Pull Requests',
  groupColor: 'cyan',
  groupId: null,
  badgeEnabled: true,
  cache: null,
  lastError: null,
  authRevision: 0,
  nextFetchAt: 0,
  fetchFailures: 0,
};

export async function readSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const settings = { ...DEFAULTS, ...stored };
  // A colour that is not in the enum makes tabGroups.update throw.
  if (!GROUP_COLORS.includes(settings.groupColor)) settings.groupColor = DEFAULTS.groupColor;
  if (typeof settings.groupTitle !== 'string' || settings.groupTitle.trim() === '') {
    settings.groupTitle = DEFAULTS.groupTitle;
  }
  return settings;
}

export async function writeSettings(patch) {
  await chrome.storage.local.set(patch);
}

// Serialize storage commits, not network work. Auth changes can invalidate a
// request immediately and then clear any earlier commit already in progress.
let commits = Promise.resolve();
export function withSettingsLock(work) {
  const result = commits.then(work);
  commits = result.catch(() => {});
  return result;
}

export async function clearToken() {
  await chrome.storage.local.remove(['token', 'cache', 'lastError']);
}

/** Last four characters only: enough to tell two tokens apart, useless if seen. */
export function tokenFingerprint(token) {
  if (!token) return '';
  return `••••${token.slice(-4)}`;
}
