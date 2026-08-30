---
name: okf-knowledge-base
description: "Open Knowledge Format (OKF) v0.2 guidance. Use when creating, reading, reviewing, or maintaining an OKF bundle; responding to OpenKnowledge `okf` plugin warnings; or choosing types, provenance, links, indexes, or logs."
compatibility: "Any agent host with the OpenKnowledge MCP server configured. The optional `okf` plugin provides continuous conformance feedback."
# This skill may live inside an OKF bundle, so it carries the required type.
type: Document
metadata:
  plugin: "okf"
  author: "Inkeep"
  repository: "https://github.com/inkeep/open-knowledge-skills"
---
# Open Knowledge Format (OKF)

[OKF v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md) is a portable format for agent-readable knowledge: Markdown files, YAML frontmatter, and standard links. The `/open-knowledge` skill governs tool use; this skill covers OKF semantics.

## Core rules

- A bundle is a directory tree of `.md` files. Each non-reserved file is one concept; its path without `.md` is its ID.
- Every concept needs parseable frontmatter with a non-empty string `type`. No other field is always required.
- Types are an open vocabulary. Consumers must accept unfamiliar types and metadata.
- Use standard Markdown links for portable relationships. Broken links and a missing index are allowed.
- `index.md` and `log.md` are reserved at every level. Use lowercase filenames.
- An `index.md` normally has no frontmatter; only the root index may declare `okf_version: "0.2"`.
- A `log.md` is newest-first; entry headings begin with an ISO date — `## YYYY-MM-DD: Summary` (the summary after the date is optional; a bare `## YYYY-MM-DD` is equally conformant).
- OKF consumers read `.md`, not `.mdx`.

## Authoring judgment

- Make each concept the smallest useful link or citation target. Choose a stable, descriptive type; `Document` is only a generic fallback.
- Do not invent facts, relationships, resources, sources, verification, or history. Missing knowledge is better than false structure.
- Use `title`, `description`, `resource`, and `tags` only when they add real information.
- Record provenance in `sources`. Join claim-level citations with matching `sources[].id` and Markdown footnotes.
- Keep authorship and verification separate: `generated` says who produced content; `verified` says who confirmed it. Use exact lowercase `human:` and `process:` prefixes when applicable.
- Write every provenance timestamp as an ISO 8601 datetime with an explicit UTC offset (`stale_after: 2026-12-31T00:00:00Z`), never a bare date and never an offsetless time. This covers `generated.at`, `verified[].at`, `stale_after`, `sources[].last_modified`, and both `usage_window` bounds. A `log.md` entry heading is different: it stays a plain `YYYY-MM-DD` date.
- Treat `status: deprecated` and expired `stale_after` values as trust signals, not validation errors.
- For `type: Attested Computation`, follow the declared runtime and parameters. Do not rewrite the sanctioned computation.

## Read and maintain a bundle

- Start with the nearest `index.md`, inspect frontmatter, then follow only relevant links.
- Prefer current, verified sources, but tolerate unknown types and incomplete links.
- If the bundle conflicts with an assumption, trust the bundle; if it is missing or inconsistent, say so.
- Write durable discoveries back to the relevant concept and authored enumerations.
- Add a truthful dated `log.md` entry after durable changes when the bundle uses a log.
- Read legacy `timestamp` and body citations, but prefer v0.2 `generated.at` and `sources` when updating a concept. Never invent provenance while migrating.

## OpenKnowledge's `okf` plugin

The optional project plugin provides continuous portability feedback without blocking writes:

- Write-time warnings and project audits check structure, frontmatter, reserved files, links, and `.mdx` use.
- `.ok/okf/*.schema.json` contains the precise field contracts. Read these generated files instead of guessing; do not edit them.
- Deterministic lint findings establish conformance. Agent judgment still establishes whether metadata is true and useful.
- Optional index generation maintains `index.md` files. Generated indexes are machine-owned: never edit them, because OpenKnowledge replaces their contents.
- `log.md` remains authored, not generated.

The plugin is off by default and each rule can be disabled. Its value is early warning when OpenKnowledge-native content would be misread by another OKF consumer.
