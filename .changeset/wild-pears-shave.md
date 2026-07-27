---
'@inkeep/open-knowledge': patch
---

Fix GitHub sign-in failing with "Sign-in stream ended without confirmation" when the connection to the local server blips (#803).

The sign-in stream between the browser and the local OpenKnowledge server sat completely idle from the moment the device code appeared until authorization finished, which is exactly what security software, VPN proxies, and browser tab-backgrounding cut off. Worse, that disconnect terminated the sign-in itself, so authorizing on github.com afterwards stored nothing.

Sign-in now survives those blips: the stream is kept alive with a periodic keepalive, a dropped connection no longer cancels the sign-in in progress, and the app reconnects to pick up a sign-in that completed while it was disconnected. Closing the dialog still cancels immediately. The countdown also shows the code's real expiry (about 15 minutes) instead of claiming it expired after 2.
