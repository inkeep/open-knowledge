---
"@inkeep/open-knowledge": minor
---

Links in the terminal are now clickable. URLs open in your browser (including explicit OSC 8 hyperlinks from tools like `ls --hyperlink`), and file paths in output — absolute, relative, or with a trailing `:line:col` — become clickable when they point to something inside your project: Markdown documents open in the editor, folders open to their overview, and other files open in the OS default app (revealed in Finder when the type can't be opened directly). Only in-project paths that actually exist are highlighted, so there are no dead links. A file path pointing outside your project asks first with a "this file is outside your project — reveal in Finder?" prompt. Links inside a full-screen terminal app that handles its own clicks (like the Claude TUI) are left to that app, so they open exactly once.
