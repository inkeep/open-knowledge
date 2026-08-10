---
"@inkeep/open-knowledge": patch
---

OpenKnowledge no longer asks you to report crashes that never happened. Chromium writes a minidump whenever its GPU watchdog thinks a thread has stalled, even when the process recovers and keeps running, and the app had no way to tell that snapshot apart from a real crash. The result was a prompt at the next launch saying the previous session ended uncleanly, for a session that quit normally, recurring at every launch until you filed a report to make it stop. The app now reads the dump's own exception record and recognizes a captured-but-never-faulted snapshot for what it is.

The same fix closes a sharper problem. When a report dialog offers to attach a crash dump, it was resolving the newest dump on disk without checking which crash was being reported, so a watchdog snapshot written after a genuine crash could be attached to a report about that earlier crash, shipping the wrong process's memory under a notice describing a different failure. Dump resolution now steps over snapshots and reaches the dump that actually belongs to the crash being reported.

Real crashes are unaffected, deliberately so. The check keys on a value a real crash cannot carry and compares it exactly, never as a range, because the neighbouring code for an Objective-C exception differs by a single digit and marks a genuine fatal crash. Anything the app cannot read with confidence, including a dump truncated by the very fault that produced it, still prompts and still offers its dump. The behavior currently ships on macOS; Windows and Linux keep exactly today's behavior until their equivalent marker is measured against a real dump on those platforms.
