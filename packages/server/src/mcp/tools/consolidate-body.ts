/**
 * `consolidate` MCP workflow tool — promote research findings into a canonical
 * article inside the project's content directory.
 *
 * Principle: canonical, not provisional. Consolidation is a deliberate step
 * taken after research has stabilized and a team has made decisions. The
 * output is the source of truth for future agents — not a snapshot of
 * uncertainty.
 *
 * Relationship to other workflow tools:
 *   - `ingest`     — captures raw external sources (no analysis)
 *   - `research`   — synthesizes provisional findings from sources (analysis, uncertain)
 *   - `consolidate` — promotes research + sources into canonical articles (analysis, decided)
 */

import { OK_DIR } from '@inkeep/open-knowledge-core';

export function buildConsolidateBody(topic: string, contentDir: string): string {
  return `Promote existing research on this topic into a canonical article inside the project content directory. **Canonical, not provisional** — the output is the source of truth for future agents.

Topic: ${topic}

The content directory for this project is **\`${contentDir}\`** (from \`${OK_DIR}/config.yml\`).

## STOP gate: has a decision actually been made?

Consolidation is **promotion, not creation**. If the team hasn't decided, the resulting "canonical" article lies about the team's state of understanding — future agents read it, act on it, and the false certainty compounds.

Before any write, confirm out loud with the user:

- **What is the actual decision?** (e.g., "We chose Yjs for CRDT" — not "Yjs is one option")
- **What alternatives were considered and rejected?** (these go in "Alternatives considered," not as equals)
- **What's the rationale the team used?** (not your reconstruction from sources)

If the decision is still open, **do not consolidate**. Return and tell the user: "The research is still provisional. When the team decides, re-invoke \`consolidate\` with the outcome." Then stop.

## When to use this workflow

- A team has made a decision after research and wants the outcome committed as canonical knowledge
- You want to compact several provisional research notes into one authoritative article
- A developer asks to "consolidate" or "finalize" the knowledge on a topic

Do NOT consolidate when:
- The team has not actually decided (the output would be misleading — keep it as research)
- You have not read the underlying sources (the output would lack evidence)

## Principle: canonical, not provisional

A consolidated article is the **source of truth**. Agents reading it should not need to dig further for context — it should stand on its own. That means:

- Clear, direct statements (no "tentative", no "initial findings")
- Decisions stated as decisions, not options
- Rationale explained so future readers understand the why
- Trade-offs acknowledged but framed against the chosen path, not as a menu
- Evidence linked but not the whole story — this article is the destination, not a trail

## Steps

### 1. Load the research + sources

Locate research articles on this topic:

- Use \`exec("grep -rn <topic-keyword> ${contentDir}")\` to find prior research, or \`exec("ls <research-folder>")\` if the project groups research in a known location
- Read each research article fully via \`exec("cat <path>")\` (rich enrichment gives frontmatter + shadow-repo activity + project git history + backlinks)
- Follow its \`sources:\` frontmatter list — read every referenced source file
- Also read any existing canonical article on the topic — if one already exists, you may be **updating** it rather than creating a new one

If there is no research to consolidate, stop. Consolidation is promotion, not creation. Run \`research\` first.

### 2. Re-confirm the decision (you already ran the STOP gate above)

You already confirmed the decision at the STOP gate at the top of this workflow. This step is a brief re-check after loading the research in Step 1 — occasionally the research surfaces something that makes the "decision" look less decided than the user initially claimed (e.g., an un-rebutted open question, an alternative they forgot about). If the loaded research reveals that, pause and re-confirm with the user before writing.

### 3. Write the canonical article

**Persist as you go (MUST).** For a large consolidation drawing on several research docs, create the article skeleton — frontmatter + the headings below — first, then \`edit\` each section in as you finish it; don't hold the whole synthesis in context for one final write. A rate limit or crash mid-synthesis then costs you one section, not the entire article. (The OK skill's §Writing carries this rule for all long-running work: the knowledge base is your checkpoint.)

Save inside the content directory (\`${contentDir}\`). Path convention depends on the project:

- If the project uses the three-tier lifecycle (external-sources → research → articles), save under an \`articles/\` folder relative to the content dir, grouped by topic subfolder when the area is broad (e.g., \`articles/editor/crdt-architecture.md\`)
- If the project has an existing canonical-docs layout (\`docs/\`, \`guides/\`, etc.), save there in a location that matches the project's conventions
- Ask the user when the canonical location is ambiguous

Frontmatter:

\`\`\`yaml
---
title: Descriptive title
description: One-line summary of what this article covers
status: canonical
date: YYYY-MM-DD
tags:
  - topic-tag
supersedes:
  - <path-to-research-article>.md
---
\`\`\`

Structure:

\`\`\`markdown
## Summary

[One paragraph: what the decision is and why. A reader who reads only this paragraph should know the outcome.]

## Context

[What problem does this solve? What constraints shaped the decision?]

## Decision

[The chosen approach, stated directly. Not "we recommend" — "we chose".]

## Rationale

[Why this path over alternatives. Grounded in the constraints from Context.]

## Trade-offs

[What we gave up by choosing this path. Frame against the chosen decision, not as a menu.]

## Alternatives considered

[Briefly: what else was on the table, why it was rejected. Link to the research article for deeper analysis.]

## Implementation notes

[How this gets realized in the codebase — key files, patterns, gotchas.]

## Further reading

[Links to research articles and external sources for readers who want the trail.]
\`\`\`

### 4. Link aggressively

Canonical articles are destinations — they should be **linked heavily from everywhere they're relevant** and link **out to every related page** themselves. Underlinked canonical articles lose most of their value.

- **Inside this article:** every noun-phrase that names another document (other canonical articles, related research, external-source pages, sibling topics) should be a standard markdown link \`[text](./relative/path.md)\`, not plain prose. (Wiki-link syntax \`[[Page]]\` is still parsed for legacy content but no longer the default; matches the OK skill guidance.)
- **Every link must resolve.** Only link to docs that exist. If you mention a concept that *should* have its own page but doesn't yet, do NOT emit a broken link — either create that page in this pass, or record it as a tracked task (\`TaskCreate\` / your host's task tool; if the host has none, tell the user) and leave the mention as plain prose. A broken link is debt, not a to-do marker.
- **Update neighbors.** After writing, find 2–3 closely-related existing pages (via \`exec("grep -rn <topic> ${contentDir}")\`) and add a link to the new article from each — usually under a "See also" section or inline where the new article is relevant. This makes the article discoverable via backlinks, not just by remembering the path.
- **Link to the sources and superseded research** from "Further reading" — readers who want the trail can follow.

### 5. Supersede the research

Add a \`supersedes:\` list in the new article's frontmatter pointing at the research article(s) it consolidates. This creates an audit trail.

Do NOT delete the research articles — they remain as historical context for how the decision was reached. Edit their frontmatter to add:

\`\`\`yaml
superseded_by: <path-to-new-canonical-article>.md
\`\`\`

### 6. Verify

- File exists at the chosen path under the content directory
- Has \`status: canonical\` frontmatter
- Lists the research articles it supersedes
- Research articles updated with \`superseded_by\` pointer
- \`exec("ls <target-dir>")\` shows the new file

## Non-goals

- **Don't consolidate research that hasn't reached a decision** — the article would misrepresent the team's actual state of understanding
- **Don't delete research articles** — they are the trail; keep them with a \`superseded_by\` marker
- **Don't rewrite research prose verbatim** — canonical articles have a different voice (direct, decided) than research (exploratory, provisional)
- **Don't skip the supersedes / superseded_by links** — the audit trail matters for future readers
`;
}
