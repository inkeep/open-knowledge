---
'@inkeep/open-knowledge': patch
'@inkeep/open-knowledge-server': patch
'@inkeep/open-knowledge-core': patch
---

**Fix:** GitHub Enterprise Server hosts are no longer ignored (#597). Auth
resolution, the sync token relay, and the push-permission probe now derive
their host from the workspace's origin remote instead of assuming github.com:
`resolveAuth` scopes gh detection to the origin host, the sync engine relays
the origin host's token, origin classification recognizes GHES hostnames
(with browsable remote links in the sync UI), the `ok auth` subcommands
default `--host` to the workspace origin, and the app's account panel shows
the identity for the host the workspace actually syncs with. Sharing remains
github.com-only for now.
