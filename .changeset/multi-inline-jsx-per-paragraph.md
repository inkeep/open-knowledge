---
'@inkeep/open-knowledge': patch
---

Fix multiple self-closing MDX JSX tags on the same paragraph collapsing to text. The R23 autolink/void-HTML guard classified any `<X…` as self-closing when the paragraph contained *any* `/>`, so `A <Foo />, B <Bar />, C <Baz />.` promoted every `<` up to the last one and lost the intermediate tags. It now decides self-closing per-tag by scanning that tag's own contents (quote- and brace-aware), skipping `<` characters that fall inside another uppercase tag's attribute region. Orphan uppercase openers stay guarded; quoted `>` / `/>` and `<X>` inside JSX expression braces round-trip cleanly.
