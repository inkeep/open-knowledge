---
"@inkeep/open-knowledge": patch
---

The server now says when it drops a WebSocket upgrade.

An upgrade request that no handler claimed was closed without a word in the log at any verbosity. From the browser that is indistinguishable from the request never arriving, so a connection problem on the client and a routing problem on the server looked identical — and the only way to tell them apart was to reproduce the handshake by hand.

Such a request is now logged at warn with the URL, host, origin and requested subprotocol, and the message says which paths the collaboration host actually claims. Nothing about which connections are accepted has changed.
