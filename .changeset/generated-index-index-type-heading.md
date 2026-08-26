---
'@inkeep/open-knowledge': patch
---

Generated `index.md` files no longer produce a markdownlint MD024 warning when two of a folder's headings reduce to the same text under MD024's own comparison, which drops inline HTML and an ATX closing sequence. The generator titles every index `# Index`, so a document whose frontmatter `type` is `Index` produced a second `## Index` heading with the same content. Projects that had enabled both the `markdownlint` and `okf` plugins along with `okf.generate.index` saw the duplicate flagged in `ok lint`, in the Problems panel, and in inline diagnostics. All three are off by default, so a project using the defaults was never affected.

A document typed `Index` is now listed directly under the index's own title with no `##` heading of its own. That differs from a document typed `Subdirectories`, which keeps its visible section.

The same merge applies between two ordinary types, so a project that has never used `type: Index` can still see a change. `Flow` beside `Flow #`, and two types that render to no text at all, each now share a single section. Its heading is one of the colliding `type` strings, chosen deterministically rather than by file order, so a folder holding both `Flow` and `Flow #` lists everything under one of the two. Headings the generator owns, meaning `Index`, `Other` and `Subdirectories`, keep their own spelling when a `type` collides with them.

One further case merges that markdownlint itself would not flag. Two Unicode spellings of the same grapheme cluster, which look identical in an editor, are treated as one heading. That is the generator normalizing beyond the rule, so that the file it rewrites settles to stable bytes instead of changing with the order the folder is read in.

Every document and every subdirectory link still appears, and indexes in affected folders are rewritten once on the next regeneration.
