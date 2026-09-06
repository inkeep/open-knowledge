---
"@inkeep/open-knowledge": patch
---

Typing after a blank first line no longer swallows a character, and blank lines above the first paragraph are saved.

In an empty document, pressing Return, typing `go`, pressing Return and typing `go` again left a single paragraph reading `goo` — both blank lines gone and one `g` with them. The visual editor can hold a blank line that markdown has no way to spell: a source beginning with a single newline always reads back as no blank line at all. When that happened the block table stopped matching the document, and the very next keystroke was refused and thrown away, taking the paragraph break with it. Blank lines the source *can* spell were never at risk, and neither was anything already saved to disk.

Blank lines that markdown cannot represent are now held rather than dropped from the table, so no keystroke is lost and paragraphs stay separate. Blank lines above the first paragraph are written out when there are two or more of them, and survive a mode switch and a reload; a lone one is still held, because there is no sequence of bytes that means it.
