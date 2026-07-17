---
"@inkeep/open-knowledge": patch
---

The Problems panel gains two new lint actions. A "Fix all" button applies every auto-fixable problem at once — in the "This doc" tab it fixes the open document instantly (undoable, attributed to you), and in the "Project" tab it sweeps every fixable file and refreshes the audit, reporting any files it could not fix. On desktop, each problem row also offers "Ask AI": it composes a grounded fix prompt (document, rule, line, message, and the offending text) and types it into your running agent terminal for review — or launches Claude with it if no terminal is open. Deterministic fixes triggered from the UI are now attributed to you (the principal) rather than to an agent; fixes requested by agents over MCP keep agent attribution.
