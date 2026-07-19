---
"@inkeep/open-knowledge": patch
---

Fixed a rare content-corruption bug where text written to a document while a collaborator's connection was catching up could split freshly-applied content in two. When a file changed on disk (or an agent rewrote a document) at the same time as an offline-typed edit from another client arrived, part of the new content could end up interleaved with the concurrent edit — observed as a line split in the middle with the other client's text in between. The sync bridge now applies changed content as whole lines in single contiguous runs, which makes this interleaving structurally impossible; unchanged lines still keep their edit history and attribution.
