---
"@inkeep/open-knowledge": patch
---

When an agent asks to run a shell command, the permission gate in the **Agents panel** now shows the command it is asking you to approve, for agents that send the command with the request (Claude Code and Codex both do). Before, the gate showed only the agent's one-line description of what it wanted to do, while the command was truncated in the row above and the full text sat in a collapsed `Input` block as JSON. Approving meant trusting a sentence the agent wrote about itself.

The command is read from the permission request itself, so it shows even when the request arrives before the tool call it gates, and it cannot change while the gate waits for your answer. A one-line command is laid out one statement per line: a `;`, `&&` or `||` ends a line and a long pipeline continues on an indented one, without splitting inside quotes, `$( )`, backticks, `${ }`, escapes or comments. A command that already spans several lines, such as a heredoc, is shown exactly as written. A long command scrolls inside the gate rather than being cut short, and hidden characters such as bidirectional overrides or zero-width spaces are shown as `⟨U+…⟩` codes with a warning.
