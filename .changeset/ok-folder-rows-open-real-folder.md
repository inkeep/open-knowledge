---
"@inkeep/open-knowledge": patch
---

With "Show .ok folders" turned on in the sidebar, clicking `.ok` or one of its subfolders such as `templates` no longer opens an error tab reading "This file could not be found" for a name like `templates.md`. Those rows are folders, but OpenKnowledge was reading the folder path as the name of a missing file, and the bad tab came back on its own every time the file list refreshed.

The `.ok` folder view still lists no documents of its own, because `.ok` contents stay out of the file index.
