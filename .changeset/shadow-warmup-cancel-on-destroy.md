---
'@inkeep/open-knowledge': patch
---

Shutting the server down now cancels the shadow history warm-up that was still scheduled, so that warm-up no longer issues a git write after shutdown reports it has finished.

Boot schedules a one-shot warm-up three seconds later that rebuilds the shadow repository's fan-out index, writing a git index and loose objects under the project's `.git/ok/`. The handle for that timer was discarded, so shutdown had nothing to cancel: a server destroyed inside those three seconds drained its in-flight shadow work, released the shadow lock, and returned, and the warm-up then fired against a repository that was no longer supposed to be written to. The timer is now held and cleared in the same shutdown phase that clears the other pending timers, before the shadow drain runs, so a warm-up that has not yet fired never starts and one already running is still awaited by the existing drain.

Anything that deletes the project directory as soon as shutdown returns was racing those writes. The write recreated directories under `.git/ok/objects/` while the delete was walking them, which surfaces as an `ENOTEMPTY` failure from the delete rather than from anything the server reports.
