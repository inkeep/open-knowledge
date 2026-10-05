---
"@inkeep/open-knowledge": minor
"@inkeep/open-knowledge-app": minor
"@inkeep/open-knowledge-core": minor
"@inkeep/open-knowledge-server": minor
---

Store an access token for any git host with `ok auth token --host <host> --username <username>` or from Settings → Git. `ok auth status` reports it without contacting GitHub. While OpenKnowledge runs, sync uses a stored token ahead of credentials git saved elsewhere for that host.
