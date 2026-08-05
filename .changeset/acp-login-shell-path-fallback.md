---
"@inkeep/open-knowledge": patch
---

Agents that run through `npx` or `uvx` now start on machines where Node or Python tooling is managed by nvm or fnm, instead of offering to download a copy of Node the user already has. A desktop app opened from the Dock or Finder inherits a minimal `PATH`, and a version manager like nvm has no fixed directory to add to it — the active Node lives under a versioned path that only a shell function puts on `PATH`. When a command can't be found, OK now asks your login shell what its `PATH` is and tries once more before offering to download a managed runtime. The same fallback also rescues custom agents installed in shell-configured locations. The probe runs at most once per session, only after a launch has already failed, and never overrides a `PATH` that an agent's own configuration set.
