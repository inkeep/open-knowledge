---
"@inkeep/open-knowledge": patch
---

A document holding a component the editor does not recognize inside another component was reported as losing content when nothing had been lost.

When the editor meets a component it does not recognize, it shows that component as its raw source text. Before persisting a document the server compares the version it is about to write against a fresh reading of those same bytes, so that a write which drops your writing gets caught. That comparison could not tell raw source text apart from the structure the very same bytes read back as, so it counted the tags and the markdown inside a raw view as writing that had gone missing. Documents in that shape were flagged, and left rows in their own history announcing a recovered loss that never happened.

The comparison now reads a raw-source block as source rather than as writing, so it no longer expects that block's markup to survive being parsed. Documents in that shape are no longer flagged for it.

What this gives up: this check gets less sensitive, not just more accurate. Writing that vanishes from inside a raw-source block is no longer visible to it. Neither, in a document holding a raw-source block, is some writing that vanishes from outside one: the check compares two whole documents as a single run of letters with no way to tell which letters came from which block, so once a raw-source block is set aside its letters can stand in for writing lost nearby. What that costs is this check's warning and the restore point it saves before applying such a write. What bounds it is where the check started: before this change it flagged every save of a document holding an unrecognized component, so what it reported for those documents was already unusable.

Unchanged: when a wrapper the editor does recognize, such as a callout, an accordion or a set of tabs, holds a component it does not recognize, blank lines you wrote around that wrapper are still rewritten. That is tracked separately.
