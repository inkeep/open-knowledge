---
'@inkeep/open-knowledge': patch
---

Desktop now reports why a project's server failed to start, instead of only that it timed out.

When the managed server exited before binding a port, Desktop waited the full 15 seconds and then
showed `OpenKnowledge server did not bind a port within 15000ms` — with no exit code, no signal, and
often an empty capture log. A crash 200 ms in was indistinguishable from a slow start, and the
actual cause was unrecoverable after the fact.

The spawn now observes the child's exit, so failures report their real reason
(`OpenKnowledge server exited before binding a port (pid=123, killed by SIGKILL)`), and the wait ends
as soon as the child is gone rather than running out the deadline.

A child that is alive but still starting keeps the full deadline, and its message now says the
process was still running, so a slow start no longer reads the same as a crash. The wait also still
runs to the deadline when our child lost a startup race to another process that is mid-bind, so a
contended launch keeps attaching to the winner instead of reporting an error.
