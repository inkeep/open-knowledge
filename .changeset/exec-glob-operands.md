---
"@inkeep/open-knowledge": patch
---

Agent `exec` expands globs, and names the files it actually read.

`cat specs/*.md` reported `No such file or directory` for every command that takes file operands, so an agent reading a folder by pattern was told the files were not there. Every command with file operands was affected, `grep -rn needle *.md` and `find docs/*` included. Only a pattern the command matches itself, such as `find -name '*.md'`, was ever safe.

`exec` rebuilds each command before running it, so it can hide `node_modules` and the other noise directories from recursive searches. Rebuilding quoted every argument, and a quoted `specs/*.md` is a request for one file with a star in its name.

Patterns are now matched against the project before the command runs, and the files they matched are passed through as ordinary arguments. A pattern that matches nothing is left as written, the way a shell leaves it. Quoted patterns such as `find . -name '*.md'` are never expanded and keep being matched literally.

Two things improve alongside it. The referenced-file list now names the documents a pattern actually matched rather than the pattern itself, so `cat specs/*.md` reports both specs instead of one document that does not exist; the same correction applies to `ls` given several files. An argument a command reads as a pattern is left for the command to match: `find . -name '*.md'` still searches the whole tree, and `grep -rn PRD-* .` searches for the pattern rather than for whichever filename happens to match it. Everything a command reads as a path is expanded, including `find docs/*`. A pattern matching more paths than the tool will accept is refused with a suggestion to narrow it, rather than expanding without limit, and the matching stops at that limit rather than walking the whole project first. Expansion skips the same directories recursive searches skip, so `cat */*.md` never names a file under `node_modules`.

`grep -o` and `find -o` work again. Neither writes anything: `-o` asks grep to print only the matching part, and joins two conditions in find. They were refused because the flag was blocked for every command at once, and only `sort` ever wrote with it.
