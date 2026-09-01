---
"@inkeep/open-knowledge": patch
---

No longer opens "the previous session crashed" at startup for a graphics glitch the app recovered from on its own.

A recoverable GPU-process death is swallowed on purpose: the process relaunches in about a second, so an isolated one leaves the user nothing to describe. The dump it wrote outlived the session anyway, and the next launch's crash scan had no way to tell it from the dump of a crash nobody was ever told about, so the app spent one session hiding a glitch and the next one asking about it, often naming a version the user had already updated away from.

The app now remembers the glitches it swallowed, and stays quiet at the next launch only about a leftover it can match to one of them. Anything it cannot place that precisely still prompts.

Crash dumps remain attachable to a report the user opens themselves; what changed is only which deaths the app raises on its own.
