---
"@inkeep/open-knowledge": patch
---

You can now queue messages to an in-app agent while it's still working. Sending mid-turn no longer fails with "a turn is already running" — the message joins a queue and is sent automatically as soon as the current turn ends, in the order you wrote them. Queued messages appear between the transcript and the composer, where each one can be edited in place or removed before it runs. Stopping the agent clears the queue, and it's never saved to disk, so a crash mid-turn can't resurrect messages you never sent. Up to 20 messages can be queued at once.
