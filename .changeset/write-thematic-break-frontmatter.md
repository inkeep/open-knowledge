---
"@inkeep/open-knowledge": patch
---

Agents can write `---` again. A body-level `---` (a thematic break, or a section an agent separated with rules) was being mistaken for a frontmatter fence in two places: `edit` refused any find containing `---` or a `key: value` line before it even read the document, and `write` with `position: "append"` / `"prepend"` partitioned a leading `---` span off the payload and then rejected the whole write when that span was not parseable YAML. Both refusals pushed agents into a full-document rewrite, which clobbers whatever a concurrent writer had put in the rest of the file. `edit` now decides purely on where the match lands, so a `---` or `key: value` find in the body applies normally and only a match inside the frontmatter region is refused; append/prepend only treat a leading `---` block as frontmatter when it parses as a YAML mapping, and otherwise write it through verbatim as the body text it is.

One narrow case stays refused, now with an error that names the fix: a `---` fence pair that would land at byte 0 of a document with no frontmatter. There the composed bytes re-read as a frontmatter block, so the content would vanish from the rendered document and could not be edited back. All three write positions agree on refusing it, and the message points at the workarounds (a leading blank line, or `***` / `___` for the thematic break).
