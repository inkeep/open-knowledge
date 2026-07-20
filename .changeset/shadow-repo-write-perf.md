---
"@inkeep/open-knowledge": patch
---

Version-history recording is dramatically cheaper on large knowledge bases and slow (mounted/network) volumes. The background history snapshot now reuses a persistent git index so unchanged files are no longer re-read and re-hashed on every save cycle (up to ~11x faster tree builds on a 10k-file KB); switching git branches with many open documents batches its bookkeeping into a few git calls instead of four per document (a 100-document switch drops from ~15s to well under a second); and agent writes coalesce into the normal debounced history commit instead of forcing a full commit per write, while history reads still always reflect every completed write.
