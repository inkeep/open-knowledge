---
'@inkeep/open-knowledge': minor
---

Comment on mermaid diagrams, math, images, wiki links, and tags.

Commenting on ordinary prose failed with "The quoted passage is not in the document" whenever the paragraph merely contained a highlight, an image, a wiki link, a tag, inline math, a footnote marker, an underline, or an autolink. In a wiki-style document that is most paragraphs, not an edge case, so a comment on a normal sentence often just produced an error and was lost. Each of those constructs spends characters on markup that renders as less than it spells, and the anchor matcher only knew how to look past some of them. It now looks past all of them, including an aliased wiki link's hidden target and a link's heading fragment.
