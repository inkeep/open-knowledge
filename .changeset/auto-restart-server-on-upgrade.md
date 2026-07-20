---
"@inkeep/open-knowledge": patch
---

Auto-restart a leftover server after an app update, and drop the dev "started a fresh server" notice

When OpenKnowledge Desktop auto-updated, a server for a project could survive the pre-install teardown (a CLI-spawned one, or one whose shutdown timed out). The relaunched app then attached to that stale build and asked you to click "Restart with this app's version" before it worked. Now, on the first launch after an update, the app detects the version-mismatched leftover and restarts it to match automatically — no prompt. This only happens on the launch right after an update: a running server that merely differs in version (for example a newer CLI you started yourself) is never auto-restarted. No extra notice appears — the existing "Updated to Version X" banner already tells you the app updated.

The dev-only "Started a fresh OpenKnowledge server…" toast that popped up whenever a dev session reclaimed a leftover server is removed — the reclaim still happens, just silently.
