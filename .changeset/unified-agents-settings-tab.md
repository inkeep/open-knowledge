---
"@inkeep/open-knowledge": minor
---

Settings now has one **Agents** page instead of two. "Configure agents" and "AI tools" each told you half the story: one showed which agents appear in your menus, the other showed which ones OpenKnowledge had wired up to read your documents. A switch could be on while the agent could not read anything, and nothing on either page said so. The merged page puts both facts on one row, so an agent that is listed and an agent that works are no longer different questions asked in different places. Old links and searches for either name still land here.

Each row now says whether OpenKnowledge can reach that agent's tools, and offers the one action that makes sense: **Add MCP & skill** when nothing is set up, **Manage** when something is, **Remove** when files are on disk for a tool you have turned off, and **Install** when the tool itself is missing and we know where to get it. Where we do not, the row falls back to a **How to set up** link. Only one line appears under a row: a tool you do not have reads "Not installed" and stops there, rather than also reporting on config it has no use for.

A row never claims more than it knows. When OpenKnowledge cannot verify a tool's setup it shows no status rather than guessing, and if the whole install-state read fails, only the connection column degrades — every group still renders, every switch still works, and the message is retryable. A switch for a tool that is not installed is inert, since turning it on would promise a menu entry nothing can serve; one you had already turned on stays live so the choice can still be undone.

Two long-standing messages are fixed. Removing a setup whose file another agent shares now names that agent and the file and offers to remove it for both, instead of reporting "Something went wrong. Please try again." And a note about an entry OpenKnowledge did not write, or one that changed after it did, now says which file it means and what turning it on would do, and it is the only mark on that row. Previously the amber triangle stood beside the ordinary information icon, so an entry needing attention showed two marks and read as two separate problems.

Pi, OpenClaw and Hermes gain connection rows, since each needs an MCP entry with no fallback. Claude Desktop keeps both of its rows, now told apart by name: the one that opens the app stays **Claude Desktop**, and the one that configures the chat client's own MCP file reads **Claude Desktop (chat)**. They point at genuinely different files, so both have to exist.
