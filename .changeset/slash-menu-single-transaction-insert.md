---
"@inkeep/open-knowledge": patch
---

Stop the slash menu from silently replacing an adjacent image or component on insert.

Picking a slash-menu item used to delete the typed `/trigger` in one editor transaction and run the item's insert in a second. Under load, a transaction fired during the delete (for example the collaboration layer reacting to it) could move the selection onto a neighboring selectable block, and the insert would then overwrite that block instead of inserting at the caret: the user typed `/image`, pressed Enter, and a previous image vanished with no error and no useful undo trail. The trigger delete and the item insert now land as one transaction, so nothing can divert the insert onto existing content. The other insertion menus (`#` tags, `[[` wiki links, `@` mentions in the Ask AI composer) already inserted atomically and are now guarded by a lint rule and regression tests so none of them can regress to the split form.
