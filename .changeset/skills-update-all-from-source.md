---
'@inkeep/open-knowledge': patch
---

Update every skill from one source at once. A provenance group row in the Skills
sidebar now offers "Update all from this source", and reports what actually
happened per skill rather than a bare success — how many updated, how many were
already current, and which ones failed with the reason.

It runs as a single request against the new `POST /api/skills/reimport-bulk`,
which clones each recorded source once for the whole batch instead of re-cloning
per skill. A skill that cannot be written no longer aborts the rest of the batch.
