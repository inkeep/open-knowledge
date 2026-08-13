---
name: software-lifecycle
description: "How to work in a Software Lifecycle project (the `software-lifecycle` starter pack): proposals → decisions → specs → postmortems, plus guides. Read when the project has these folders, or when asked how this project is organized. Carries the doc lifecycle, status flows, and per-folder agent behaviors so that guidance does not live inside template bodies or folder descriptions. The five workflows — frame a proposal, write a spec, record a decision, write a postmortem, review a design — each ship as their own sibling skill in this pack. Complements the platform `open-knowledge` skill; does not replace it."
compatibility: "Any agent host with the OpenKnowledge MCP server configured. Installed project-local by `ok seed --pack software-lifecycle`."
metadata:
  pack: "software-lifecycle"
  author: "Inkeep"
  repository: "https://github.com/inkeep/open-knowledge-skills"
---
# Software Lifecycle pack — how to work here

This project holds the doc lifecycle for an engineering team or OSS project. The flow is **proposals → decisions → specs → postmortems**, with **guides** as the how-to bucket. This skill holds the workflow so templates and folder descriptions stay clean.

> This skill is pack guidance. The platform `/open-knowledge` skill (read/write/preview/linking/grounding rules) still governs every markdown operation — this layers the lifecycle conventions on top.

## The flow

```
proposals/    in-flight RFC-shape design proposals
   ↓ accepted
decisions/    frozen ADRs (the record of what was decided)
   ↓ derived
specs/        implementation specs for accepted proposals
   ↓ when things break
postmortems/  blameless incident write-ups
guides/       how-to / onboarding / runbooks (referenced throughout)
```

## Per-folder rules + agent behaviors

**`proposals/`** — One file per proposal (`0001-feature-name.md`). Status flows `draft → fcp → accepted/rejected`. An accepted proposal graduates to a record in `decisions/`. Shape: Motivation / Design / Drawbacks / Alternatives / Unresolved questions. *Agent: when a proposal sits at `status: draft` more than 14 days, surface it for the author to advance, park, or close.*

**`decisions/`** — Architecture Decision Records (MADR / Nygard shape). Frozen once accepted. One file per decision (`NNNN-title.md`); status `proposed/accepted/deprecated/superseded`. A new decision that supersedes an older one links back via `Supersedes:`. *Agent: on a new decision, scan existing records touching the same subsystem and surface `Supersedes:` candidates before commit.*

**`specs/`** — Implementation specs derived from accepted proposals. Prefer the `github/spec-kit` shape: one folder per spec (`specs/NNN-name/`) with `spec.md` + `plan.md` + `tasks.md` (the pack ships all three templates). References the parent proposal. *Agent: when a spec moves to `status: shipped`, suggest a postmortem template if the owner reports an incident in the spec's subsystem.*

**`postmortems/`** — Blameless incident write-ups, one file per incident (`YYYY-MM-DD-name.md`): Summary / Timeline / Root cause / What went well / Action items (Google SRE shape). *Agent: surface a `Related:` block linking prior postmortems that share subsystems.*

**`guides/`** — How-to guides, onboarding docs, and service-bound runbooks (Diátaxis how-to). Ships `guide`, `onboarding-guide`, and `runbook` templates. Carries `last_verified` so stale guides surface in periodic reviews. *Agent: when a postmortem is published, scan its action items for guide-shaped follow-ups and stub a guide pre-filled with the symptom and timeline excerpt.*

## The five workflows

Authoring in this project is procedural, not conventional. Each workflow ships as its own skill so it loads only when the work calls for it — reach for the one that matches the task rather than writing into a folder from scratch.

| Workflow | Sibling skill | When |
| --- | --- | --- |
| Frame a proposal | `/frame-a-proposal` | A change needs designing and arguing before anyone builds it. |
| Write a spec | `/write-a-spec` | An accepted proposal needs scoping into an implementable spec. |
| Record a decision | `/record-a-decision` | A decision was actually made and needs its context and consequences preserved. |
| Write a postmortem | `/write-a-postmortem` | An incident happened and the team needs a blameless write-up. |
| Review a design | `/review-a-design` | An existing proposal, spec, or decision needs pressure-testing for soundness. |

## Templates

Create docs with `write({ document: { path, template: "<name>" } })`. Templates carry only structure (headings + frontmatter scaffold); what each section is for is described above, not repeated in the document body.
