---
"@inkeep/open-knowledge": patch
---

Fix a server crash where the app would report losing its connection and require a manual restart. Under normal logging load, multiple loggers writing to the shared server log file could race when the file rotated at its size cap: one writer renamed the active log out from under another, whose failed rename surfaced as an unhandled error that took the whole server process down. Log rotation is now serialized per file across every writer, and a log-sink write failure can no longer crash the server — a dropped log record is reported and the server keeps running.
