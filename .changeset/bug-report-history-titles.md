---
"@inkeep/open-knowledge": minor
---

Title bug-report history rows by what was reported.

A history row used to say what state its send was in, never what the report was about. Two reports filed the same afternoon rendered as two identical cards separated only by a timestamp. Rows are now titled by the first useful line of the note that went with the report, with the send-state badge kept on that same line and the bundle level, timestamp, size, reference and failure reason collapsed into one secondary line beneath it. The rows are also a real list now, so a screen reader announces one item per report and reads each row's title first.

Retrying a report from history now includes your note. Earlier retries silently dropped it, so a resend reached us with the reporter's own words missing, and the email draft it falls back to named the file to attach but not what had gone wrong. Both now carry the note the original send did.

Making that work meant saving the note locally for the first time: a redacted copy is written alongside the report when the bundle is created, so it survives the send that deletes the bundle. Reports generated before this update have no saved note, so they fall back to a project-based title, or to "Untitled report" when the report is not tied to a project (a system-wide report, or one made with `ok bug-report`).
