---
"@inkeep/open-knowledge": patch
---

Opening the Agents panel with no conversations in it now starts one for you, using the same agent the New button leads with — so a conversation is open and waiting instead of an empty panel. If no agent is available the panel simply stays empty; a passive reveal never pops open Configure agents.

Starting an agent without naming one now leads with the same agent every picker already shows, rather than only a previously saved choice. This mattered most on a cold start: while the agent list was still loading, "Start an agent" used to send you to Configure agents and leave you there even once an agent became available, and revealing the panel in that window left it empty for good. Both now wait for the agent list and then do what you asked.
