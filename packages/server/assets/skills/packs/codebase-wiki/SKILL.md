---
name: codebase-wiki
description: "How to work in a Codebase Wiki project (the `codebase-wiki` starter pack): an agent-authored, source-grounded wiki of the surrounding codebase. Read when the project has a `wiki/` knowledge base with `architecture/`, `modules/`, `flows/`, `concepts/`, and `guides/` sections plus `wiki/OVERVIEW.md`, or when asked to generate or refresh a wiki of this codebase. Carries the per-folder rules and freshness + log discipline, summarizes the audience/depth knobs and source-reference convention, and bundles the full generate/refresh procedure in `references/`. Complements the platform `open-knowledge` skill; does not replace it."
compatibility: "Claude Code, Claude Desktop, Claude Cowork, Claude.ai web. Requires OpenKnowledge MCP server. Installed project-local by `ok seed --pack codebase-wiki`."
metadata:
  pack: "codebase-wiki"
  author: "Inkeep"
  repository: "https://github.com/inkeep/open-knowledge-skills"
---
# Codebase Wiki pack — how to work here

This project holds an **agent-authored wiki of a codebase** — DeepWiki, but living in the repo. A coding agent reads the source and writes a navigable, diagram-rich, source-grounded wiki as markdown under `wiki/`. It is version-controlled and diffable, private by default, human+agent co-editable, renders in OK's live preview, and doubles as durable grounding context for future agent sessions. There is no separate Q&A surface — Q&A is "the OK-grounded agent + `search`".

> This skill is pack guidance. The platform `open-knowledge` skill (read/write/preview/linking/grounding rules) still governs every markdown operation — this layers the wiki workflow on top.

## The shape

```
wiki/
  OVERVIEW.md     hub: what it is, a big-picture architecture diagram, a nav map to every section.
                  Frontmatter carries `profile` (audience/depth) + `source_commit` (freshness anchor).
  log.md          append-only generation / refresh audit trail
  architecture/   system boundaries, layers, subsystems, cross-cutting concerns + diagrams
  modules/        one page per package / module: purpose, entry points, key files, deps
  flows/          key end-to-end flows as sequence / flow diagrams + narrative
  concepts/       glossary: atomic pages for domain terms / core abstractions
  guides/         task-oriented "how / where do I change X" (filled at depth >= standard)
```

## Generating + refreshing

Don't free-hand it — read **[references/generate-and-refresh.md](references/generate-and-refresh.md)** and follow the phased, STOP-gated procedure. It auto-detects mode: a stubbed `OVERVIEW.md` (empty `source_commit`) → **generate** (survey → overview → architecture → modules → flows → concepts → link-graph audit); a stamped `source_commit` → **refresh** (diff `source_commit..HEAD`, update only affected pages, re-stamp).

**Two toolsets.** Read source code with NATIVE tools (`Read`/`Grep`/`Glob`/`Bash`) — OK MCP does not index non-markdown source. Author and audit the wiki with OK MCP verbs (`write`/`edit` for pages, `links`/`search` for the graph). Never hand-write wiki markdown with native `Write`/`Edit`.

## The two knobs

Two natural-language knobs, read from the user's request (e.g. "build the wiki, public and exhaustive") and recorded in `OVERVIEW.md` frontmatter (`profile: <audience>/<depth>`) so refreshes stay consistent:

- **`audience`** — `internal` (default) or `public`. `public` means polished prose, no secrets / internal infra / ticket numbers, and GitHub-URL source references.
- **`depth`** — `tour` | `standard` (default) | `exhaustive`. Scales coverage from OVERVIEW + architecture + top flows up through per-package module pages, concepts, and task guides.

[references/generate-and-refresh.md](references/generate-and-refresh.md) is the authoritative source for exactly how each knob shapes the output — read it before generating.

## Source-reference convention

- **Intra-wiki navigation** → OK doc links — they build the backlink / hub / orphan graph, so link liberally; density is how the wiki stays navigable.
- **Code references** → relative links + symbol code-spans (`internal`) or GitHub blob URLs (`public`). Source-file links stay out of the navigation graph (`links` tracks only `.md`/`.mdx` edges, so they never show as graph dead-links or orphans) — but a wrong-depth path still surfaces in the write/edit `brokenLinks` response (`no-such-file`, or `unresolvable` if it overshoots the content root), so count the `../` hops from the page's folder. Never invent paths — reference only files you actually read.

The full rules — the GitHub-URL / relative fallback, the `#Lxx` caveat, and the exact code-span shape — live in [references/generate-and-refresh.md](references/generate-and-refresh.md).

## Per-folder rules

**`architecture/`** — One page per architectural area (boundaries, layers, subsystems, cross-cutting concerns). Each: a `mermaid` system-context or component diagram, key components (with source refs), and the design decisions behind them. Uses the `architecture-page` template. At `depth: tour`, modules fold in here.

**`modules/`** — One page per package / module: purpose, responsibilities, public API / entry points, key files (linked per the convention), dependencies, and flows it participates in. Uses the `module-page` template. Skipped at `tour`; sub-module depth scales with the knob.

**`flows/`** — Key end-to-end sequences as `mermaid` sequence / flow diagrams + narrative. Uses the `flow-page` template; add a **Failure modes** section at `exhaustive`. Link every module and concept the flow crosses.

**`concepts/`** — Atomic glossary pages (one term each): definition, why it matters, where it lives in the code. Uses the `concept-page` template. Keep small and densely cross-linked so each concept becomes a hub.

**`guides/`** — Task-oriented "how / where do I change X" walkthroughs: goal, steps, relevant code, gotchas. Uses the `guide-page` template. Populated at `standard`, rich at `exhaustive`, thin/empty at `tour`.

## Freshness discipline (MUST)

`OVERVIEW.md` frontmatter carries `source_commit` — the git HEAD the wiki was last generated/refreshed against. It is the freshness anchor: refresh mode diffs `source_commit..HEAD` to update only the affected pages, then re-stamps it. **Always re-stamp `source_commit` after a generate or refresh run** — a stale anchor silently breaks incremental refresh.

## Log discipline (MUST)

`wiki/log.md` is an append-only audit trail. **Append one dated entry per generation or refresh run** — one per run, not per page. Reference touched pages as markdown links (`[Server](./modules/server.md)`) so they register in the backlink graph. Entry shape:

```markdown
## YYYY-MM-DD: <generate | refresh>

- Profile: <audience>/<depth>
- source_commit: <short-sha> (was <prev-sha> on refresh)
- Coverage: <sections / packages written or updated>
- Pages: [Overview](./OVERVIEW.md), [Server](./modules/server.md), ...
```

## Templates

Each folder ships a starter template (`architecture-page`, `module-page`, `flow-page`, `concept-page`, `guide-page`). Create with `write({ document: { path, template: "<name>" } })`. Templates carry only structure (headings + frontmatter scaffold); what each section is for is described above and in [references/generate-and-refresh.md](references/generate-and-refresh.md), not repeated inside document bodies.
