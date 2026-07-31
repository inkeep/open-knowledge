---
"@inkeep/open-knowledge": minor
---

Skills become a first-class surface: find them, bring them in, and own them as versioned content.

**Find a skill.** Skills is now a destination rather than a settings tab. Its home leads with describing the skill you want, with Upload a skill and New from scratch as quiet actions beneath. The six most-installed skills on skills.sh render inline with a Browse all link, so installing something that already exists no longer starts by opening a modal.

Adding a skill opens one dialog with two tabs:

- **Explore** browses skills.sh — a most-installed grid on an empty query, keyword search otherwise — and imports a repository-backed or website-backed result in one click. Website publishers install through their `.well-known` skill index, including every declared file. When skills.sh is unreachable the surface degrades to a GitHub-topic search and the last-good grid, so it is never blank on a cold network.
- **Upload** takes a `.zip`/`.skill` bundle, a folder, or a remote source: a GitHub `owner/repo`, a git URL, a skills.sh skill-page URL, or a local path.

**Skills you already have are left alone.** Skills OK finds in your other tools (Claude plugins, plus the Claude, Codex, Cursor, OpenCode, Copilot, Pi, and Agents skill dirs) are never imported. They appear as read-only **Detected** rows, expand to their file tree (loaded lazily, so the sidebar never fetches a preview for every detected skill up front), and are editable in place — changes save straight to that editor's own copy.

**One skill, one folder, many places.** Every path lands the skill in the project's skill home (`.agents/skills/<name>/` when you have one) as versioned content: history, restore, search, and attribution, with provenance in `.ok/skills-lock.json`. An identical re-import is a no-op; a name collision lands under `<name>-imported` rather than overwriting. A new location is a symlink to the source by default, or follows the form the skill's other locations already use; convert any single location when you want an independent copy. Imported scripts are stored as content and never executed.

**Installing a set, not a file at a time.** When a preview belongs to a plugin or a website index, it discloses the siblings and opens a picker — each with its description, a select-all, and the level to install at — rather than a one-click "install all 41". The selection imports through a single server-side clone, so ten skills from one repo no longer re-clone it ten times, and one oversized bundle or misspelled name reports itself instead of failing the rest. Website installs also fetch bundle files concurrently and read the origin index once per selection: two skills from `open.feishu.cn` went from 39s to 9s. A plugin's hooks, commands, and MCP servers are named, never installed and never run.

**The `workflow` MCP tool is retired.** Its five procedures move into skill guidance, so they load on description match instead of costing tool-list tokens every turn. `import` takes the freed slot, keeping the surface at 21 tools.

- `ingest` and brownfield onboarding move into the platform `open-knowledge` skill, which ships with every `ok init`.
- `research` and `consolidate` ship with the `knowledge-base` pack; `wiki` generate/refresh with `codebase-wiki`. The platform skill now says plainly when a procedure needs its pack.

**Starter packs ship focused skills.** A pack directory may hold a root `SKILL.md` plus one subdirectory per member skill. `software-lifecycle` gains `frame-a-proposal`, `write-a-spec`, `record-a-decision`, `write-a-postmortem`, and `review-a-design`; `knowledge-base` promotes `research` and `consolidate` to member skills. Pack skills also gained task-based triggers, so `software-lifecycle` fires on "record an architecture decision" rather than only on a folder-layout match. `ok seed --pack <id>` installs every skill a pack ships, and no longer reports "already seeded, nothing to do" when the folders exist but a skill is missing.

**Fixes**

- Installing a skill into the `.agents` hub no longer fails with "Placement path must be a project-relative directory outside .ok/." Asking for a location a skill already occupies is a satisfied request that changes nothing.
- Skill preview tabs no longer duplicate. A preview's identity includes its source path, and that path moves (a plugin-cache path carries the version; a detected skill relocates when its installed copy is deleted), which minted a second tab with the same label — one of which looked impossible to close. Reopening reuses the tab already open for that skill and level, and a visible tab is always closable.
- Settings → Skills is slimmed to the install-targets picker; authoring and browsing live in the sidebar.
- Install counts read `2.7M` rather than `2733k`, in the active locale's units and separators.

**Under the hood:** a read-only cross-harness enumerator (`ok skills installed`, `GET /api/skills/installed`), the skills.sh discovery and leaderboard proxies with defensive row-level parsing, the acquire/import pipeline, and the shared skill and Pack model — all exported from the new `@inkeep/open-knowledge-core/skills-catalog` subpath. Remote imports require explicit opt-in before upstream changes auto-apply; local filesystem sources keep automatic refresh. Rename and scope-move preserve provenance, update eligibility, and copy projections. The canonical-component text in tool descriptions is split so `write` and `edit` still list every component id while the authoring reference rides `write` alone, trimming roughly 940 bytes of always-on context per turn.
