---
"@inkeep/open-knowledge": patch
---

Fixed editable code and plain-text files being treated as Markdown. Before, opening a `.csv`, `.json`, or other editable-text file could add a phantom `.md` suffix to tab paths and actions, report Markdownlint and OKF diagnostics for non-Markdown content, and offer the inapplicable Properties control. Now those files retain their real paths and stay outside Markdown-only checks and frontmatter UI. The Problems panel says Markdown checks do not apply, while word, character, and token counts reflect literal file contents instead of Markdown-stripped text.
