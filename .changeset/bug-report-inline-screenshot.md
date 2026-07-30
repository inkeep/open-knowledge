---
'@inkeep/open-knowledge': patch
---

Screenshots attached to a bug report now show up in the report itself, instead of only inside the downloadable diagnostic bundle. Anyone triaging a report sees the picture immediately rather than having to download a zip and unpack it to find out what the reporter was looking at.

| Before | After |
| --- | --- |
| Report says a screenshot was included; nothing visible | The screenshot is displayed in the report |
| Triager downloads the bundle and unzips it to see anything | Nothing to download for a look at the screen |

This was supposed to work already, and never did once. The intake tried to pull the screenshot out of the bundle after the upload, but the storage the bundle lands in refuses that read, so the step failed silently on every single report and the screenshot was quietly left out. The app now uploads the screenshot alongside the bundle rather than expecting the server to dig it back out, which removes the failing step entirely.

Two things worth knowing. This takes effect for reports sent from this version onward, because the app is what supplies the screenshot now — reports already filed are unaffected. And re-sending a report from the report list in a later session sends it without the inline screenshot, since the capture is no longer in memory by then; the screenshot is still inside the bundle in that case.

Unchanged: the screenshot is still opt-in via the checkbox in the report dialog, still previewed before you send, and unchecking it still means no screenshot leaves your machine.
