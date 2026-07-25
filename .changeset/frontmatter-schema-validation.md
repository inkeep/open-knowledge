---
"@inkeep/open-knowledge-core": minor
"@inkeep/open-knowledge-server": minor
"@inkeep/open-knowledge-app": minor
"@inkeep/open-knowledge": minor
---

Validate document frontmatter against JSON Schema files with the new `frontmatter` content-rules plugin.

**Schema mappings in `config.yml`.** Enable the plugin in Settings → Plugins and map schema files to doc sets with globs — `contentRules.frontmatter.schemas` entries pair an `appliesTo` glob (or list; a leading `!` excludes) with a `file` path. Schema files are ordinary draft-07 JSON Schema, readable by any external tool; `.ok/schemas/` is only the default home.

**Warnings everywhere, blocking nowhere.** Violations (`frontmatter/required`, `frontmatter/enum`, `frontmatter/type`, …) surface in the editor gutter, the Problems panel, `ok lint`, the MCP `lint` tool, and as advisories on agent writes — a violation never blocks or changes a write. Broken schema files and invalid globs report on the config channel (Settings panel, audit `warnings`), never as document problems.

**No-code editing.** The plugin's settings panel manages the glob → file mappings, and a per-field editor edits each schema (type, required, allowed values, pattern) without touching raw JSON — keywords the editor doesn't model are preserved verbatim, and editing a mapping whose file doesn't exist yet creates it.

**Schema-aware property panel.** Fields constrained by an `enum` render as a select, and array fields with `items.enum` render as toggleable value chips, so valid values are picked instead of typed.

**Agents learn the contract at read time.** `exec` listings and reads advertise which schema files govern a doc or folder (`schemas: …`), resolved server-side.

**Discovery UX.** The glob editor names its grammar with an example pattern, an explicit Edit button opens each schema on the WYSIWYG Fields view, and a glob that matches zero docs warns on the config channel alongside the invalid/suspicious-glob warnings. The Problems panel names the plugins doing the checking and, when none are enabled, says so and links to Settings → Plugins instead of a misleading "no problems".
