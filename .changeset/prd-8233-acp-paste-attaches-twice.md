---
"@inkeep/open-knowledge": patch
---

Pasting an image into the agent composer no longer attaches it twice. About a quarter of pastes produced two identical thumbnails from one Cmd+V, and the second had to be removed by hand.

A pasted image arrives on the clipboard event through two accessors that describe the same payload: `items`, which also carries non-file entries, and `files`, which is the file-only subset of it. The composer read both and dropped anything it had already seen, keyed on the file's name, size, and last-modified time. That key is unstable for a paste. A pasted image has no file on disk, so the browser builds a fresh file object for each read and stamps its last-modified time with the clock at that moment rather than deriving it from the payload. Whenever the two reads landed in different milliseconds — measured at 4 of 15 pastes — the keys disagreed, the second copy looked like a new file, and both were attached.

The composer now treats `items` as the authoritative list and only consults `files` when `items` yields nothing, which is what an older host or a synthetic event does. One payload is read once, so there is nothing to de-duplicate and no timestamp to depend on. Dragging files from Finder is unchanged; it was never affected, because a real file on disk reports the same last-modified time to both reads.

Attaching the same picture twice on purpose also renders correctly now. The pending-attachment strip identified each thumbnail by filename and the leading bytes of its content, which two copies of one image share, so the two tiles collided on a single identity.
