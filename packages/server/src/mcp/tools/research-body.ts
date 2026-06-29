
import { OK_DIR } from '@inkeep/open-knowledge-core';

export function buildResearchBody(topic: string, contentDir: string): string {
  return `Conduct **evidence-driven research** on this topic and produce a provisional research article in the OpenKnowledge content directory. This workflow mirrors the discipline of the \`eng:research\` skill, scoped to OpenKnowledge's wiki-provisional layer.

Topic: ${topic}
Content directory: \`${contentDir}\` (from \`${OK_DIR}/config.yml\`)

## Three paths

- **Path A — Research article (DEFAULT):** Persistent provisional article under the content directory with an inline \`sources:\` frontmatter list pointing at raw sources captured via \`ingest\`. This is the default unless the user explicitly opts out.
- **Path B — Direct answer:** Findings delivered in conversation only. **Requires explicit user request** (e.g., "just tell me", "no doc needed", "quick answer").
- **Path C — Update existing research:** Surgical additions/corrections to an existing research article. Triggered when the user references an existing research doc or says "update/refresh/extend."

Path A is the default because wiki-provisional articles compound over time; spoken answers do not.

## Autonomy mode

| Mode | Behavior | How entered |
|---|---|---|
| **Supervised** (default) | Stop at the scoping gate for user rubric confirmation. Route coverage decisions interactively. | Default when a user drives the session. |
| **Headless** | Auto-confirm rubric after proposing it. Auto-select routing decisions. Skip interactive prompts. All other gates (scan, analysis, validation, grounding) still enforced. | Explicit "don't wait for me", "just proceed", "run headless" — or non-interactive container environments. |

In headless mode, propose the rubric AND proceed immediately. Mark the Scoping task completed after proposing.

---

## Mandatory execution order

⛔ **Hard gates — do NOT skip ahead.** If you find yourself about to run a \`WebFetch\` or \`WebSearch\` without completing Steps 0-2, STOP — you skipped a gate.

1. **Step 0: Create workflow checkpoint tasks** — ALWAYS the first action.
2. ⛔ **Step 1: Scan existing coverage + route** — scan the content directory for prior work; classify coverage; present options before new research begins.
3. ⛔ **Step 2: Collaborative scoping** — propose a research rubric. In Supervised mode, STOP and WAIT for user confirmation before any external fetch.
4. **Step 3: Capture raw sources via \`ingest\`** — preserve before analyzing.
5. **Step 4: Read + analyze** — 3P-external by default; 1P-codebase only when user explicitly requests.
6. **Step 5: Write the research article** — Path A only.
7. **Step 6: Link aggressively + file valuable Q&A back**.
8. **Step 7: Validate** — frontmatter, dead-links, sources alignment.
9. **Step 8: Recap + follow-up directions**.

**Path B shortcut:** If the user explicitly requested a direct answer in Step 2, skip Steps 5, 7. Steps 0, 1, 3, 4, 6, 8 still apply (evidence discipline doesn't relax just because output is conversational).

---

## Report framing default: external / third-party sources

Research articles default to **3P/external framing** — investigating third-party topics, technologies, concepts, public repos, papers, official docs. **Do NOT mix the user's own codebase analysis into the research article unless the user explicitly asks.** Mixing drifts findings from factual synthesis toward opinion-forming applied to the company, reducing factual fidelity.

- **Default:** external sources (web, OSS repos, papers, official APIs).
- **Exception:** if user asks "research how our X compares to Y" or "include our codebase," include it — but clearly separate 1P observations from 3P findings in the article so a reader can distinguish externally-verifiable facts from company-specific takes.

---

## Persist as you go — the article IS your checkpoint

⛔ **PERSIST AS YOU GO — crash-safe checkpoint rule.** The single most expensive failure this workflow has produced is completed research lost to a mid-session rate limit or crash — analysis held in context, never written, discarded when the session died. The user paid for work that vanished. The knowledge base is the checkpoint; two rules make every step crash-safe:

- **\`ingest\` each source the moment you fetch it (Step 3), one at a time** — never fetch all sources and ingest them in a trailing batch. An ingested source survives a crash; a fetched-but-unwritten one does not.
- **Create the article skeleton early and fill it section-by-section as you read (Steps 4–5), not in one final write at the end.** After you analyze each source, \`edit\` its findings into the article before moving to the next. A crash after reading five of eight sources then leaves five sections safely in the KB; you resume by reading the partial article back, not by re-running the whole sweep.

Structured notes that live only in your context are not persisted work. If a finding is worth keeping, it belongs in an ingested source or in the article — written, not held.

---

## Step 0: Create workflow checkpoint tasks

⛔ **ALWAYS THE FIRST ACTION.** Before any read, any scan, any fetch — create tasks. They persist across context compaction, make skipped steps immediately visible, and show progress to the user.

Create these tasks via your host's task system (\`TaskCreate\` in Claude; equivalent elsewhere):

\`\`\`
TaskCreate: "Research: Scan existing coverage + route"        → start as in_progress
TaskCreate: "Research: Collaborative scoping — rubric gate"   → pending, blocked by #1
TaskCreate: "Research: Capture sources via ingest"            → pending, blocked by #2
TaskCreate: "Research: Read + analyze"                        → pending, blocked by #3
TaskCreate: "Research: Write the research article"            → pending, blocked by #4
TaskCreate: "Research: Link aggressively + file Q&A back"     → pending, blocked by #5
TaskCreate: "Research: Validate (frontmatter + dead-links)"   → pending, blocked by #6
TaskCreate: "Research: Recap + follow-up directions"          → pending, blocked by #7
\`\`\`

Use \`addBlockedBy\` to enforce ordering. As you complete each step, mark the task \`completed\` and the next task \`in_progress\`.

**Path B variant:** If scoping determines Path B (direct answer), mark tasks #5 and #7 as \`deleted\` — they don't apply.

**Path C variant:** If Step 1 routes to Path C (update existing), mark tasks #3 and #5 as \`deleted\` (ingest is usually unnecessary and no new article is created) and rename task #4 to "Research: Read existing article + diff deltas."

Why tasks: the observed failure mode is the agent jumping straight to \`WebFetch\` without scanning or scoping. Tasks make the skipped gates obvious to the user mid-session.

---

## Step 1: Scan existing coverage + route

⛔ **MANDATORY FIRST RESEARCH STEP.** Before any external fetch, scan what the knowledge base already holds.

### Phase 1: Check existing knowledge

**If the user explicitly references an existing research article** (names it, links it, says "update/refresh/extend"):
→ Skip the scan. Go directly to **Path C**.

**Otherwise, always scan first:**

1. \`exec("grep -rln <topic-keyword> ${contentDir}")\` — returns matching files with frontmatter enrichment so you can judge relevance without opening each.
2. \`exec("ls ${contentDir}")\` — surfaces folder layout and most-recent-updated doc per subdir.
3. For the **1–3 most promising candidates**, \`exec("cat <path>")\` — returns full doc + frontmatter + backlinks + recent shadow-repo activity.

Classify:

| Coverage | What it means | Route to |
|---|---|---|
| **Fully covered** | An existing article directly answers the question with evidence | Present findings; offer to elaborate, verify, extend, or explicitly new-report |
| **Partially covered** | Related research exists; the specific question is a natural extension | Offer: (1) extend existing via Path C, (2) new article via Path A |
| **Not covered** | No meaningful overlap | Proceed to Path A (default) or Path B |

### Phase 2: Present routing options (Supervised mode)

**Fully covered:**

> "We already have research on this in \`<path>\`. Here's what it found: [2–4 key findings]. Options: (1) use as-is, (2) verify / refresh (article is from [date]), (3) extend on [specific dimension], (4) new angle if this is a different framing."

Let the user choose. Do NOT start new research when existing research already answers the question.

**Partially covered:**

> "We have related research in \`<path>\` covering [scope]. Your question about [topic] isn't directly answered but it's a natural extension. Options: (1) extend existing via Path C, (2) start new article via Path A. I'd recommend [1 or 2] because [reason]."

**Not covered:**

Proceed to Step 2 (scoping). If the user asked for a quick answer, flag that Path B may apply and confirm in Step 2's scoping exchange.

**Headless mode:** auto-select — fully-covered → proceed to new article on the specific angle the caller requested; partially-covered → start new article; not-covered → Path A.

### Scan discipline

- **Do not skip the scan.** Even 30 seconds of grep + cat prevents duplicate research AND gives the user context on what's already known.
- **Bias toward extending (Path C)** when topics are semantically coherent — one comprehensive article beats two overlapping ones.
- **Bias toward new (Path A)** when framing, audience, or primary question differs materially.

---

## Step 2: Collaborative scoping (Supervised STOP gate)

⛔ **HARD GATE (Supervised mode).** Do NOT start external research until the user confirms the rubric. After proposing it, **STOP and WAIT for user response.** Only then mark the Scoping task completed.

**In headless mode:** propose the rubric AND proceed. Mark the task completed after proposing.

### Propose a rubric

Return this structure to the user:

\`\`\`
## Proposed research rubric

**Question:** [narrowed from the original topic — concrete, answerable, bounded]

**Dimensions to investigate:** [3–7 facets]
1. [Dimension 1]
2. [Dimension 2]
...

**Candidate sources:** [3–8 initial guesses]
- [Source 1 — why it's relevant]
- [Source 2 — why it's relevant]
...

**Success criteria:** [2–3 concrete outcomes — "the article cites X authoritative sources", "open questions are marked explicitly", etc.]

**Output format:** Path A (article) | Path B (direct answer) | Path C (update \`<existing-article>\`)
\`\`\`

### Scoping discipline

- If the original topic is vague ("research LLM agents"), narrow it before fetching: "What specific agents? For what decision? Over what time horizon?"
- If the topic is itself a URL, treat that URL as the anchor and widen to 2–4 adjacent authoritative sources.
- Name the **decision** this research informs. Research without a decision context meanders.
- Do not over-specify the rubric — the user can adjust. Propose, don't prescribe.

---

## Step 3: Capture raw sources via \`ingest\`

For each relevant URL, paper, or document in the confirmed rubric, invoke the \`ingest\` tool. **Typical research pulls 3–8 sources.** Too few → thin synthesis. Too many → you'll be reading for the rest of the session.

- **Don't skip \`ingest\`.** Raw preservation separates capture from interpretation and makes research reproducible. An article without preserved sources is just opinion; an article with preserved sources is a trail someone else can follow.
- If a fetch fails for a source you specifically need, **stop and ask the user to paste it** — don't silently drop it. Write-time fabrication of missing evidence is the biggest failure mode.
- If \`ingest\` returns an obvious *summary* instead of the raw bytes (some LLM-backed fetch tools do this), note it and try a raw alternative (\`curl -sL <url>\`, or ask the user to paste).

---

## Step 4: Read + analyze

Read each ingested source carefully. Also load:

- **Existing canonical articles** on the topic — \`exec("cat <path>")\` (returns frontmatter + backlinks + shadow-repo activity).
- **Prior research** on adjacent topics — same: \`exec("cat <path>")\` for OpenKnowledge markdown.
- **Relevant source code** — ONLY if the user asked for 1P analysis. Use native \`Read\` for \`.ts\` / \`.js\` / etc.; \`exec\` for in-scope \`.md\` / \`.mdx\`.
- **Project context** — \`specs/\`, \`reports/\`, or wherever the project keeps design material.

Take structured notes:

- **Key claims** and their evidence — every claim needs a source you can point at
- **Trade-offs** between options
- **Contradictions** between sources — these are often the most valuable part of the article
- **Unknowns** and open questions — the boundary of what you know
- **Relevance** to the specific decision at hand

**Write these notes into the article as you take them, not after (MUST — see *Persist as you go* above).** Create the article skeleton — frontmatter + the Step 5 section headings — before you start reading, then \`edit\` each source's findings into the relevant section the moment you finish analyzing it. The "notes" ARE the article's Findings section in progress; don't hold them in context to transcribe in one pass at Step 5. A rate limit between here and Step 5 must not be able to discard analysis you've already done. By the time you reach Step 5 the article is mostly written, and Step 5 becomes finalize-and-polish.

### Grounding discipline

Every factual claim in the article must cite its source inline. No unsourced speculation. If you don't have evidence: (a) run another search and cite it, (b) mark inline \`(TODO: needs source)\`, or (c) don't write the claim. Never fabricate.

---

## Step 5: Write the research article (Path A only)

If you followed *Persist as you go*, the article already exists and is substantially filled from Step 4 — this step **finalizes** it (fill any remaining sections, tighten the recommendation, run the structure + validation checks below) rather than writing from a blank doc. **If it does not exist or is thin, and you are resuming after an interruption: \`exec("cat <path>")\` the partial article back first and fill only the missing sections** — and note that any Step 4 analysis that was never written to the KB was lost when the session broke, so re-derive only what's actually missing. Creating the doc from scratch here means the incremental rule was skipped; that's the failure mode, not the happy path.

Save a markdown document inside the content directory. Path convention:

- If the project adopted the three-tier lifecycle (external-sources → research → articles), save under \`<content-dir>/research/<slug>.md\`.
- If the project has an existing docs/reports/specs layout, match it.
- Large topics warrant a subfolder: \`research/<topic>/<subtopic>.md\`.

Filename: descriptive, kebab-case (\`crdt-alternatives-for-editor.md\`, \`llm-wikis-karpathy-pattern.md\`). No dates — dates go in frontmatter.

### Frontmatter

\`\`\`yaml
---
title: Descriptive title
description: One-line summary of the research question
status: provisional
date: YYYY-MM-DD
tags:
  - research
  - <topic-tag>
sources:
  - <path-to-ingested-source-1>.md
  - <path-to-ingested-source-2>.md
---
\`\`\`

### Structure

\`\`\`markdown
## Question

[What specific question does this research answer? Be precise.]

## Context

[Why does this matter? What decision does it inform? Who is the reader?]

## Findings

[Main findings organized by theme, option, or criterion. Every claim cites a source inline.]

### Theme / Option 1

- Pros — with evidence links
- Cons — with evidence links
- Evidence: [Source A](./external-sources/source-a.md), [Source B](./external-sources/source-b.md)

### Theme / Option 2

...

## Trade-offs

[What you gain vs. lose with each option. A comparison table often helps.]

## Open questions

[What you still don't know — candidates for further research, prototyping, or human-judgment decisions.]

## Tentative recommendation

[Your best guess, clearly marked as tentative. Explain the reasoning so a future reader can re-evaluate when new information arrives.]

## Further reading

[Links to the ingested sources + adjacent research + any canonical articles on the topic.]
\`\`\`

### Voice

- **Provisional, not canonical.** Use "tentative", "initial findings", "based on current understanding."
- **Do NOT write as if it were canonical** — that's misleading. Canonicality is \`consolidate\`'s job, after decisions land.
- **Explicit about uncertainty.** Research is the layer where uncertainty is allowed to live.

---

## Step 6: Link aggressively + file valuable Q&A back

Research articles are discovery surfaces. Under-linked research becomes an island nobody finds.

### Link discipline

- Every noun-phrase that names another document is a link. Use standard markdown: \`[text](./relative/path.md)\`. (Wiki-link syntax \`[[Page]]\` is still parsed for legacy content but no longer the default; matches the OK skill guidance.)
- Link sources inline where you cite them, not just in the frontmatter \`sources:\` list: "According to [LLM Agents (Dust)](./external-sources/llm-agents-dust.md)..." is stronger than a bare \`sources:\` entry.
- Cross-link sibling research: if an adjacent topic has its own research doc, link it under "Open questions" or inline. Readers following one thread should find the others.
- After writing, update 1–2 closely-related existing pages to link back to this research (usually under "Further reading" or "See also"). This is how the research becomes discoverable via backlinks.
- Never wrap links in backticks; never use HTML anchors — matches the OK skill's linking rules.

### File valuable Q&A back (Karpathy's "query" step)

If the user asked a specific question during the research session that produced a citable answer, capture it as its own short page alongside the research — not just as chat. Concrete questions with sourced answers are the highest-signal unit of knowledge you can produce.

Karpathy: *"Search wiki pages, synthesize answers with citations, file valuable outputs back as new pages."*

- Short filename: \`what-does-X-mean.md\`, \`how-does-Y-work.md\`
- Include the same \`sources:\` frontmatter
- Link the answer from this research doc under "Further reading"
- Answers too small to justify a separate file stay in chat; don't fragment

---

## Step 7: Validate

Run this checklist before marking complete:

- [ ] File exists at the chosen path under the content directory
- [ ] Frontmatter has \`title\`, \`description\`, \`status: provisional\`, \`date\`, and a \`sources:\` list
- [ ] \`exec("ls <dir>")\` lists the new file with frontmatter enrichment
- [ ] \`links({ kind: 'dead', sourceDocNames: ['<path-without-ext>'] })\` returns clean — zero dead links (fix or remove every one)
- [ ] Every factual claim in Findings cites a source inline
- [ ] Linked source files from Step 3 all exist (broken source links → \`ingest\` went wrong somewhere)
- [ ] At least 1–2 neighbor docs now link to this research (per Step 6's "After writing, update ..." rule)

---

## Step 8: Recap + follow-up directions

Close the loop with the user in conversation:

\`\`\`
## Recap

- [Finding 1 — with source]
- [Finding 2 — with source]
- [Key trade-off / contradiction surfaced]
- [1–2 open questions that remain]

**Tentative recommendation:** [state it in one sentence]

**Follow-up research directions** (Path A candidates for later):
1. [Direction 1 — what would it investigate?]
2. [Direction 2 — what would it investigate?]
3. [Direction 3 — what would it investigate?]
\`\`\`

Follow-ups should be **external-source investigations** — not actions on the user's codebase (those belong in a spec, not more research). Each direction should be a standalone topic someone could later invoke \`research\` on.

In headless mode, write the recap into the research article's "Further reading" section rather than prompting interactively.

---

## Non-goals

- **Don't promote to a canonical article.** That's \`consolidate\`'s job after a decision actually lands. Premature canonicalization buries uncertainty and misleads future readers.
- **Don't hide uncertainty.** Research is the layer where "we don't know yet" is acceptable prose. Say it explicitly.
- **Don't skip \`ingest\`.** Always capture raw sources first, then analyze. An article without preserved sources is opinion.
- **Don't skip Step 1 scan.** Duplicate research wastes the user's time AND misses chances to extend prior work.
- **Don't skip the scoping gate in Supervised mode.** The user's rubric shapes everything downstream; you cannot recover a wrong-scope article cheaply.
- **Don't mix 1P codebase analysis into the article unless asked.** Findings drift from factual synthesis to opinion when you do.
- **Don't overwrite existing research silently.** If the topic was researched before, either iterate (Path C) or create a clearly-named successor (\`crdt-alternatives-2.md\`) and mark the old one as superseded.
`;
}
