---
"@inkeep/open-knowledge": patch
---

Shutting down, restarting, or signing out of Windows no longer makes Open Knowledge report the previous session as a crash. On the next launch you were asked to send a bug report for a session that had ended perfectly normally, and the report carried no evidence of anything going wrong, because nothing had.

Open Knowledge already suppressed that prompt when the machine ended a session rather than the app, but it recognized only signals that Windows does not send. Windows announces an ending its own way, to each window rather than to the application, and the app was not listening for it. That left Windows the only platform where a normal shutdown was indistinguishable from a crash, so it was always reported as one.

The app now records that announcement the moment it arrives, along with what Windows says about it — a sign-out is distinguishable from a machine powering down, which is detail the other platforms never had. Windows does not separate a restart from a shutdown, so neither do we.

Suppression stays deliberately narrow. A session that ends without any announcement at all, as in a power cut or a forced power-off, still prompts, and so does anything that leaves a genuine crash record behind. A shutdown you cancel does not leave a mark that would quietly hide a later crash.
