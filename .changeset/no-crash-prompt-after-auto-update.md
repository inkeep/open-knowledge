---
"@inkeep/open-knowledge": patch
---

The desktop app no longer tells you the previous session crashed after a successful auto-update. Installing an update means terminating the running app so its files can be replaced, and that shutdown is not the orderly one, so the next launch found the marker an unclean exit leaves behind and offered to report a crash that never happened. It now recognises its own installer as the cause and stays quiet. A genuine crash during an update still prompts, because a real crash report on disk always takes precedence, and a session that ended uncleanly with no update in flight is reported exactly as before.
