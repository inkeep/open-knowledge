---
'@inkeep/open-knowledge': patch
---

Open Knowledge now checks project-local document, file, and image targets without rewriting authored Markdown. Missing targets appear consistently in write advisories, audits, Problems, Links, and both editor modes, while invalid images keep a visible placeholder that distinguishes a missing file from one that could not be displayed.

The shared target index updates affected references after create, delete, rename, and repair events, fails closed while rebuilding, and retains explicit tolerant-navigation evidence without treating a fallback as a valid authored path.
