---
"@inkeep/open-knowledge": patch
---

The agent-thread composer now recognizes slash commands. Typing `/` at the start of a message opens a searchable, keyboard-navigable picker of the commands the agent advertises over ACP; a recognized `/command` renders as a highlighted token while an unrecognized one gets a dashed underline and a hint explaining it will be sent as plain text. Agents that advertise no commands say so honestly — the picker never implies support that isn't there. Each agent is also now told, at the start of every new session, that it is running inside OpenKnowledge over ACP rather than in its own terminal app, which reduces confident recommendations of host-only features (like Claude's `/tasks` or `Ctrl+O`) that don't exist here.
