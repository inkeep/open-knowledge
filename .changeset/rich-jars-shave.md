---
'@inkeep/open-knowledge': patch
---

Detailed diagnostic bundles now collect the macOS crash reports the OS wrote for the app and its helpers, so an ending the app could not record itself can still be attributed.

When the operating system ends one of the app's processes, it writes its own report naming the cause: the signal or exception, the code-signing verdict, and whatever text the process left behind as it died. That record exists whether or not a crash handler ran to leave a dump, which is what makes it the only account of a whole class of endings, and those files were not being collected. A Detailed-level bundle now carries the matching ones under `diagnostic-reports/`, alongside a `state/diagnostic-reports-status.txt` record that says what the search found even when the answer is nothing, so a triage can tell "the OS recorded nothing" from "nobody looked".

Only this app's own reports are collected, never another application's, and they pass through the same redaction and secret-scrubbing as every other bundled file. macOS stores paths in these reports with every forward slash escaped, which the scrub cannot read, so a report is normalised as it enters a bundle rather than inside any one pass over it. The identifiers that link one machine's bundles to each other are replaced at the same point: measured over a year of real reports, `crashReporterKey` held one distinct value and `bootSessionUUID` two, so either re-identifies a user across every bundle they file. The per-incident id and the sleep/wake id are kept, since those are what correlating reports inside a bundle actually uses. The bug-report dialog's Detailed-diagnostics description, shown only on macOS, and the "What OpenKnowledge writes" reference both name the new category and what a report carries.

`ok diagnose bundle` collects them too, and prints what the search found before it writes the zip.
