---
"@inkeep/open-knowledge": patch
---

Stop showing the "this project is running an older version of OpenKnowledge … restart it to use the current version" notification after a routine app update. When the desktop app updated, the background server it had started kept running on the old version (it's designed to survive the app quitting), so the freshly-updated app reconnected to that stale server and flagged the version mismatch on nearly every update. The app now shuts that server down as part of the update install itself, so the relaunched app starts a fresh matching server and there's nothing to warn about. Shutdown is gated to the update-install moment only — a normal app quit still leaves your server running, as before — and the server flushes any in-flight edits before exiting, so no work is lost.
