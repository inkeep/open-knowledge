---
"@inkeep/open-knowledge": patch
---

Agent connections no longer offers an agent options it does not have.

Every agent's Configure dialog showed the same four checkboxes — project and global MCP server, project and discovery skill — with the ones an agent has no surface for greyed out. Pi has no machine-wide MCP config at all, so its global row could never be ticked; Claude Desktop, Hermes, OpenClaw and Antigravity have no project-scope surface of any kind, so their whole **This project** group was two dead rows under a live heading. A disabled control reads as something OpenKnowledge failed to set up, which sent people looking for a fix that does not exist.

Those rows are gone now, and a group with nothing left in it drops its heading rather than standing empty. An option that genuinely exists but cannot be written right now still shows, disabled, with the reason — an entry OpenKnowledge did not author, a host with no scriptable installer, an agent that is not on this machine. That distinction is the point: nothing to offer and cannot act are different answers and now look different.
