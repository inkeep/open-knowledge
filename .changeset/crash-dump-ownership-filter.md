---
"@inkeep/open-knowledge": patch
---

Crash reports no longer blame the app for a crash in some other program, and a bug report can no longer carry another application's process memory.

On macOS a task's Mach exception ports are inherited across fork and exec, so every descendant of the desktop app runs under the crash handler the app started: the in-app terminal's login shell, anything launched from that shell, MCP servers, agents, and unrelated GUI applications. When one of those aborted, the handler wrote its minidump into the app's own crash database and stamped it with the app's product name and version, and nothing downstream told the two apart.

- **A crash dump is now checked against the app bundle before it counts as ours.** Detection reads the dump's own module list to find the crashed process's main executable and requires it to resolve inside the app bundle. A dump from a foreign process no longer arms the "the previous session crashed" invitation, which previously fired after a perfectly clean quit whenever an unrelated app had crashed under the inherited handler.
- **A foreign dump can never be attached to a bug report.** This is the more serious half. The "include the crash dump" checkbox describes a memory snapshot of this app, and the collector copies the dump into the bundle byte for byte, so an unrelated application's raw process memory (plus its loaded-module inventory and library search paths) could be uploaded under a consent the reporter was never asked for. The attachment lookup now only returns dumps proved to belong to this app.
- **A dump too damaged to identify still prompts, but is never attached.** A dump truncated by the crash that produced it is most likely ours, and the invitation only asks a question the user can dismiss, so the prompt errs toward asking. Egress errs the other way: memory whose owner cannot be established is memory the consent dialog cannot honestly describe, so the checkbox is not offered.
- **Ignored dumps leave a log breadcrumb** naming how many were skipped, so a suppressed prompt is distinguishable from detection never running.
