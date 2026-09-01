---
"@inkeep/open-knowledge": patch
---

The sync indicator recovers after a sleep, a Wi-Fi change, or a VPN flap.

When a laptop sleeps or the network switches underneath you, the socket to the local server can die without the operating system ever reporting it closed. Open Knowledge notices the silence and reconnects on its own, and every edit made after that really was reaching the server. What did not recover was the claim about it: the status stayed short of "synced" for the rest of the session, and the "your edits aren't reaching the server" warning stayed on screen with no way to dismiss it. The only way out was to close and reopen the window.

Both now clear as soon as the reconnect finishes. The warning is replaced by "Reconnected", which fades on its own, and the indicator returns to synced.

Two quieter consequences of the same stuck state are fixed with it. Returning to a background tab flushes pending edits again rather than skipping the document, and reopening a document keeps the connection that was already working instead of tearing it down and building a new one.

One behaviour to expect: a document that is still opening when the connection resets now shows "Connection dropped" with a Retry button, the same as any other dropped connection, instead of waiting in silence.
