---
"@inkeep/open-knowledge": patch
---

Files whose name carries a doubled markdown extension now get their own row in the Files sidebar. A `notes.md.md` sitting next to a real `notes.md` resolved to the same sidebar path as its neighbour, and the sidebar kept only the first of the two, so the other file had no row, no badge, and no warning even though it was still on disk and still reachable everywhere else. Each file now appears under its real name, so a stray doubled extension is visible and can be renamed or deleted. Same-name `.md` and `.mdx` pairs are unchanged, since those already resolved to separate rows.
