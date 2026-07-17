---
"@inkeep/open-knowledge": patch
---

Fix a stray backslash appearing at the end of lines after a hard break

A hard break (Shift+Enter) at the end of a paragraph serialized to a trailing `\` in the markdown source, which users saw as an unexpected character at the end of a line. Worse, deleting it did not stick: the WYSIWYG fragment kept the break node, so the next sync re-emitted the `\` (a fragment/source round-trip that never settled, hidden from the invariant watchdog by parse-equivalence tolerance). A trailing hard break has no CommonMark meaning — a backslash form decays to a literal backslash on the next parse and a two-space form is stripped — so it is now dropped at serialize time. Mid-paragraph hard breaks, source-authored breaks, void `<br>` breaks, and literal backslashes in text are all unaffected and still round-trip byte-for-byte.
