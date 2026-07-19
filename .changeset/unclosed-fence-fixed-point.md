---
"@inkeep/open-knowledge": patch
---

Pasting source at the end of a document no longer corrupts or loses content when the paste lands against a code fence or a JSX container's closing tag. A paste that glued onto a closing ``` line used to reopen the fence to the end of the document; the editor's serializer then invented a closing fence the document never had, the collaboration bridge saw permanent divergence between the WYSIWYG and source views, and its repeated repair merges could drop lines from both — in multi-user sessions this surfaced as text vanishing for everyone. Documents that end in an unclosed code fence now round-trip byte-exactly (the fence stays unclosed until you type below it), and content pasted directly under a `</Steps>`-style container close is recognized as equivalent to its canonical blank-line-separated form instead of triggering endless repair cycles.
