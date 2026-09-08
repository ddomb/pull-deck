# Security

## Reporting a vulnerability

Use the repository's **Security → Advisories → Report a vulnerability** control to send details privately to maintainers. This channel must be enabled before the public launch. If it is unavailable, open an issue requesting a private contact channel without including the vulnerability details. Do not post tokens or private repository data publicly.

Include the affected version, a minimal sanitized reproduction, the impact, and whether you can reproduce it in an isolated browser profile. The current release is the supported version; there is no promised response-time SLA.

## Data and permissions

The GitHub token and PR cache live in `chrome.storage.local`, within the browser profile. This storage is not encrypted by Pull Deck. The token is sent only to `https://api.github.com/graphql`; the native companion receives account/PR state, but never the token. Forgetting the token clears the active account cache and cancels obsolete refreshes. This does not revoke the token at GitHub or remove the browser's own browsing history.

Tab URLs are read for duplicate detection. The resolver's HTML entry point is web-accessible so links from other apps and sites can reach it. Other sites cannot read its extension-origin DOM, and the page refuses framing. Do not put secrets in shortcut URLs: browser history and other installed extensions are outside Pull Deck's control.

The native host allowlist is generated from the extension's public key. Its Unix socket uses owner-only filesystem access. Applications running as the same operating-system user are inside this local trust boundary. Only one browser profile controls the companion at a time; extra connections receive an explicit rejection.

The extension archive is built from an allowlist of runtime files. Signing keys, local fixtures, development dependencies, and native build output are excluded. Maintainers must enable private vulnerability reporting and review release artifacts before publishing.
