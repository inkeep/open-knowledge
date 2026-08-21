---
"@inkeep/open-knowledge": minor
---

Agent threads now deliver Open Knowledge tools more reliably across ACP agents, and pi gets them for the first time.

- pi agent threads: Open Knowledge has always integrated with pi through its extension system rather than MCP. Starting a pi thread in a project that isn't wired yet now offers a one-tap consent card that installs the bridge extension and marks the project trusted in pi. The card spells out what approving commits you to — pi folder trust covers every extension in the folder, not only Open Knowledge's, and it names any other extensions already there — and both the extension and the trust entry stay until you remove Open Knowledge from the project, which now also revokes the trust entry. Declining leaves the thread fully usable without Open Knowledge tools; reopening that thread won't re-ask, but the next pi thread will.
- Cursor agent threads in a wired project got no Open Knowledge tools at all: Cursor requires separate approval for a configured MCP server, so a configured entry there is not a loaded one, and Open Knowledge was standing down on the assumption that it was. It now always injects for Cursor.
- The MCP server entry handed to agents over stdio now uses an absolute command path and carries the same `PATH` the agent itself was launched with, fixing silent tool absence under agents that launch MCP servers with a stripped environment, or when the app was started from the Dock with a minimal `PATH`.
- Threads whose agent ends up with no Open Knowledge tool transport at all now log a warning instead of failing silently, and the server records which delivery channel each session's injection landed on.
