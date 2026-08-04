---
"@inkeep/open-knowledge": patch
---

Blank lines at the very top or bottom of a document now stay in sync between the visual editor and markdown source in both directions. Previously they only propagated when added in the visual editor: blank lines typed in source mode (or arriving from disk or an agent) never appeared in any collaborator's visual editor, deleting them in source mode left phantom blank paragraphs behind, and deleting them in the visual editor never reached the file. On frontmatter-bearing documents, blank lines added above the first paragraph now survive too, with the separator line below the frontmatter kept intact. This also fixes a lock-up where a document whose two representations disagreed about an edge blank line would silently stop showing source-mode edits in the visual editor and revert visual-editor deletions.
