---
'@inkeep/open-knowledge': patch
---

Keep beta update checks on the configured proxy after offline errors. Stable update checks now return to the proxy after a one-check GitHub fallback.

A manual update check that hits a proxy failure now reports the result of the GitHub retry rather than the proxy error. Separately, the Check for Updates menu item now reports a timeout instead of hanging indefinitely: on the initial proxy request on both beta and stable, and on the GitHub retry, which only stable performs. If the update server never answers, later manual checks explain that the app must restart before it can check again, and the manual-download hint stays reachable.
