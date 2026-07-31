---
'@inkeep/open-knowledge': patch
---

Screenshots attached to a bug report now actually appear in the report. The previous release added this and it did not work: the screenshot was still left out of every report, silently.

| Before | After |
| --- | --- |
| Report says a screenshot was included; nothing visible | The screenshot is displayed in the report |

The cause was a dropped field. The app asks "does this bundle include a screenshot?" and passes the answer along when sending, but the layer that hands the request from the window to the app's background process was rebuilding it field by field and had never been taught about that answer. The background process saw no answer, took that to mean the reporter had declined, and left the screenshot out. Because "reporter declined" is a perfectly normal outcome, nothing was logged and nothing looked broken.

Unchanged: the screenshot is still opt-in via the checkbox in the report dialog, still previewed before you send, and unchecking it still means no screenshot leaves your machine. Re-sending an older report from the report list still sends it without the inline screenshot, since the capture is no longer in memory by then.
