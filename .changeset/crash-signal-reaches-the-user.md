---
"@inkeep/open-knowledge": patch
---

A crash you were never told about no longer stays that way. Previously a single unanswered crash prompt muted every later crash for the rest of the session — one report arrived from a window that had blinked and reloaded twice in 52 minutes with no explanation, because the second crash was silenced by a prompt from the first that nobody had answered. An unanswered invitation now only mutes crashes that belong to the same incident; a later, independent crash supersedes it and asks you about the crash that just happened. The handover is logged, so a silence is legible after the fact instead of looking like nothing occurred.

Reporting a bug yourself now offers the crash dump the app is already holding. The opt-in used to appear only when a crash prompt opened the dialog for you, so the report filed moments after an unprompted crash — the one most likely to carry the answer — shipped without the dump sitting on disk the whole time. The row now appears whenever there is a dump to attach, left unchecked so the unredactable memory rides along only if you choose it.
