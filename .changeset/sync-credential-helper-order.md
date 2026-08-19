---
"@inkeep/open-knowledge": patch
---

Git sync no longer gets stuck behind a stale credential stored elsewhere on your machine. Git lets several credential helpers be configured at once and uses the first one that answers, and macOS installs its own keychain helper system-wide by default. Sync was adding OK's helper to the end of that list, so on most Macs the keychain answered first and OK's own credential was never used. If whatever the keychain held had expired, GitHub rejected it, sync stopped, and the app showed "GitHub authentication failed" even though OK had a perfectly good token in hand. Sync now clears the inherited list before adding its own helper, so it authenticates with the credential OK actually resolved. The same approach was already used when cloning a repository; this brings sync in line with it.

Two things worth knowing about who this changes:

- If your project's remote is on GitHub (or GitHub Enterprise) and the only working credential on your machine was one of those ambient helpers, sync will now ask you to sign in rather than quietly borrowing that credential. Signing in from the sync panel restores it.
- If your remote is on GitLab, Bitbucket, or another non-GitHub host, nothing changes. OK cannot issue a credential for those hosts, so it leaves your existing credential helper alone rather than clearing the one you are actually syncing with.
