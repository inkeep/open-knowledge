---
'@inkeep/open-knowledge': patch
---

Show comment annotations dimmed in the editor instead of hiding them.

Text that looks like comment syntax (`<!-- note -->`, `%%note%%`) is claimed by
the comment promoter the next time a document is re-derived. The resulting
comment mark and comment block rendered `display: none`, so prose a user typed
as ordinary text disappeared from the editor while the bytes on disk stayed
intact, with no way to recover it from the WYSIWYG.

Comments now render dimmed in the editing surface, with the delimiter form shown
alongside the body and a dashed rail plus gutter marker on the block form so it
reads as annotation rather than as a blockquote. The app's read-only views that
mount the editor schema (skill viewer, rendered diff) show comment bodies dimmed
too; only fully rendered markdown output still hides them, as literal HTML
comments. Comments are still dropped from cross-app clipboard payloads, and
bytes are untouched in both directions.

To turn an annotation back into ordinary text, edit the delimiters in source
mode (`Cmd+/`) — backslash-escaping either delimiter (`\%\%`) keeps the run as
prose. There is no WYSIWYG control for this yet.
