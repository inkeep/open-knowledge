---
'@inkeep/open-knowledge': patch
---

Stop re-seeding the built-in skills into agents you removed them from

Seeding `open-knowledge-discovery` and `open-knowledge-write-skill` ran on every
launch and topped the bundles back up into every agent folder on the machine, so
uninstalling one from a single agent was undone the next time OpenKnowledge
started. Agents that read the shared `~/.agents/skills` hub also ended up with a
second copy under their own path and reported a name collision.

Seeding is now a first-run act: once a bundle exists anywhere the user can reach
it, its host set is theirs to choose and the sweep leaves it alone. A machine
where the bundle is absent everywhere still gets the full set, so a fresh install
is unchanged.

Uninstalling a built-in from one agent also works now — the reserved-name gate
that guards authoring was rejecting the lifecycle verbs too.
