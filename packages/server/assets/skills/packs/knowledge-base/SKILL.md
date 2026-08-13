---
name: knowledge-base
description: "How to work in a Knowledge Base project (the `knowledge-base` starter pack). Read when the project has the three-layer source-grounded layout — `external-sources/` → `research/` → `articles/` — or when asked how this project is organized. Carries the layer model, per-folder rules, status flows, and log discipline so this guidance does NOT live inside template bodies or log.md. The three procedures live elsewhere: ingest in the platform `open-knowledge` skill, research and consolidate as their own sibling skills in this pack. Complements the platform `open-knowledge` skill; does not replace it."
compatibility: "Any agent host with the OpenKnowledge MCP server configured. Installed project-local by `ok seed --pack knowledge-base`."
metadata:
  pack: "knowledge-base"
  author: "Inkeep"
  repository: "https://github.com/inkeep/open-knowledge-skills"
---
# Knowledge Base pack — how to work here

This project uses the **source-grounded knowledge-base** layout. The whole point is a closed evidence loop: nothing canonical exists without a traceable chain back to a preserved source. This skill holds the workflow so the templates and `log.md` can stay clean — when you create a doc from a template you get structure, and the *how* lives here.

> This skill is pack guidance. The platform `/open-knowledge` skill (read/write/preview/linking/grounding rules) still governs every markdown operation — this layers the KB workflow on top.

## Link at creation

The user watches your build live — the editor follows the file you're writing, and the knowledge graph assembles on screen as pages get linked. No view management on your part; just author well: every page carries its links from the moment it's written (at minimum the hub/index page and its most related siblings — an unlinked page is invisible in the graph), and related pages share a `cluster:` frontmatter value (e.g. `cluster: architecture`) so the graph's cluster coloring makes the map read at a glance.

## The three layers

```
external-sources/   raw sources, saved verbatim     (produced by `ingest`)
      ↓ cite
research/           provisional analysis            (produced by `research`)
      ↓ promote
articles/           canonical, decided knowledge     (produced by `consolidate`)
```

The loop is **ingest → research → consolidate**, mapped to [Karpathy's three-layer knowledge-base pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Every downstream claim traces upstream to a preserved source. Cite local paths in `external-sources/`, never bare web URLs — the KB must survive link rot.

Karpathy's insight: "The tedious part of maintaining a knowledge base is not the reading or the thinking — it's the bookkeeping." Humans abandon wikis because maintenance costs exceed perceived value. These procedures exist so an agent can do the bookkeeping (fetching, summarizing, cross-linking, superseding) without fatigue. Skipping the cross-linking, supersedes chains, or raw-source preservation is what turns a useful wiki back into an abandoned one.

## The three procedures

Each layer has a full, STOP-gated procedure, and each ships as its own skill so it loads only when the work calls for it. Execute the procedure yourself with the OK verbs — these are your **default move over a bare `write`** when the work fits a layer.

| Procedure | Where it lives | When |
| --- | --- | --- |
| ingest | Platform `/open-knowledge` skill (`references/ingest-and-sources.md`) — its Grounding rule depends on it everywhere, so it ships with every project, not just this pack. | Preserve a shared URL / PDF / file verbatim, OR you fetched a URL to ground a KB claim (binary sources preserved, not scraped). |
| research | Sibling skill `/research-with-sources` | Investigate / compare / synthesize multiple sources → `status: provisional` article + `sources:`. |
| consolidate | Sibling skill `/consolidate-notes` | A decision was actually made → commit canonical source-of-truth with a `supersedes:` chain. |

Typical day-2 flow: user shares a URL → **ingest** (preserve) → user asks "now research this" → **research** (provisional article, ingesting more sources as needed) → decision lands → **consolidate** (canonical article, supersedes the research).

**Don't chain silently.** After ingest, ask whether to proceed to research. After research, let the user decide whether the findings are ready to consolidate. Each procedure completes on its own terms — the user drives the transitions.

**Autonomy gates vs session-level autonomy.** A procedure's STOP gates (research's scoping gate, consolidate's decision-confirmation gate) are NOT overridden by session-level "work without stopping for clarifying questions" hints. Those hints cover trivial back-and-forth ("which file did you mean?"); the gates exist for one-way-door decisions. When in doubt, the gate is authoritative.

## Per-folder rules

**`external-sources/`** — Raw sources saved verbatim, not just cited: the actual fetched text of URLs, extracted text of PDFs, copies of referenced files. Each file's frontmatter carries the original URL, access date, and any author/publisher metadata. Produced by the ingest procedure (applies whether the user shared the URL or you fetched it yourself to ground a claim). Immutable after capture — update only to refresh a stale fetch. **No analysis here**; that belongs in `research/`.

**`research/`** — Provisional analysis synthesizing external sources. Produced by the `/research-with-sources` skill. Every factual claim cites a specific doc in `external-sources/` (or an inline URL if ingest was skipped); no unsourced assertions. Keep the `sources:` frontmatter list aligned with the docs actually linked in the body. Promote to `articles/` via the `/consolidate-notes` skill once the team decides the findings are stable.

**`articles/`** — Canonical knowledge, committed after a team decision. Produced by the `/consolidate-notes` skill. Carries a `supersedes:` chain tying back to the `research/` docs it replaces (which in turn cite `external-sources/`) so the full evidence chain is traceable without leaving the repo. Source-of-truth for the domain; update only when a new decision supersedes it.

## Status flow

| Layer | `status` | Set when |
|---|---|---|
| `research/` | `provisional` | created |
| `articles/` | `canonical` | promoted by consolidate after a decision |

When a new article supersedes an older one, add the older article's path to the new one's `supersedes:` list.

## Log discipline (MUST)

There is a `log.md` at the project root. **Append one dated entry after any turn that creates, edits, or restructures content** — one entry per turn, not per file. Silent edits break the audit trail.

Log: `ingest` runs (new sources), `research` / `consolidate` runs (provisional or canonical articles), direct `write` / `edit` / `move` / `delete` outside the three procedures, project-onboarding runs, folder restructures, and `.ok/config.yml` changes.

**Reference docs as markdown links, not bare paths** — `[path/to/doc](./path/to/doc.md)`, so the entry shows up in `links({ kind: "backlinks" })` for those docs. A bare path string does not register in the graph.

Entry shape:

```markdown
## YYYY-MM-DD: <short title>

- <what was done>
- Files touched: [doc-a](./path/doc-a.md), [doc-b](./path/doc-b.md)
- Sources ingested: [source-slug](./external-sources/source-slug.md)
- Open follow-ups: <topic-1>, <topic-2>
```

## Templates

Each folder has a starter template (`clip`, `research-log`, `article`). Create with `write({ document: { path, template: "<name>" } })`. Templates carry only structure (headings + frontmatter scaffold) — the meaning of each field and section is described above, not repeated inside the document body.
