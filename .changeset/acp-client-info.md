---
"@inkeep/open-knowledge": patch
---

In-app agents now know they're talking to Open Knowledge. The ACP handshake identifies the app by name and version (the protocol's `clientInfo` field), so agents can show which client is driving them, cross-implementation debugging gets version context, and Open Knowledge is counted correctly in ACP ecosystem usage metrics instead of appearing as an anonymous client.
