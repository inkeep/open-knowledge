---
"@inkeep/open-knowledge": patch
---

When OpenKnowledge invites you to report a crash it just detected, and a crash dump for that crash is on disk, the dump is now included in the report by default. The crash dump is a memory snapshot from the moment of the crash, and the single most useful artifact for finding the cause, so it now rides along unless you uncheck it. Previously it was off by default, so crash reports usually arrived without the very dump that triggered them.

The crash-dump option now appears only when a dump actually exists for the crash, so a crash invite with nothing to include (for example a session that ended without a clean quit but left no native dump) no longer shows a dead checkbox.

Nothing about the consent flow changes: the crash dump is still a labeled checkbox you can turn off, the note still says it can contain document content and can't be redacted, and nothing is sent until you review the exact bundle. This only affects reports triggered by a detected crash; regular bug reports are unchanged and never include a crash dump.
