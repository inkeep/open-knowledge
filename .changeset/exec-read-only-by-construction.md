---
"@inkeep/open-knowledge": patch
---

Agent `exec` is read-only at the filesystem, not by a list of flags.

0.68.6 closed `sort -oimportant.md` by widening the flag guard. Such a list only ever holds the spellings someone thought of, and a command that only reads was still one unthought-of spelling away from replacing a document with no attribution and no history to restore from.

The filesystem `exec` runs against is now read-only, so a write fails whatever the command spells and the lists are gone. What replaces them is a message: an agent that tries to write is told it tried to write, and which file when the engine names it, rather than being handed a filesystem error. `find -exec`, `-execdir`, `-ok` and `-okdir` are still refused by name, because those run a second command rather than writing.

Two error categories move. `<`, `<&`, `<<<`, `>&` and `|&` no longer report `write_blocked`; since none of them writes a document they report `shell_construct_blocked`, with a message that points at `cat <file>` rather than at `write` or `edit`. `find -exec` and its three siblings move the same way, for the same reason.

One suite checks it. It runs every write and delete attempt we know of through the real pipeline, asserts the project is byte-identical afterwards, and records which layer stopped each one: the parser, the read-only filesystem, or an option this engine does not implement. One of its tests bypasses the command parser entirely, so it is the filesystem being tested and not a list.
