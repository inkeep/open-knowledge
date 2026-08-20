---
"@inkeep/open-knowledge": patch
---

Dropping files the ACP composer can't attach — because they live outside the workspace on the desktop, or because the browser can't recover the file's on-disk path on the web — no longer fires one red error toast per file. In-workspace files still attach; the rest are skipped quietly with a single muted notice above the composer that names the count and the reason (outside workspace vs. no browser path).
