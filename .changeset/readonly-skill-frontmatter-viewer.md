---
"@inkeep/open-knowledge": patch
---

Show a read-only Properties panel when viewing a read-only skill file's markdown
(for example the built-in `open-knowledge` skill's SKILL.md). Previously the
frontmatter was stripped and hidden in the read-only viewer, so a managed skill's
`name`, `description`, and other metadata were invisible; the editable skill panel
already showed them. The read-only viewer now renders the same "Properties"
section above the body, in read-only mode.
