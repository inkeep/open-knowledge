---
"@inkeep/open-knowledge": minor
---

Follow mode now scrolls to where the agent is writing and flashes the exact text it changed. When you're following an agent (the thread's Follow toggle, on by default) and it writes the document you're viewing, the editor scrolls the changed region into view and briefly highlights it — so a section the agent appends to the bottom of a long document pulls the viewport down to it and lights up, instead of the change happening off-screen. The highlight targets only the bytes that actually changed (diffed from before/after), so a full-document rewrite that only appends a section flashes just that section, not the whole page. In-app agent-thread writes now drive the same write-flash the MCP agent writes always have.
