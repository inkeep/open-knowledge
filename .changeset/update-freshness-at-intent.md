---
"@inkeep/open-knowledge": patch
---

Updating no longer immediately asks you to update again. Releases often land less than an hour apart, so the build waiting behind the "ready to install" banner was frequently already superseded by the time you clicked it — and the check that runs as the app comes back up would spot the newer one and put the banner straight back, replacing the "Updated to Version X" confirmation you had just earned.

Clicking Relaunch now re-checks first. If a newer build has appeared since the banner was raised, the app fetches that one and installs it instead, showing "Getting the latest version…" while it does — so finishing an update leaves you on the newest build available at the moment you asked for it. For the minutes right after an update, a build that arrives is downloaded and staged silently rather than announced; it still installs the next time you quit.

This also fixes a class of failed installs. The app could previously call into the installer while a newer build was still being written into place, which surfaced as an update that failed and then worked on retry. Two things close that: a relaunch now waits for any download in progress instead of racing it, and a build that is already staged is no longer needlessly re-staged on every hourly check.
