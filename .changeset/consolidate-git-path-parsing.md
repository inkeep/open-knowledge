---
"@inkeep/open-knowledge": patch
---

Fix git rename detection for non-ASCII filenames in two more places. A shared doc or folder whose name contains non-ASCII characters (umlauts, accents, CJK) that is renamed on the remote now reports its correct new location instead of showing as deleted, and version-timeline entries recover the real document name instead of garbled text. All git path-listing now routes through a single NUL-safe helper (`git-paths.ts`) so this class of bug cannot recur at new call sites.
