---
name: open-knowledge-pack-entity-vault
version: "0.18.0"
description: "How to work in a Personal CRM project (the `entity-vault` starter pack, GBrain-compatible): a typed-entity vault of people, companies, meetings, and concepts, each a dossier with a rewritable summary plus an append-only timeline. Read when the project has these folders. Carries the dossier convention and entity-extraction behaviors so that guidance does not live inside template bodies or folder descriptions. Complements the platform `open-knowledge` skill; does not replace it."
compatibility: "Claude Code, Claude Desktop, Claude Cowork, Claude.ai web. Requires OpenKnowledge MCP server. Installed project-local by `ok seed --pack entity-vault`."
metadata:
  pack: "entity-vault"
  author: "Inkeep"
  repository: "https://github.com/inkeep/open-knowledge"
---
# Personal CRM (GBrain-compatible) — how to work here

A Personal CRM built as a typed-entity vault, inspired by Garry Tan's gbrain. Each entity is a dossier; the agent keeps dossiers current by extracting entities from meeting notes and original thinking. This skill holds those behaviors so templates and folder descriptions stay clean. The Markdown shape is **GBrain-compatible**: if the external `gbrain` CLI is installed, it can import/sync the same vault.

> Pack guidance. The platform `open-knowledge` skill still governs every markdown operation.

## The dossier convention (the load-bearing rule)

Every dossier in `people/`, `companies/`, and `concepts/` has two parts, split by an explicit `--- timeline ---` separator:

1. **Compiled truth** (above `--- timeline ---`) — your current best understanding. Rewrite it as new evidence changes the synthesis.
2. **Timeline** (below `--- timeline ---`) — append-only dated bullets in the parseable form `- **YYYY-MM-DD** | source | @author — evidence. Confidence: …`. **Never edit existing timeline entries; only append.**

When a new fact arrives, route it: update **compiled truth** if it changes current understanding, or append a timeline bullet if it's raw evidence. The explicit separator and dated-bullet shape are what keep the vault parseable by GBrain's import/sync.

## Folders

- **`people/`**, **`companies/`**, **`concepts/`** — dossiers (compiled truth + timeline). Frontmatter `type: person|company|concept`.
- **`meetings/`** — meeting notes (`YYYY-MM-DD-<slug>.md`); `attendees:` should match dossier filenames in `people/`. The verbatim record — do NOT rewrite it. When a note is ingested from a meeting-recorder tool, add `source:` (e.g. `granola`, `fireflies`) and `source_meeting_id:` (the recorder's stable id) to its frontmatter — those two are the dedup key.
- **`originals/`** — your own untransformed thinking; authoritative source material. Frontmatter `type: original`.
- **`media/`** — bulk transcripts, voice notes, large attachments; often `.okignore`-d to keep the index light.

## Links

Per the platform skill, prefer **standard markdown links** for new dossiers, and count the relative depth carefully for the cross-folder links this vault is full of — e.g. `[Alice Chen](../people/alice-chen.md)` from a `meetings/` note, `[Acme AI](../companies/acme-ai.md)` from a `people/` dossier. The write/edit `brokenLinks` response catches a wrong-depth path before you walk away. New brain pages render on GitHub, satisfy OK's `brokenLinks` check, and import cleanly into GBrain.

Two deltas from the platform default, both GBrain-specific:

- **Don't use the leading-slash root-absolute form** (`[Alice](/people/alice-chen.md)`). OK resolves it fine, but GBrain reads a leading `/` as an absolute filesystem path and rejects it — use a relative path. (GBrain also accepts a bare `[Alice](people/alice-chen.md)`, but from a subfolder OK resolves that *source-dir-relative* — `meetings/people/alice-chen` — and reports it broken, so stick to the `../`-correct relative form, which both accept.)
- **Path-qualified wikilinks are first-class here**, not legacy: `[[people/alice-chen|Alice Chen]]` resolves vault-root from any folder (no `../` to count), is validated by `brokenLinks` like any link, and imports into GBrain. Keep them **extensionless** (`[[people/alice-chen]]`, never `[[people/alice-chen.md]]` — the `.md` makes it resolve to a nonexistent doc). A *bare* `[[note-name]]` with no folder is ambiguous (resolves only if GBrain's basename-globbing is on) — reserve it for Obsidian migration.

## Agent behaviors

- **Ingest from a meeting recorder.** If a meeting-recorder MCP (Granola, Fireflies, Circleback, tl;dv, Fathom, …) is registered alongside `open-knowledge`, pull recent meetings and write each into `meetings/`. Address each as `meetings/<source>-<source_meeting_id>` so re-syncing a meeting updates it in place instead of creating a duplicate. Normalize whatever the recorder returns (Granola's Me/Them streams, a bot's speaker turns) into notes plus the verbatim transcript; do NOT rewrite the transcript. This works the same on demand (you ask) or unattended (a scheduler asks) — the recorder is bring-your-own and interchangeable.
- After a meeting note lands, extract entity mentions and append timeline bullets to each referenced dossier (cite the meeting by markdown link). Stub any mentioned entity not yet captured.
- Treat `originals/` as authoritative (the user's own words, not inferences).
- Surface entity-to-entity edges (person ↔ company, concept hubs) when both ends exist.

## gbrain CLI (optional)

This pack ships the Markdown half (folders + templates + this skill); OK is the cockpit/editor/review layer. If the external `gbrain` CLI is installed (`~/.gbrain/`), it adds scheduled enrichment: `gbrain dream` (nightly maintenance), `gbrain briefing`, `gbrain soul-audit`, and `gbrain import`/`gbrain sync --repo` for DB-backed indexing. The root files (`USER.md`, `SOUL.md`, `ACCESS_POLICY.md`, `HEARTBEAT.md`) are read by those skills; fill them in by hand or via `gbrain soul-audit`. None of it is required to use the vault — interop is plain Markdown + Git.

## Templates

Create with `write({ document: { path: "<path>", template: "<name>" } })`. Templates carry the structure (including the compiled-truth / `--- timeline ---` separator) plus short inline reminders at the point of use; this skill holds the full convention, so prefer it as the canonical reference if the two ever disagree.
