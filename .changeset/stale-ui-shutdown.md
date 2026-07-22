---
'@inkeep/open-knowledge': patch
---

fix: tear down the `ok ui` sibling when `ok start` exits via a signal

`ok start` spawns a detached `ok ui` process to serve the editor shell. On
`Ctrl+C` (SIGINT/SIGTERM) the CLI destroyed the collab server but left that UI
child running until its 12-hour safety timer expired, holding its port so the
next `ok start` bound a different one. The signal path now runs the same guarded
UI teardown as idle-shutdown — SIGTERM, wait out a grace window, then escalate
to SIGKILL — scoped by `spawnedUiPid` to the sibling this process actually
spawned, so a lock holder we did not spawn (a desktop shell, another session) is
left alone.
