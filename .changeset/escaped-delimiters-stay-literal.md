---
'@inkeep/open-knowledge': patch
---

Backslash-escaped `==`, `$`, `%%` and `<!--` no longer turn into formatting.

Writing `\==not a highlight\==` now leaves the text exactly as typed, and the same holds for escaped inline math (`\$5\$`), escaped comments (`\%\%note\%\%`) and escaped HTML comments (`\<!-- note -->`). Escaping either delimiter is enough. Previously OK recognized these constructs after the markdown parser had already consumed the backslash, so an escaped pair still formatted, and saving the document deleted the backslashes from disk. Both the formatting and the byte loss are fixed: an escaped pair now round-trips unchanged in paragraphs, headings, table cells, the first line of a list item or blockquote, and for the `%%` and `<!-- -->` block fences themselves.

Three shapes are not covered yet and still lose their backslashes: an escaped pair written on a *continuation* line of a list item or blockquote (the line without the `-` or `>` marker), an escaped pair that follows an already-highlighted `==a **b** c==` span in the same paragraph, and an escaped autolink (`\<https://example.com>`, which still becomes a link). The autolink case is the same shape of problem in a different recognizer, and suppressing it needs a matching change to how the serializer escapes `:`, so it is handled separately.

Unescaped `==text==`, `$x$`, `%%note%%`, `<!-- note -->` and `~~text~~` behave exactly as before. An inline code span (`` `==x==` ``) is still the form to reach for when the text should read as code; backslash escapes are for keeping a literal pair in running prose.

The `palette` tool and the project skill now say which delimiters are live in ordinary prose and how to suppress them, so an agent authoring `Cost $5$ each` or a sentence containing `%%` is no longer surprised by silent math or silently hidden text.
