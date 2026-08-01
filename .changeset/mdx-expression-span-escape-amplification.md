---
"@inkeep/open-knowledge": patch
---

Prose containing a brace expression — an MDX comment like `before {/* note */} after`, or any `{…}` span with a `*`, `_`, `~` or an HTML entity inside it — no longer accumulates backslashes. The serializer was escaping the inside of those spans as if they were ordinary prose, but the parser reads a matched brace pair as an opaque expression and never removes the escape, so each backslash was escaped again on the next pass: one delimiter went from `\*` to three backslashes, then seven, then fifteen, doubling forever. Because every mode toggle, reload, remote refresh and agent write re-derives the document, a paragraph could grow without anyone editing it. Those spans are now written out exactly as typed and are byte-stable from the first save. Documents that already picked up extra backslashes stop growing; their existing bytes are left alone rather than rewritten.
