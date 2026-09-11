---
"@inkeep/open-knowledge": minor
"@inkeep/open-knowledge-app": minor
---

Show "By meaning" in the omnibar for a keyless loopback embeddings endpoint.

With semantic search enabled and the endpoint set to a loopback address (`localhost`, `127.0.0.1`, or `[::1]`), OpenKnowledge already treats a missing API key as "not required": the connection test passes, `ok embeddings status` reports the key as not required, and the server embeds without an `Authorization` header. The omnibar ignored that and only offered "By meaning" once a key was stored, so the search never fired and, because indexing starts on the first "By meaning" search, the corpus never embedded either. Adding a placeholder key was the only way to unblock it.

The omnibar now offers "By meaning" whenever semantic search is enabled and either a key is stored or the endpoint does not need one. Semantic search responses distinguish indexing, no match, a short query, an incapable configuration, retryable provider failures, and repeated vector-size drift that requires restarting OpenKnowledge. An endpoint that ignores explicitly configured dimensions now stops with a Settings remedy instead of looking perpetually unfinished. Indexing keeps the coverage banner and polling active, a completed search with no vector match shows no results, retryable provider failures show retry and pause coverage polling, and terminal vector-size drift shows its restart remedy without offering a retry. A transient status-probe failure retains the last known capability and retries automatically, while a malformed response uses a generic retry state without arming the status poller. Non-loopback endpoints without a stored key are unchanged: the pill stays hidden and the connection test still reports a missing key.
