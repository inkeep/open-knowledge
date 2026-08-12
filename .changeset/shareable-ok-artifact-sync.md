---
"@inkeep/open-knowledge": patch
---

Team-shareable `.ok` artifacts now auto-sync in shared projects. The project `config.yml`, the seeded `.ok/.gitignore`, frontmatter lint schemas (`.ok/schemas/*.json`), note templates (project-level and folder-level), and folder metadata (`<folder>/.ok/frontmatter.yml`) are staged and pushed by the auto-save cycle, and deleting them propagates too. Previously a teammate could author a schema and sync would run green without it ever reaching anyone else. Machine-local state (`.ok/local/`, `.ok/worktrees/`, legacy root state files) and secret-suffixed files are never synced, local-only projects behave exactly as before, and these files still do not appear in the sidebar or document index. A merge conflict on `.ok/config.yml` still auto-resolves to the remote version, overwriting local config edits, but the server log now records a warning so the overwrite leaves a findable trace (there is no in-app notification for it yet). Projects with `content.dir` set to a subfolder now sync the project-root `.ok` set as well.

Linkable files inside the configured attachment folder now auto-sync without requiring a Markdown document inside that folder. Unconfigured asset directories remain outside the sync scope.
