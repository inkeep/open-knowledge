---
"@inkeep/open-knowledge": patch
---

Markdown comments now work when their body contains formatting, and they read as annotation instead of as punctuation.

A comment written inline in a paragraph, `%%note%%` or `<!-- note -->`, was only recognized when its body was plain text. Put anything formatted inside it, bold, code, a link, and the comment stopped being a comment: the `%%` or `<!--` characters showed up as literal prose and the body rendered at full weight alongside the rest of the sentence, so an annotation read as part of the document. The cause was that formatting splits the surrounding text, which left the opening and closing delimiters too far apart for the recognizer to pair them. It now pairs them across the split, in paragraphs, headings, list items, and table cells alike.

One byte-level consequence, for the HTML form only: a comment written without inner padding re-saves in the conventional `<!-- body -->` shape, the same way a plain-bodied one always has. The `%%` form keeps its body verbatim, spaces included.

Recognition stays deliberately narrow. A paragraph, heading, or table cell carrying more than one candidate pair (its several lines share one budget), an escaped delimiter, a pair inside a code span, or a mid-sentence body that is nothing but a single formatted word is left as prose rather than guessed at, because claiming one of those would rewrite what you wrote the next time the file saved.

The editor no longer prints the delimiters. A comment used to carry a literal `%%` or `<!--` on each side, and a standalone comment block carried a small marker naming it, so a paragraph with a few annotations in it was hard to read past the punctuation. Nothing else in the editor shows its own syntax: bold, code, and links all keep theirs out of the page. Comments now do the same. An inline comment is dimmed and italic under a dashed underline; a comment block is dimmed with a dashed left rail, which is what distinguishes it from a blockquote's solid one. The underline matters beyond decoration: without it a comment differed from ordinary emphasis by colour alone, and a reader who could not resolve that difference could publish text they meant to hide. The text itself is never hidden, because the same syntax can appear in prose you never meant as a comment. Source mode still shows the raw bytes, and that is where the delimiters are edited.

On the choice to stop drawing them: Obsidian, whose `%%` syntax this is, does show the markers in its Live Preview — comments are the one exception to that mode's hide-the-syntax rule, and its users routinely add CSS to hide them. Obsidian reveals syntax near the cursor, which OpenKnowledge's block-canonical editing surface cannot replicate; a cursor-proximity reveal was tried here and set aside as too fidgety, so it is a not-now rather than a never. Reading views in both tools hide comments entirely.

A related fix rides along in the `==highlight==` recognizer, which had the same defect: a highlight whose body contained formatting dropped backslash escapes from the prose around it, and an escaped `\==` pair following one was claimed anyway. Both now hold.

Readers were never affected: wherever a document renders to HTML rather than to the editor, both forms come out as real HTML comments, which browsers do not display.
