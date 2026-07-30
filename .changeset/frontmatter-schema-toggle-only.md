---
'@inkeep/open-knowledge': patch
---

Frontmatter schema settings are now just the on/off toggle.

**The Modified badge and the Reset-to-default button are gone.** Both described the config file rather than the schema: "Modified" meant only "config.yml maps this file", on or off, and Reset removed that mapping. Neither is something you need a model of to decide whether a schema should validate your docs, and in practice the words did the opposite of explaining themselves. Reset in particular read as "refresh", so pressing it to reload the panel silently discarded every glob you had written. The **Only modified** filter went with them, since the concept it filtered on no longer appears anywhere in the surface. Search still narrows the list.

**Your globs are always kept.** Turning a schema off leaves its `appliesTo` patterns in place, so turning it back on restores exactly what you had. The toggle never discards a mapping. If you want a schema out of `config.yml` entirely, edit the file — or delete the schema, which removes the file and its mapping together.

**Shorter delete confirmation.** Deleting a schema no longer adds "Docs it validated keep their frontmatter; they just stop being checked." Nobody expected deleting a schema to rewrite their documents, so the reassurance mostly introduced the doubt it was trying to settle.
