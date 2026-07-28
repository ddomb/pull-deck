# PRODUCT.md — Pull Deck

**register:** product

## Product purpose

A Chromium extension that answers one question fast: *what pull requests are waiting on me?* And then does one thing well: puts them all into a single tab group, without ever opening the same PR twice.

It is a glance-and-go tool. The popup is opened 10–20 times a day for three seconds at a time. Anything that makes those three seconds slower is a defect.

## Users

One user archetype: a working engineer who lives in Chrome, keeps 40 tabs open, and reviews or ships several PRs a day. They know GitHub well. They do not want GitHub explained to them. They want the list, the state of each item, and the button.

They are on macOS, on a Retina display, in variable light: bright office in the afternoon, dim room at night. The popup hangs off the browser toolbar, immediately adjacent to Chrome's own chrome.

## Tone

Terse and factual. Counts, not adjectives. The interface names what it will do before it does it ("Open 5 in Pull Requests"), and reports what it did ("Added 5"). No exclamation marks, no encouragement, no personality in the copy. The personality lives in the motion and the material, not the words.

## Anti-references

- **GitHub Primer dark + merge-green badges.** The first-order category reflex. This is not a GitHub skin.
- **Linear-violet on near-black.** The second-order reflex for "dev tool that isn't GitHub".
- **Dashboard framing.** No hero metrics, no stat tiles, no "you have 7 PRs" headline. The list *is* the content.
- **Card grids.** A PR is a row in a grouped list, not a card in a grid.
- **Modals.** Settings is an inline panel. Nothing in this product warrants a dialog.

## Strategic principles

1. **The idempotency promise is the product.** Clicking the button twice must not produce fourteen tabs. Every URL-matching and group-identity decision is made in service of that promise, and it is defended against renamed groups, `/files` sub-paths, and query strings.
2. **Real state, never theater.** The progress a user sees while tabs open reflects tabs that actually opened. No fabricated choreography, no fake delays to look busy.
3. **The token is the user's, and it is local.** Stored in `chrome.storage.local`, never transmitted anywhere except `api.github.com`, revocable and replaceable from inside the UI, and described honestly (profile-local, not encrypted).
4. **Follow the system.** Light and dark are both first-class, driven by `prefers-color-scheme`, because a popup that disagrees with the browser it hangs from looks broken.
5. **Degrade loudly, fail quietly never.** Bad token, exhausted rate limit, offline, zero results, and partial tab-open failures each get a specific, actionable state. "Something went wrong" is not shipped.

## Scope boundaries

In scope: authenticating with a PAT, listing open PRs across three relationships (authored, review-requested, assigned), opening them into one named tab group idempotently, a toolbar badge count.

Out of scope: merging, reviewing, commenting, notifications inbox, multi-account, GitHub Enterprise Server (single `api.github.com` host).
