---
"@inkeep/open-knowledge": patch
---

Fixed a crash that could take the whole editor down to the "Something went wrong" screen during navigation — most visibly right after creating a new file, and also when a document was renamed, deleted, or moved out from under an open tab. The editor tracked its open-document pool with a value that was rebuilt from scratch on every pool change, including changes that altered nothing you could see, such as re-opening a document that was already open. Each rebuild re-rendered the app shell and handed the navigation layer a fresh set of callbacks, which prompted it to re-open the document again. When a document's identity changed underneath that cycle, it fed itself until React aborted the render with "Maximum update depth exceeded". The pool value is now reused when nothing observable has changed, so the cycle can no longer close.
