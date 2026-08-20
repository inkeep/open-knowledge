---
"@inkeep/open-knowledge": patch
---

Link problems are no longer reported for skill documents: files in a skills folder (`.claude/skills`, `.agents/skills`, `.github/skills`, and the like) and the skill documents you open from the Skills panel. Skills routinely link to files they create only when they run, so those links were flagged as broken when nothing was wrong. This covers the Problems panel in both scopes and the link diagnostics in source mode. The unresolved-link chips the editor draws as you type, the Links panel, and `links({ kind: "dead" })` still show these targets.

The exclusion is scoped to the skills folder, not to the dot directory containing it, so a document like `.github/CI_RUNBOOK.md` keeps its link findings, as do folder templates under `.ok/templates`. A skills folder you added yourself at a visible path, such as `team/skills`, is ordinary content and is still checked. Links from your other documents into a skill still validate.
