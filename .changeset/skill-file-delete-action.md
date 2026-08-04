---
'@inkeep/open-knowledge': patch
---

Add a Delete action, with a confirmation dialog, to skill bundle files. It shows up wherever a skill file's actions do: the Skills sidebar row and the file's editor tab. Deleting closes the file's open tab and reports a miss instead of a silent success when the file is already gone.

Editable `.md` reference tabs previously carried no skill-file actions at all; they now offer the same Rename, Reveal in Finder, Copy Path and Delete set as the sidebar row for that file.

Also fixes a pre-existing hazard in `DELETE /api/skill-file`: the live-doc teardown for a project `.md` reference ran before the file's existence was known. Because bundle doc names are extension-less, deleting a path that was not on disk tore down the live doc of a same-stem sibling (`references/x.md` vs `references/x.mdx`) that survived the no-op unlink.
