---
"@inkeep/open-knowledge": patch
---

Fix the skills.sh page link on imported skills, and correct the `write` tool's skill bundle-path description.

The provenance link in the Skills UI built its skills.sh URL as `/<publisher>/skills/<skill>`, but that path's middle segment is the source repo, not a literal `skills`. It resolved only for publishers who happen to name their repo `skills`; for everyone else it pointed at a page for a repo that doesn't exist. skills.sh answers those with a placeholder stub rather than a 404, so the link looked fine and quietly showed the wrong skill. It now derives from the recorded source via `skillsShSkillLinks`, which also covers website-catalog sources (`/site/<hostname>/<skill>`). Same correction applied to the `import` tool's `source` docs and the `open-knowledge-write-skill` guide.

The `write` tool advertised skill bundle files as accepting "any path — `references/**`, `scripts/**`, `assets/**`, …", but only `references/` and `scripts/` are accepted; anything else is rejected. An agent following the description got an error contradicting it.
