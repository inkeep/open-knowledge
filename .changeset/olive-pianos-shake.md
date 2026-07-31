---
"@inkeep/open-knowledge": patch
---

Show an Update button on OK's built-in skills, and make `ok init --no-skills` state that it opts out machine-wide.

The built-in skills (`open-knowledge-discovery`, `open-knowledge-write-skill`) had no way to surface an available update. The server already synthesizes their provenance and supports re-pulling them, but the built-in preview tab hardcoded its header actions to nothing, so the hook that checks for updates never mounted. The tab now shows a source link and an Update button when the upstream copy differs. Updates stay manual — built-ins never auto-apply.

`ok init --no-skills` reported `skipped (opted out via --no-skills)`. Nothing was skipped: the decline is recorded against your home directory and both bundles are removed from every user-global skill directory, so running it once in a throwaway project turned the built-ins off for every project on the machine. The summary now says that, and names how to undo it.

`installUserSkill` also enforces the opt-out itself rather than trusting each caller to check first, so a declined bundle can't be reinstalled by a caller that forgets the gate.
