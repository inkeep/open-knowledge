---
"@inkeep/open-knowledge": patch
---

Allow overriding the per-step server-shutdown timeout via `OK_DESTROY_STEP_TIMEOUT_MS`

Each server teardown step is capped (default 5s) so a stuck step can't hang exit. That cap is now overridable with the `OK_DESTROY_STEP_TIMEOUT_MS` environment variable (milliseconds), which gives slower or heavily loaded environments headroom without changing the default. Normal usage is unaffected.
