---
"@inkeep/open-knowledge": patch
---

Agents now know to look things up rather than guess at what OpenKnowledge can do. The shipped skills describe the core editing flow, so a request touching anything outside it depended on the agent already happening to know the feature existed. Both skills now point at the documentation site and the source repository.

**Re-run `ok init` in an existing project to pick this up.** The project-local skill is seeded only when absent, so opening an already-initialized project does not refresh it. The user-global discovery skill does refresh on upgrade.
