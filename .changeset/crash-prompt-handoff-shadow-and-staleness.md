---
'@inkeep/open-knowledge': patch
---

Stop the crash prompt firing for deaths that were not crashes.

Three bounds on the crash reporter:

- A minidump written inside the 30-second teardown that follows a recorded update handoff no longer arms a report invitation. The process was already committed to quitting so the installer could replace it, and a fault on the way out is not something the user can act on. A dump past that window still prompts, because an install can be in flight for up to 30 minutes and a fault inside it is the app failing on its own. Only a dump this app can positively claim is shadowed; one it cannot parse still prompts, as it does elsewhere in the crash reporter.
- A death the app can date to more than a week ago no longer prompts. The death is dated by the latest evidence the app was alive — the newest crash dump or the previous session's last heartbeat, whichever is later, ignoring a heartbeat that postdates the launch reading it — so an old dump left on disk can neither make a recent death look stale nor become the subject of the report. Before this, a sentinel prompted the same at twelve seconds and twelve days old, and an un-acknowledged dump re-armed the same prompt on every launch indefinitely. A session that left no heartbeat and no dump cannot be dated, so it is exempt and still prompts: sentinels written before 0.35 carry no heartbeat, and their boot time answers when the session started rather than when it died.
- An armed invitation nobody answered within 24 hours is dropped undelivered instead of waiting for the lifetime of the process. The bound is per process, not per crash: a relaunch offers the same crash again, because a new launch is a new chance to ask and a session that never showed the prompt should not silently lose it.

The report note now carries when the crash happened and how long ago whenever the app can date the death itself — never by borrowing a crash dump the same report says was not the cause — so a stale report is legible without decoding the boot id.

The relative-time wording it uses is now shared with `ok ps`, which changes that command's `STARTED` column in two visible ways: an age under a minute reads `30s ago` rather than `30s`, so no cell reads as a bare duration, and a start time that postdates now reads `0s ago` rather than a negative duration. A stamp the command cannot parse still renders as the table's `—`.
