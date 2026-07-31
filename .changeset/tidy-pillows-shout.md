---
'@inkeep/open-knowledge': patch
---

Fix the slash, wiki-link and tag pickers destroying typed text inside code blocks and inline code spans. All three menus used to open in a code context, and choosing an item deleted the characters you had typed there: the query vanished out of the fence and a chip landed after it, while a slash command replaced the whole code block with the chosen node and lost the fence's language tag. The menus now stay closed inside code, matching every other typing shortcut in the editor.
