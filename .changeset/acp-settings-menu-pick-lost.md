---
"@inkeep/open-knowledge": patch
---

Picking a value in an agent thread's settings menu now applies. Choosing a model, permission mode, or reasoning effort from one of the menu's submenus closed the submenu and jumped focus to the message field without ever sending the change to the agent, so the setting silently stayed where it was. The composer card focuses its message field when you press its whitespace; because React delivers a portaled menu's events through the component that opened it, that handler was also claiming presses inside the menu. It now acts only on presses that land in the card itself.
