---
"@inkeep/open-knowledge": patch
---

When sending a bug report fails, the report you send us afterwards can now explain why. Previously a failed send left a single line reading "network error" and nothing else: not which of the three requests failed, not whether your machine could not find our server or our server refused the connection or a certificate had expired, and no record at all once the logs aged out a week later. A report about a failed report was the one kind of report we could not answer.

Three things changed. Failures across every part of the app now record the error's type and its system error code in the log file that ships inside a report, rather than only on a developer console that nothing captures in an installed app. A failed send now names which request failed, so "our intake was unreachable" and "the storage the file uploads to was unreachable" are told apart. And the small record kept beside each report, which lists every send attempt and how it went, is now included in the reports you send — it is the only account that survives after the logs rotate.

The added detail is deliberately narrow: error types and system error codes, never messages, file paths, or stack traces, since those can carry your folder names and the addresses files upload to. Everything included goes through the same secret scrub as the rest of a report.
