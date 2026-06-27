---
"@inkeep/open-knowledge": patch
---

Configure a custom OpenAI-compatible embeddings endpoint from Settings → This project → Search instead of editing config files by hand. The semantic-search settings now expose the embeddings base URL directly, and the account copy plus `ok embeddings set-key` messaging now describe the key as belonging to the configured embeddings provider rather than only to OpenAI.
