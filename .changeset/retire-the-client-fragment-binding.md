---
"@inkeep/open-knowledge": patch
---

The client-side fragment binding is retired, and the editor now has one path into a document instead of two.

Until this release the editor could still be built two ways. One walked the parsed ProseMirror tree at construction time and handed the result to a collaborative binding; the other derived the document locally from the Markdown source. A function returning a constant decided between them, and it had been answering the same way on every shipping path since the previous release. That switch and the arm it guarded are gone, along with the two guards that existed to protect the walked tree — a construct-to-mount staleness pre-warm and a wedged-binding detector that recycled the document when a remote change failed to apply.

You should notice nothing. The surviving path is the one you have been using.

Two things worth knowing if you have tuned the server by hand:

- **The three deprecated `bridge:` settings now say so where you read them.** `bridge.deferGuard`, `bridge.fixedPoint` and `bridge.preDrain` stopped being read in the previous release; their descriptions in the settings UI and the generated config schema now record that, so the deprecation is visible without consulting release notes. They still parse and still validate, so no upgrade step is required. `bridge.backgroundThrottle`, `bridge.flushOnHide`, `bridge.lossDetector` and `lossCapture` are unaffected and all still control live behaviour.
- **Remote collaboration carets remain absent.** They resolved through the binding this change removes and have not rendered since the previous release. Presence — who else has the document open — is unaffected, and the position data is still published, so restoring the carets needs a renderer rather than a protocol change. That is tracked as its own piece of work.
