---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-desktop": patch
---

Fix opening Markdown files from Windows Explorer with Open With or double-click. File paths now reach the single-file open flow on cold launch and when OpenKnowledge is already running, without restoring an unrelated project on cold launch. Preserve literal percent signs and escape-like text in file, project, document, and folder names in deep links. Files with a detected enclosing project open in that project's window. Loose files open in standalone windows, which no longer restore or overwrite a sibling file's project tab session.

Previously saved project tabs are preserved. If an older version saved standalone-file tabs for a folder, those tabs may still appear when opening that folder as a project. Close unwanted tabs to save the updated project layout.

Existing Windows installer behavior can make OpenKnowledge the default opener for `.md` and `.mdx` files when you have not explicitly chosen a default in Windows. To choose another app, use Settings → Apps → Default apps.
