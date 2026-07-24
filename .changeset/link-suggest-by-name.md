---
"@inkeep/open-knowledge": patch
---

Link-target suggestions now match by name as you type, like the command palette.

When editing a link target (the "Edit markdown link" dialog, the wiki-link panel, and the bubble-menu link popover all share the same field), typing a bare page name such as `install` now opens the suggestion dropdown and surfaces the matching page — a leading `/` is no longer required. Typing or pasting an external URL, or a bare `#anchor`, still does not pop a page list. The empty/browse list also keeps real content pages ahead of dot-directory files (`.github/`, `.changeset/`) so they no longer fill the list on projects rooted at a repository.
