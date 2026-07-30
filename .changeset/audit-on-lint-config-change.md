---
"@inkeep/open-knowledge": patch
---

Keep validation state current instead of waiting for each file to be opened. Sidebar highlights and problem counts are now correct when you open a project, when you enable a plugin, when you toggle a rule, and when you switch git branches — previously a file only turned yellow once you clicked into it, switching a rule off left its counts standing, a branch switch kept showing the previous branch's problems, and project-wide state appeared only after visiting Problems → Project. Repeat audits over unchanged files are also much faster, and concurrent audits of the same project are coalesced into one. Audits no longer stall the server while they run: on a large knowledge base a project-wide audit previously blocked saving, search, opening files, and collaboration for its whole duration, and now runs in the background instead.
