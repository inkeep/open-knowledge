---
"@inkeep/open-knowledge": patch
---

Renaming a file in the Files sidebar no longer doubles its markdown extension. The rename box hands you the whole filename with only the name part selected, so typing or pasting a name that already ends in `.md` left the original `.md` in place and committed `notes.md.md`. That produced two files for one document: `notes.md.md` is filed under the document name `notes.md`, which resolves back to a different file, so the next save wrote the same document out again as a plain `notes.md` beside it. Both names also land on one row in the sidebar, so only one of the two files was visible there. A typed `.md` or `.mdx` now replaces the retained one instead of stacking on it. Names that merely contain dots (`v1.2.md`, `report.2026.md`) and non-document files are untouched. This stops new doubled names from being created; `.md.md` and `.mdx.mdx` files already on disk are left alone and still need renaming by hand.
