---
"@inkeep/open-knowledge": patch
---

The "Connected, but your edits aren't reaching the server yet" warning is gone, and the state it was trying to describe is now reported honestly.

That notice made three claims a user could not act on. It said edits were not reaching the server, when they were. It told you to restart the server, which re-armed the same notice on the newly booted server's own startup window. And it had no way out: it stayed on screen indefinitely, and closing it only made it come back.

Underneath it, the app was reading a state that lasts milliseconds in normal use — the moment between a socket reconnecting and the document confirming it is in sync — and reporting it the instant it appeared. So an ordinary reconnect flashed a warning about lost edits, and if the confirmation was ever missed, the warning stayed up for the rest of the session.

Now:

- **A normal reconnect is silent.** The app waits out a grace period before saying anything, so the handshake no longer produces a warning at all.
- **When it does speak up, it tells the truth.** "Sync is taking longer than usual, your changes are safe on this device." No claim of lost work, and no instruction to restart. The Restart button is still there for anyone who wants it; it is offered rather than prescribed.
- **It stays up while it is true, and goes away when it stops being true.** The notice is retired by the reconnect itself rather than by a timer, so it neither lingers after sync completes nor falls silent while sync is still stuck.
- **Closing it closes it.** Dismissing this notice retires it for the rest of the outage instead of having it reappear. Dismissing it does not suppress worse news: if the server then stops responding altogether, you are still told.

Genuine outages are unchanged: "Connection lost" and "The server stopped" still stay on screen for as long as they are true.
