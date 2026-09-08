// Row furniture, shared by the popup and the shortcut page.
//
// Extracted for one reason above the others: `badgesFor` is the mapping from
// GitHub's review and check states to what a person actually sees. Two copies
// of that drift, and then the two surfaces disagree about whether the same pull
// request is approved — which is worse than either of them being wrong, because
// there is no longer a right answer to point at.

import { icons } from './icons.js';

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Icon markup is authored in icons.js, never derived from remote data. */
export function glyph(markup) {
  const holder = document.createElement('span');
  holder.innerHTML = markup;
  return holder.firstElementChild;
}

/** Compact age: 4m, 3h, 6d, 2w. Terser than Intl and matches the copy. */
export function age(iso) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)}d`;
  const weeks = days / 7;
  if (weeks < 53) return `${Math.floor(weeks)}w`;
  return `${Math.floor(days / 365)}y`;
}

export function badge(tone, iconMarkup, label) {
  const node = el('span', 'badge');
  node.dataset.tone = tone;
  node.append(glyph(iconMarkup), el('span', null, label));
  return node;
}

export function badgesFor(pr) {
  return badgeItems(pr).map((item) => badge(item.tone, item.icon, item.label));
}

export function rowLabel(pr, grouping = '') {
  const status = badgeItems(pr)
    .map((item) => item.label)
    .join('. ');
  return (
    [pr.title, `${pr.repo} number ${pr.number}`, status, grouping].filter(Boolean).join('. ') + '.'
  );
}

export function badgeItems(pr) {
  const out = [];
  const item = (tone, icon, label) => ({ tone, icon, label });
  if (pr.isDraft) out.push(item('neutral', icons.draft, 'Draft'));

  if (pr.reviewDecision === 'APPROVED') out.push(item('success', icons.approved, 'Approved'));
  else if (pr.reviewDecision === 'CHANGES_REQUESTED')
    out.push(item('danger', icons.changes, 'Changes'));
  else if (pr.reviewDecision === 'REVIEW_REQUIRED' && !pr.isDraft) {
    out.push(item('neutral', icons.review, 'In review'));
  }

  // Only non-passing checks earn a badge. A green tick on every row is noise,
  // and the thing worth spotting in a glance is the failure.
  if (pr.checks === 'FAILURE' || pr.checks === 'ERROR') {
    out.push(item('danger', icons.ciFail, 'Checks failed'));
  } else if (pr.checks === 'PENDING' || pr.checks === 'EXPECTED') {
    out.push(item('pending', icons.ciPending, 'Checks running'));
  }
  return out;
}
