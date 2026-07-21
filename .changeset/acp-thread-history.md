---
"@inkeep/open-knowledge": minor
---

Agent conversations are now saved and resumable. Every agent thread's transcript is persisted on disk as it streams (under the project's machine-local `.ok/local/threads/` — never committed, never shared), so closing a tab, an idle cleanup, or a server restart no longer destroys the conversation.

A history menu in the thread dock lists past conversations (newest first); opening one shows the full transcript — messages, tool calls with diffs, permission decisions — with no agent process running. Closing a tab now always archives (the X is never destructive); permanent delete lives in the history menu behind a confirm.

Type to resume: sending a message into an archived conversation respawns the agent and continues the same session where the agent supports it — via ACP `session/resume` when available (no history replay needed, since OpenKnowledge keeps its own transcript), falling back to `session/load` with the protocol's replay de-duplicated. Agents that can't resume (or whose session has expired on their side — Claude, for example, cleans its own sessions up after 30 days) keep the transcript intact and offer a one-click "New thread with this agent" instead. Document-edit attribution, write-flash, and per-session undo stay continuous across a resume.
