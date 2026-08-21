---
"@inkeep/open-knowledge": patch
---

**Retrying a bug report no longer attaches a different report's screenshot.** When you filed one report, it failed to send, and you filed a second one from the same window before retrying the first, the retry's ticket came back carrying the second report's picture. The saved bundle was always right; only the image shown on the ticket was wrong, which is the worst version of it, because the picture is the first thing anyone reads and nothing about it looked stale.

The app used to hold one screenshot per window, captured when the report dialog opened, and looked it up again at the moment a report was sent. Opening the dialog a second time replaced it, so a send that happened after that read whatever the newer dialog had captured. Screenshots are now held per report from the moment the report is written, so a retry attaches the picture that report was composed from no matter what has been filed since. A report with no picture on hand still files without one, which is what already happened for a retry in a later session.

This was only reachable once sends started running in the background with a Try again affordance, so two reports could be in flight from one window at the same time. No released build is affected.
