---
"@inkeep/open-knowledge": patch
---

In-app Claude, Codex, and other `npx`-distributed agents no longer start under an obsolete Node.js inherited by the desktop app. OpenKnowledge now requires Node.js 22 or newer for these adapters, retries with the compatible runtime from the user's login shell when available, and otherwise offers its private managed Node.js runtime before the agent starts.
