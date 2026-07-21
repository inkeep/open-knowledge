---
"@inkeep/open-knowledge": patch
---

Every `/api/*` response now carries an `x-request-id` correlation header — a well-formed incoming `x-request-id` is honored, anything else gets a minted UUID — and the server emits one structured `api.access` log line per API request (method, route template, status, duration) to the on-disk log for bug-report bundles. The same ID lands on the request trace span, so a client-reported ID joins against both the logs and the trace. Verb-dispatch and error-tail plumbing inside the HTTP API was consolidated into shared helpers with no wire-shape changes.
