---
'@inkeep/open-knowledge': minor
---

Add per-skill opt-in for the two user-global OpenKnowledge skills (`open-knowledge-discovery` and `open-knowledge-write-skill`). The first-launch desktop consent dialog now shows a checkbox per skill (pre-checked), and `ok init` accepts `--skills <ids>` / `--no-skills`. The decision is recorded in `~/.ok/skill-state.yml` and honored by every install path — desktop launch reclaim, `ok start`, `ok repair-skills`, and `ok init` — so a declined skill is never re-installed, and unchecking one that is already installed removes it. Existing installs are grandfathered (treated as opted in, nothing removed). `ok init` now installs both user-global skills when enabled instead of only `discovery`.
