---
"@inkeep/open-knowledge": patch
---

Agent `exec` no longer reports documents that do not exist.

`exec` returns a list of the wiki files a command touched, with frontmatter, link counts and a link to open each one. That list was assembled by reading the command's output and treating anything ending in `.md` as a document. It was checked against the disk, and when the check failed the path was kept anyway on the strength of the file extension.

`ls -l` was the clearest case. Its output puts permissions, owner and a timestamp ahead of each name, so the whole line was taken as a filename: a listing of six documents, none of which existed, each with its own preview link, while the real files went unmentioned. Output from `sort`, `uniq` and `cut` was read the same way, and ordinary prose became documents.

A path that is not on disk is no longer reported. Alongside that, each command's output is now read according to its own shape rather than scanned for anything markdown-looking: `ls -l` reads the name field, and the commands that name their files as arguments report those. `ls -l` now lists what is actually there, and `sort`, `uniq` and `cut` report the file they read, which none of them did before. `wc` already named its file and continues to.

A companion suite runs a matrix of representative command and flag shapes over a fixture project and checks that every path reported back exists, so the guarantee is verified rather than assumed. One case asserts the tool still reports the real files, so the check cannot be satisfied by reporting nothing.
