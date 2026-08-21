---
"@inkeep/open-knowledge": patch
---

Multi-word searches in the command palette and settings search now find commands regardless of word order. Typing "report bug" in ⌘K showed no commands at all, because a command was only offered when everything you typed appeared as one uninterrupted run of text inside its name and keywords. "Report a bug" has a word between the two, so it did not qualify, and neither did "branch switch" for Switch worktree or "project sync" in settings search. The file results in the same dialog already matched word by word, which is why the file half of the list filled in while the command half stayed empty.

A command is now offered when every word you typed appears somewhere in its name or keywords, in any order and not necessarily next to each other. Commands that matched before still match, and rows keep their existing position in the list. Note that because commands are listed above file results, a multi-word query that previously found only files may now preselect a command, so Enter runs the command rather than opening the file.

Searching "close terminal" also offers Hide Terminal, and offers it first. Kill Terminal answers to "close" as well, and it ends a running shell without asking, so leaving it as the only result for a phrase that means "put the panel away" in most editors would have been a trap.
