---
"@inkeep/open-knowledge": patch
---

A trailing blank line now survives, and one broken JSX tag no longer blanks the whole document.

Two authoring defects, both at the seam between the editor and the markdown it writes.

Pressing Enter at the very end of a document, or clicking the empty zone below the last block, added a paragraph the editor showed but the file never recorded. The blank line came back as soon as the page reloaded, because the reader restores a single trailing blank while the writer refused to spell one. The two now agree, so a trailing blank line is kept, and typing into it still reclaims the line rather than leaving a stray one behind.

Separately, a single mismatched component tag — `<Foo>text</Bar>`, or a stray closing tag — replaced the entire rendered document with a box of raw markdown. Headings, paragraphs and everything else became plain text until the tag was repaired. Only the region the parser actually rejected is boxed now; the rest of the document keeps rendering, and editing it writes exactly the bytes it should, leaving the rejected region untouched. A document whose damage genuinely spans the whole body still falls back whole, as before.
