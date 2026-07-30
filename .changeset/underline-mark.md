---
'@inkeep/open-knowledge': minor
---

Underline is now a real, savable format. The bubble-menu Underline button and Cmd+U have always been there, but nothing wrote the result to disk: the underline vanished the moment the document was saved, reloaded, or opened by a teammate. Underlined text pasted in from Word arrived as italic instead.

| Before | After |
| --- | --- |
| Cmd+U, reload the page — underline gone | Cmd+U, reload the page — still underlined |
| Paste underlined text from Word — comes in italic | Comes in underlined |
| Paste underlined text from Joplin or Logseq — formatting dropped | Comes in underlined |

Underline is written as `<u>text</u>`, the same thing Typora, MarkText and Obsidian write, so files stay readable and portable. Documents that already spell it `<ins>text</ins>` — what Joplin and Logseq produce — are read as underline too and keep that spelling when saved, so importing a vault does not rewrite it under you.

Worth knowing: markdown has no underline of its own, so this is HTML inside your file. It renders as underline in OpenKnowledge, in a published site, and when pasted into Word, Docs or Gmail. GitHub is the exception — it strips `<u>`, so the text shows up unformatted there. Files that use `<ins>` do keep their underline on GitHub.

Underline can be combined with bold, italic, strikethrough and inline code on the same text.
