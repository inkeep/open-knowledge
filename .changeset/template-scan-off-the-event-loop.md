---
"@inkeep/open-knowledge": patch
---

Typing in a large knowledge base no longer stutters while the template list is being gathered. Building the list of templates you can create from means walking the project's folders, and on a big repository that walk is long enough to hit its internal limit. It ran start to finish without pausing, on the same loop that carries your keystrokes between the editor and the server, so a burst of requests left the editor unable to keep up with typing for a noticeable stretch. The walk now pauses between folders (the longest uninterrupted pause it causes drops from roughly 84 ms to about 1 ms) and reads each folder with a single system call instead of one per entry. Symlinked folders are still followed.
