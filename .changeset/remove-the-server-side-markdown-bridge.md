---
"@inkeep/open-knowledge": patch
---

The server-side Markdown bridge and its guard machinery are removed.

The bridge reconciled two live copies of every open document — the Markdown source and a parsed ProseMirror tree — and carried a large apparatus to keep them honest: convergence observers, a watchdog, a pre-drain discriminator, split-brain re-derive and loss suppression. The previous release took the second copy off every write path, leaving that apparatus running against a tree nothing wrote to. It is now gone, along with the roughly thirteen thousand lines of implementation and tests that existed to police it.

You should notice nothing. The editor has been deriving what it renders on your own machine since the last release, and the Markdown source has been the source of truth for the written bytes throughout. The one piece kept from that subsystem is the persistence settle gate, which decides when a document has stopped changing and is safe to write.

Two things worth knowing if you have tuned the server by hand:

- **Three `bridge:` settings in `.ok/config.yml` no longer do anything** — `bridge.deferGuard`, `bridge.fixedPoint` and `bridge.preDrain`. They still parse, so an existing config keeps validating and no upgrade step is required; they simply have nothing left to switch on. `bridge.lossDetector` and `lossCapture` are unaffected and still control live loss detection and the `ok diagnose` capture ring.
- **Nineteen bridge-era counters in the metrics payload are now marked deprecated.** They remain in the payload and remain zero, so nothing that reads it breaks. They will be removed in a later release once the field set is settled.
