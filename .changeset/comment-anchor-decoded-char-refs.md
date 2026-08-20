---
"@inkeep/open-knowledge": patch
---

Fix comments being refused on any passage containing a boundary-whitespace character reference

Selecting text and adding a comment failed with "The quoted passage is not in the document" whenever the selection crossed a space typed just inside bold, italic, or strikethrough, or a space-indented line. The passage matcher treated markdown syntax as elastic but did not know that the display pipeline decodes a narrow set of numeric character references — `&#x20;`, `&#x9;`, `&#xA0;` — which the byte-fidelity serializer mints to hold a phrasing-boundary space across re-parse. Six bytes on disk, one character on screen, and the match broke at the ampersand.

Anchoring now decodes those references on whichever side carries them, in both directions, and context scoring makes the same allowance so a highlight no longer degrades near one. References the pipeline does not decode (`&amp;`, `&nbsp;`, `&hellip;`) still match literally, as they always did.
