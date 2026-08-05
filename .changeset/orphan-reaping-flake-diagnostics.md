---
"@inkeep/open-knowledge": patch
---

Internal test diagnostics: when the check that an `ok mcp` server exits after its launching host dies fails on CI, it now reports the server's parent pid and captured stderr instead of a bare assertion. The parent pid is what separates the two ways that check can fail — the process never being reparented at all, versus being reparented and then not finishing shutdown — which previously could not be told apart from the failure output. No change to how OK runs.
