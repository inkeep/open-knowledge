---
"@inkeep/open-knowledge": patch
---

Error and warn log lines across the server, CLI, and desktop main process now attach the raw error under the `err` key, so on-disk JSONL logs (what bug-report bundles collect) carry the full name/message/stack instead of a pre-stringified message with no stack. API error log lines additionally carry the request's `x-request-id` for correlation with the access log and client reports, the MCP stdio logger serializes Error values instead of flattening them to `{}`, and the desktop root logger gained explicit `err` serializers. No wire-shape changes.
