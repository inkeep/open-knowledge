---
'@inkeep/open-knowledge-core': patch
'@inkeep/open-knowledge-server': patch
---

Attribute the generated `index.md` to OK, not to you

Rebuilds of the generated root index now commit under a dedicated `ok-generator`
writer, so history names what actually wrote the file, and the timeline shows it
as OK rather than as a person.

Previously the generator recorded no contributor at all. The bytes still reached
the shadow repo — every commit's tree is a sweep of the whole content directory —
but they landed under whichever writer drained next: your own principal when you
had the index open, `openknowledge-service` when you did not. The result was a
commit reading `wip: index` authored by you, for lines you never typed, on a file
OK overwrites on the next rebuild.

`ok-generator` is a classified writer, so its history is never garbage-collected
and `git log refs/wip/<branch>/ok-generator` is exactly the generator's own
record.
