---
"@inkeep/open-knowledge": patch
---

The agent thread composer no longer carries an add-context `+`. It opened a one-row menu whose only row was the comment queue, and that row was inert unless the queue had already loaded and had something in it, so in practice the button opened a menu that could not do anything. Attaching a batch there was also the weaker of the two paths: it folded the comments into your next message but left every thread queued, while the Comments panel's own Send to chat dispatches to the open session and actually closes the review requests. That panel is now the single way to send queued comments to an agent, and the composer's bottom bar is just the agent settings on the left with the context ring and send button on the right.
