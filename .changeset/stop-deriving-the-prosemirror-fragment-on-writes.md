---
"@inkeep/open-knowledge": patch
---

Agent writes, file-watcher writes and rollbacks no longer re-derive a second copy of your document on the server.

Every write used to land twice: once as the Markdown source, and again as a parsed ProseMirror tree that a background reconciler compared the source against. The editor now derives what it renders on your own machine, so the server's copy had no reader — it was parsing and serializing whole documents on every store, every agent write, every save from disk, and on every asset that appeared or disappeared next to a document referencing it.

What you should notice is speed: large-document agent writes and rapid external file changes do less work per write. What you should not notice is any change in what reaches disk — the Markdown source has been the source of truth for the written bytes throughout, and that path is untouched.

Two smaller consequences:

- Version-history entries recorded before this release stay readable. Duplication-reset checkpoints minted from now on omit a fragment-size field that no longer has a value behind it.
- `applyExternalChange`, `applyAgentMarkdownWrite`, `applyAgentUndo` and `createExternalChangeHandler` drop their now-unused embed-resolver, pre-parse and loss-reporter parameters. Only callers passing those trailing arguments are affected.
