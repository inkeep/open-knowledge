---
name: writing-workflow
description: "How to work in a Writing Pipeline project (the `writing-pipeline` starter pack): a three-stage drafting flow, ideas → drafts → published. Read when the project has these folders, OR when asked to capture an idea, start or revise a draft, review a piece before it ships, or publish it. Carries the stage flow and review behaviors so that guidance does not live inside template bodies or folder descriptions. Complements the platform `open-knowledge` skill; does not replace it."
compatibility: "Claude Code, Claude Desktop, Claude Cowork, Claude.ai web. Requires OpenKnowledge MCP server. Installed project-local by `ok seed --pack writing-pipeline`."
metadata:
  pack: "writing-pipeline"
  author: "Inkeep"
  repository: "https://github.com/inkeep/open-knowledge-skills"
---
# Writing Pipeline pack — how to work here

A lean three-stage flow for short-to-medium-form writing (essays, newsletters, blog posts).

> This skill is pack guidance. The platform `open-knowledge` skill (read/write/preview/linking/grounding rules) still governs every markdown operation — this layers the drafting flow on top.


```
ideas/      one-line premises, captured before they fade
   ↓ commit to writing it
drafts/     active prose; CRDT history covers revisions (no named-revision folders)
   ↓ ship
published/  shipped work; treat as immutable
```

## Per-folder rules + agent behaviors

- **`ideas/`** — premises, headlines, fragments. Kept short on purpose; not a draft folder. Promote into `drafts/` when you commit to the piece. *Agent: review ideas idle more than 30 days and surface them to park or promote.*
- **`drafts/`** — active prose. Frontmatter tracks `status: drafting/review`, word count, parent idea. *Agent: review drafts idle more than 14 days; for drafts in review, suggest publication targets based on `target_form`. If a piece needs research notes, create `drafts/<slug>/research/` on demand rather than a top-level folder.*
- **`published/`** — shipped work; carries `published_at`, `canonical_url`, `channel`. Treat as immutable; to revise, copy to a new draft. *Agent: on publish, auto-fill `canonical_url` when a Substack / Ghost / Mirror URL is pasted into the file.*

## Templates

Create with `write({ document: { path, template: "<name>" } })`. Templates carry only structure; section meaning lives here, not in the document body.
