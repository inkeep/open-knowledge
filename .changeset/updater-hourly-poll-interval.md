---
"@inkeep/open-knowledge": patch
---

The desktop app now checks for updates hourly instead of every 5 minutes. The
5-minute cadence was a temporary pre-release setting; hourly matches the
steady-state interval comparable apps use.

It also keeps the beta update channel well within GitHub's API rate limits. The
beta channel resolves the newest build through a docs-site proxy that calls
GitHub's unauthenticated releases API on a budget shared across the whole
install base (keyed on the proxy's IP, not each client's), so how often clients
poll feeds straight into that one budget. Hourly, with a wider jitter window to
break fleet lockstep, keeps it comfortable. Stable is unaffected either way, as
it resolves through GitHub's own "latest release" redirect with no API call.

An automatic update may now be noticed up to about an hour later than before.
Auto-download and install-on-quit are unchanged, and "Check for Updates" still
forces an immediate check on demand.
