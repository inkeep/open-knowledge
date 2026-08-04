---
"@inkeep/open-knowledge": minor
---

The 15 starter-pack skills drop their generated `open-knowledge-pack-…` names and take marketplace short names, taken from SKILL.md frontmatter: the orientation skills become `note-taking` (was `…-plain-notes`), `writing-workflow` (was `…-writing-pipeline`), `personal-crm` (was `…-entity-vault`), `okf-knowledge-base` (was `…-okf`), and `worldbuilding`, `codebase-wiki`, `knowledge-base`, `software-lifecycle` (prefix dropped); the member skills become `frame-a-proposal`, `record-a-decision`, `write-a-spec`, `review-a-design`, `write-a-postmortem` (prefix dropped) plus `research-with-sources` (was `…-knowledge-base-research`) and `consolidate-notes` (was `…-knowledge-base-consolidate`). Every shipped skill now carries `metadata.author`/`metadata.repository`.

Skills you already have are left exactly as they are. Nothing is renamed on your
disk, your `.ok/skills-lock.json` is not rewritten, and no boot pass touches your
project. These are project-level skills that normally live in your git repo, and
silently renaming one you are already using would show up as an unexplained diff
for you and for everyone who pulls. An existing install keeps its current name,
keeps working, and still updates from source: "Update" resolves the old name to
the renamed bundle in the mirror. Re-seeding a pack recognizes the skill you
already have and will not author a second copy of it under the new name. Only
newly installed skills use the new names.

Note for maintainers: this is the reason there is no migration. If you later want
existing installs on the new names, it needs to be something a user opts into and
can see, not a rename that happens under them at boot.

Four Claude Code marketplace plugins are renamed to match their published skill names:
`entity-vault` becomes `personal-crm`, `okf` becomes `okf-knowledge-base`, `plain-notes`
becomes `note-taking`, and `writing-pipeline` becomes `writing-workflow`. The old
`/plugin install <name>@open-knowledge-skills` commands keep working for one more release:
the four old handles remain in the marketplace as aliases, marked outdated and installing
the same skills as the entry that replaced them. Switch to the new names — the aliases are
removed in a later release. The other seven plugins keep their names, but every plugin's
skill paths move as the published repo regroups into `skills/core/` and
`skills/starter-packs/`. `ok seed --pack <id>` flags are unchanged.

Switching a project's OpenKnowledge skill off in Settings now sticks. It previously
came back on the next open, because the project-open sweep recreates the skill for any
editor already wired for OpenKnowledge and nothing recorded that you had turned it off.
Your choice is now remembered per project, on your machine only, so it does not follow
the repo to teammates. A project where you never expressed a choice still gets the skill
seeded as before.

Installs of OpenKnowledge's own skills are now counted on skills.sh wherever they
actually happen. Previously only some routes reported, so most installs were invisible:
creating a project, the desktop seeding its built-in skills on first launch, opening a
wired project that had no project skill, switching the skill on in Settings, installing
for Claude Desktop, and importing our own repo by any route other than the Explore tab
all counted nothing. What is NOT counted: an app launch that installs nothing, reopening
a project, a failed write, a skill bundle you switched off, and — unchanged — any
third-party repository you typed yourself. Reporting still honours
`telemetry.skillInstallReports.enabled`, `DO_NOT_TRACK` and `DISABLE_TELEMETRY`.

A skill installed into a project is now counted once per project rather than once per
machine, because each project gets its own copy in its own editor directories. The
project path is used only as a local key to avoid double counting and is never sent.

Also: seeding now reports name collisions with your own skills instead of silently skipping, and rejected install reports are logged. skills.sh install counters for the old names reset under the new names.

Install reporting to skills.sh now retries after a rejection. Previously a report the
collector declined was recorded as sent and never retried, so any install rejected while
a newly renamed listing was still being indexed was lost for good. Only rejections the
collector application issued (400, 404, 410, 422) are retried: a 5xx, a 429, or an edge
403 may have been raised after the event was already counted, so those keep their claim,
as do reports the collector never received. A flaky network or a struggling collector can
never inflate a count.
