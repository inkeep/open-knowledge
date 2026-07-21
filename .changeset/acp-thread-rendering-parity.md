---
'@inkeep/open-knowledge': patch
---

Agent threads now render what the agent actually does. OK implements the ACP terminal surface, so agents can run commands through it and the transcript shows each command with its live output and exit code. Tool-call diffs are genuine line diffs (unchanged lines collapse) instead of full before/after dumps. A permission prompt that parks a turn now surfaces as an "awaiting approval" thread status in the tab strip, every prompt has an explicit Deny, and resolved prompts summarize as approved or denied by what was actually chosen. The composer footer shows the agent's reported context usage, and tool calls display their raw input.
