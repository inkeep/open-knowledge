---
name: okf-knowledge-base
description: "How to work in an OKF starter project (the `okf` starter pack): a knowledge base that is conformant with Google's Open Knowledge Format (OKF) from commit one — `concepts/`, `references/`, `notes/`, a reserved `index.md` navigation hub, and a reserved `log.md` change history. Read when the project has these folders plus reserved files, OR when asked whether a document is OKF-conformant, or to add a document to an OKF knowledge base. Carries the OKF conventions (non-empty `type` on every non-reserved doc; reserved files carry no frontmatter) as guidance, not enforcement. Complements the platform `open-knowledge` skill; does not replace it."
compatibility: "Any agent host with the OpenKnowledge MCP server configured. Installed project-local by `ok seed --pack okf`."
# `type` keeps this skill doc OKF-conformant: it installs as project-local
# markdown under each detected agent's skills dir, which OK admits into the
# content corpus — so without a non-empty `type` it would be a non-reserved
# doc that violates the pack's own "every non-reserved doc has a `type`" contract.
type: Document
metadata:
  pack: "okf"
  author: "Inkeep"
  repository: "https://github.com/inkeep/open-knowledge-skills"
---
# OKF starter pack — how to work here

This project was scaffolded to be conformant with **Google's Open Knowledge Format (OKF) v0.1** from the first commit — markdown + YAML frontmatter, a standard-markdown link graph, and two reserved files. Conformance here is pre-populated, **not enforced**: OpenKnowledge's native frontmatter schema stays open-shaped, nothing is linted, and you are free to author however you like. This skill explains the conventions so the kit stays OKF-portable as it grows.

> This skill is pack guidance. The platform `/open-knowledge` skill (read/write/preview/linking/grounding rules) still governs every markdown operation — this layers the OKF conventions on top.

## The one rule (keep the kit conformant)

OKF requires exactly one thing of every **non-reserved** document: a **non-empty `type`** in its frontmatter. That is the whole conformance contract for your content.

- The value is **yours to choose** — `concept`, `reference`, `note`, `person`, `event`, anything that fits. There is no blessed taxonomy.
- `Document` is a fine **generic fallback** when nothing more specific fits (it is just a non-empty value, not a special keyword).
- The folder templates already set a sensible `type` per section — create docs with `write({ document: { path, template: "<name>" } })` and you inherit it.

## Folders

- **`concepts/`** — durable ideas and definitions, one file per concept (`type: concept`).
- **`references/`** — external sources and citations you rely on (`type: reference`).
- **`notes/`** — working notes and observations (`type: note`).

Link liberally with **standard markdown links** (`[text](./path.md)`) — the value is the graph that emerges from the links between typed docs, and standard links keep that graph portable to any OKF consumer. (OpenKnowledge also accepts `[[wiki-link]]` shorthand as a native superset and preserves it byte-for-byte — but seeded content uses standard links so the bundle is conformant as-is.)

## Reserved files (keep them frontmatter-free)

OKF reserves two lowercase files at the project root. **Neither carries frontmatter** — adding any frontmatter to a reserved file breaks OKF conformance.

- **`index.md`** (OKF §6) — the navigation hub: a link-list to the key docs and sections. Keep it current as you add important docs; it is how a reader (or a strict OKF consumer) finds their way in.
- **`log.md`** (OKF §7) — the change history: newest-first dated entries shaped `## YYYY-MM-DD: <summary>`. Add an entry whenever you create, edit, or restructure content. The seed ships a prose instruction documenting this format — add your first dated entry on your first edit.

The tool does not keep these live for you (that would be enforcement) — maintaining them is part of authoring here.

## What stays OKF-portable

- Every non-reserved doc has a non-empty `type`. ✅
- `index.md` / `log.md` stay lowercase and frontmatter-free. ✅
- Links use standard markdown / wiki-link syntax. ✅

If you ever want to hand this knowledge base to a strict OKF consumer, those three habits are all it takes.
