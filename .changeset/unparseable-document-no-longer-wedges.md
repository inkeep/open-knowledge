---
"@inkeep/open-knowledge": patch
---

A document the MDX parser rejects no longer freezes the editor.

A closing tag with no opening tag — `</Callout>` on its own, easy to reach by deleting an opening tag or pasting part of a component — made the whole document stop responding. Edits in the visual editor stopped reaching the markdown source, edits in source mode stopped reaching the visual editor, and reopening the file surfaced `Unexpected closing slash '/' in tag, expected an open tag first`. Nothing was lost — the text stayed in the file the whole time — but the document could not be worked on, including to repair the tag that caused it.

Such a document now opens as a single raw block showing your markdown verbatim, the way an unparseable region has always been shown. Both editing modes keep working, edits keep reaching disk, and the moment you repair the tag the document goes back to rendering normally. The raw block's bytes are preserved exactly, so an edit elsewhere in the file never rewrites them.
