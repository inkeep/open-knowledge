---
"@inkeep/open-knowledge": patch
---

Dropping a file into a document now explains why an upload failed instead of showing a bare "Upload failed" toast. When the dropped file's contents can no longer be read — it was moved, deleted, or had not finished downloading between the drop and the upload — the message names the file and says so, rather than implying a server problem. Genuine connectivity failures are now reported as such. The same distinction applies to uploads started from the property panel's file picker.

Both paths also record the file's name, type, size at drop time, size at send time, and the underlying error, so a failed upload leaves enough evidence in a diagnostic bundle to identify which file failed and why. Previously the entire record of a failure was `TypeError: Failed to fetch`, which is the same message the browser produces for an unreachable server, a denied read, and a vanished file alike — and because the request never leaves the app in these cases, nothing was recorded on the server either.
