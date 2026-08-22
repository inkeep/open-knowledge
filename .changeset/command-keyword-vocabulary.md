---
"@inkeep/open-knowledge": patch
---

Commands in the ⌘K palette are now findable by the words people actually search for, not only the words in their names. Commands are named for what they are, while users search for what they want to do, so "delete file" did not find Move to Trash, "open settings" did not find Settings, and "file bug" did not find Report a bug. Across a sweep of seventy realistic phrasings, thirty-one returned nothing at all.

Thirty-five search terms were added across twenty-one commands, nineteen distinct words in all, each one chosen because a measured phrasing failed without it. "new document" and "create note" now reach New file, "show in folder" reaches Reveal in Finder, "change branch" reaches Switch worktree, and "go back" reaches Back. Panels that change their own name as you use them — Show Terminal becomes Hide Terminal once it is open — now answer to both verbs, so "show agents" and "hide files" work whichever state the panel is in rather than only half the time.

No command was renamed, and nothing that matched before stopped matching. One consequence worth knowing: a few ordinary single words now reach a command that they did not before, and commands are listed above file results. In a project containing a file called note, typing "note" and pressing Enter opens the New file dialog rather than the document, where previously it opened the document. Arrow down to the file, or keep typing, to reach it.
