---
"@inkeep/open-knowledge": patch
---

Crash reports now include evidence of prolonged main-thread freezes.

Until now the "previous session ended without a clean quit" report carried one liveness fact, the last time the main thread's own 60-second heartbeat ran. A main thread that hangs stops that heartbeat exactly the way a crash does, so "the app died at 11:29" and "the app froze at 11:29 and you force-quit it four hours later" produced identical reports and pointed at different bugs.

The desktop now runs a watchdog on a worker thread that records main-thread pings every five seconds. At the next launch, the desktop log reports whether the last successful sample observed a block of at least 15 seconds, together with the measured duration, threshold, sample time and evidence state. A `died` verdict means that sample was below the threshold; it does not rule out a shorter or recovered block, or a block after the watchdog stopped writing. Missing or unusable evidence yields no verdict. The worker re-baselines after a whole-process pause so sleep does not count as a hang. These diagnostics do not change whether the app offers a crash report.
