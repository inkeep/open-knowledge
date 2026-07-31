---
"@inkeep/open-knowledge": patch
---

The agent composer now shows one action button instead of Stop and Send at the same time. While the agent is working the button is Stop; as soon as you start typing it becomes Send, and your message queues behind the current turn the way it always has. This matches how other agent chats behave and keeps a single clear action in the corner of the composer. Because Stop is hidden while you have a draft, pressing Escape in the composer now stops the agent, and your draft is kept so you can still queue it. Hovering Stop shows the shortcut. A stop that hasn't taken effect yet keeps showing its spinner even if you keep typing, so you can always tell whether the agent heard you.
