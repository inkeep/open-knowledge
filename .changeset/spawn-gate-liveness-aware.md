---
'@inkeep/open-knowledge': patch
---

Desktop no longer kills a healthy server that is still starting. The post-spawn wait was a fixed 15 s wall-clock deadline, after which the child was SIGTERM'd even when it was alive and mid-boot — so a project whose boot legitimately took longer than 15 s (large working copies, cold caches, a machine under load) could not be opened at all, and retries reproduced it identically. A child observed alive at the deadline now graduates to a longer bounded wait instead of being killed, and both bounds are overridable via `OK_SPAWN_STARTUP_TIMEOUT_MS` / `OK_SPAWN_BIND_TIMEOUT_MS`.

The failure dialog also stops implying that a slow start was caused by whatever the server printed on the way up. Server output is still shown, but it is labelled as the cause only when the child actually exited; a still-running child's output is framed as probably unrelated. Open failures are now written to the desktop log as well as the dialog.
