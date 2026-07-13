---
"@inkeep/open-knowledge": patch
---

Add `ok embeddings set-url <url>` / `ok embeddings clear-url` to configure the semantic-search embeddings endpoint from the CLI (for headless / CI users), and validate the endpoint URL inline in **Settings → This project → Search**. Both the CLI and the Settings field now reject a guaranteed-to-fail endpoint at entry — a malformed URL, or a plaintext `http://` host other than localhost — using the same rule the server enforces before it will send the API key, instead of letting a bad value degrade silently to lexical search later.
