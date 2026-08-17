---
"@inkeep/open-knowledge": patch
---

The new-file keyboard shortcut now skips the dialog when there is nothing to ask. With no template resolved for the folder you're creating in, the only field left was a name you were about to retype in the editor anyway, so the shortcut creates an `untitled` doc (then `untitled-2`, `untitled-3`, …) and opens it straight away. Add a template for the folder and the dialog comes back, because now there's a real choice to make. The New file dialog itself also drops the "Start from" picker entirely when no templates resolve, instead of showing an empty picker plus a hint — that applies to every surface that still opens it (file tree, command palette, folder overview).
