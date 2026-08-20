---
"@inkeep/open-knowledge": patch
---

Percent-encoded links now resolve to the document they name. A link like `./Agent%20Memory.md` (the form the generated `index.md` emits, and the standard GitHub/Obsidian spelling for names with spaces, parentheses, `#`, `&`, or non-ASCII characters) used to resolve to a phantom document containing the raw escapes, so the Problems panel flagged it `dead-link`, the graph lost the backlink, and clicking it offered to create a new page. The canonical resolvers now decode each path segment per RFC 3986 before path resolution, so lint, graph, navigation, rename rewriting, and asset links all agree with the file on disk. Escapes stay data: `%2F` and `%5C` never become a path separator or a `..` traversal, malformed escapes are kept as literal bytes, and `[[wiki]]` targets remain verbatim.

Renaming or moving a document also re-encodes the links it rewrites. Because the resolvers now decode, a rename matches percent-encoded links for the first time, so the rewriters emit the encoded form rather than a raw name. A document or asset whose name carries a space, `#`, `?`, or a parenthesis keeps a link that still parses after the rename.
