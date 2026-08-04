---
"@inkeep/open-knowledge": patch
---

`ok init --no-skills` now only skips installing the built-in skills for that run. It no longer turns them off across your whole machine.

Previously the flag recorded a machine-wide opt-out and deleted the built-in skills from your user-global skill folders, so running it once in a throwaway directory disabled them for every project. The recorded opt-out also persisted, so the desktop and `ok repair-skills` sweeps removed the skills again on every launch — reinstalling them by hand appeared to work until the next launch deleted them.

The flag now installs nothing and records nothing. Skills already on your machine are left alone. If you want to turn the built-in skills off for real, use the Settings toggle or the first-launch prompt, which is where that choice was always meant to live. If you have already been affected, re-enable them from Settings or run `ok init` without the flag.
