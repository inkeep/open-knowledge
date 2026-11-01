---
"@inkeep/open-knowledge": minor
---

Embedding API keys now use the OS credential store when available, with a restricted file fallback. Existing keys migrate on access or with `ok embeddings migrate-keys`; older versions cannot read migrated keys.
