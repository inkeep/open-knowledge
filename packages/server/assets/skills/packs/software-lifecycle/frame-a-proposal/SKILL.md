---
name: frame-a-proposal
description: "Frame a new design proposal (RFC-shape) under proposals/ — problem before solution, named beneficiary and observable change, real alternatives, honest drawbacks, and a live open-questions backlog. Read when asked to frame a proposal, write an RFC, propose a design, pitch a change, draft a PRD-style design doc, or open a design proposal for review. Do NOT read to record a decision after it is accepted (use record-a-decision), to write an implementation spec (use write-a-spec), to write a postmortem (use write-a-postmortem), or to review or critique an existing design (use review-a-design)."
compatibility: "Claude Code, Claude Desktop, Claude Cowork, Claude.ai web. Requires OpenKnowledge MCP server. Installed project-local by `ok seed --pack software-lifecycle`."
metadata:
  pack: "software-lifecycle"
  author: "Inkeep"
  repository: "https://github.com/inkeep/open-knowledge-skills"
---

# Frame a proposal — turn a problem into a reviewable RFC

The platform `/open-knowledge` skill still governs every markdown operation here (reads via `exec`/`search`, writes via `write`/`edit`, links as plain relative markdown, never native Read/Edit/Grep/`cat` on in-scope files). This skill layers proposal-authoring craft on top: it decides *what a good proposal contains and in what order you earn each section*.

A proposal in `proposals/` is a design argument, not a decision and not a plan. It exists to force a **choice** among options and to give reviewers enough to disagree with. Filename is `0001-feature-name.md` — a zero-padded 4-digit sequence plus a kebab title. Status flows `draft → fcp → accepted/rejected` (fcp = final comment period). Acceptance graduates the proposal to a record in `decisions/` — that is a *separate*, human act and a *separate* skill.

The failure this skill exists to prevent: an agent jumping to `## Design` before anyone agrees what the problem is, padding `## Alternatives` with strawmen, and leaving `## Drawbacks` empty. Each step below has a gate that blocks that.

---

## Mandatory execution order

**Hard gates — do NOT skip ahead.** If you are about to draft `## Design` and you have not passed the Step 1 framing gate, STOP — you skipped a gate. The whole point of a proposal is that the problem is agreed before the solution is written.

0. **Scan prior art** — what already exists on this subsystem, in `proposals/` and `decisions/`.
1. **Frame the problem — STOP gate.** Name beneficiary, observable change, forced decision. Get confirmation before any solution text.
2. **Allocate the sequence number and create from the `proposal` template.**
3. **Motivation** — problem, evidence, who is hurt today, cost of doing nothing, and explicit non-goals.
4. **Design** — the proposal at an altitude a reader can disagree with.
5. **Alternatives** — at least two real ones, each with why-not.
6. **Drawbacks** — the honest cost.
7. **Unresolved questions** — a live backlog, each with a resolver and resolving evidence.
8. **Link + validate.**
9. **Recap + what advancing to `fcp` would require.**

Create workflow tasks for steps 0–9 in your host's task system if it has one — they make a skipped gate visible mid-session.

---

## Step 0: Scan prior art

Before framing anything, find out what the knowledge base already decided or proposed about this subsystem. A proposal that silently re-litigates an accepted decision is dead on arrival; a proposal that cites it and explains why the decision should be revisited is legitimate.

- `search({ query: "<subsystem or problem keywords>" })` — semantic, catches synonyms.
- `exec("ls -A proposals/")` and `exec("ls -A decisions/")` — see the sequence space and what has landed.
- `exec("grep -rln <keyword> proposals/ decisions/")` — pinpoint files that name the same subsystem.
- For the 1–3 most relevant hits, `exec("cat proposals/0003-x.md")` to read the full doc plus its backlinks.

Classify what you find, and carry it into the draft:

| Found | Do this |
|---|---|
| An **accepted decision** covers this area | The new proposal MUST cite it (a markdown link into `decisions/`) and, in Motivation, say what changed that reopens it. If nothing changed, tell the user this may not need a proposal at all. |
| A **draft/fcp proposal** overlaps | Offer to extend or supersede it rather than open a near-duplicate. Two overlapping proposals split the review. |
| **Nothing** | Proceed clean. |

---

## Step 1: Frame the problem — STOP gate

This is the gate that makes the difference between an RFC and a pile of solution text. **Do NOT draft `## Design`, and do NOT create the file, until the user confirms the framing.**

Produce and return exactly this, then STOP and wait:

```
## Framing (confirm before I draft)

**Beneficiary:** who is worse off today and will be better off if this ships. A named role or user, not "the system" or "us".

**Observable change:** the concrete, checkable difference they will see. "X drops from N to M", "Y becomes possible", "Z stops happening". Not "improve", not "streamline".

**Forced decision:** the one question this proposal makes reviewers answer. If accepting it doesn't commit anyone to anything, it is a report, not a proposal.

**Rough shape:** one sentence on the direction — enough to know we're framing the right problem, not the design itself.
```

Discipline:

- If you cannot name a beneficiary distinct from "the team," the problem isn't framed. Push back before drafting.
- "Observable change" is falsifiable or it isn't done. If you can't state how you'd check it, you're describing an activity, not an outcome.
- Vague trigger ("we should have a proposal for the cache")? Narrow it: for whom, forced by what decision, changing what they observe.
- In an explicitly headless/non-interactive run, state the framing AND proceed, but write the three fields verbatim into Motivation so a reviewer can reject the framing itself.

---

## Step 2: Allocate the number and create from template

**List, don't guess, the sequence.** `exec("ls -A proposals/")`, take the highest existing `NNNN`, add one, zero-pad to four digits. Guessing collides the moment two proposals are drafted the same week.

Filename: `NNNN-kebab-title.md` (`0007-async-export-pipeline.md`). Create it from the template — this is the only way the `## Motivation → ## Design → ## Drawbacks → ## Alternatives → ## Unresolved questions` skeleton and the frontmatter arrive correctly:

```
write({ document: { path: "proposals/0007-async-export-pipeline.md", template: "proposal" } })
```

The template stamps this frontmatter — fill it, don't retype it by hand:

```yaml
type: proposal
description: "..."     # one line: the forced decision, not the feature name
status: draft          # stays draft until a human advances it — see Non-goals
authors: [<user>]
created: YYYY-MM-DD
tags: [proposal]
```

Set `description` to the decision the proposal forces, in one line — it is what a reader sees in a listing.

---

## Step 3: Motivation

Fill `## Motivation` by `edit`-ing the created doc. This section has to stand on its own: a reader who disagrees here will never read your Design, and that's correct.

- **The problem**, stated as the beneficiary experiences it — not as the absence of your solution. "Exports over 100MB time out and users lose the job" beats "we have no async export pipeline."
- **Evidence** it is real: a metric, a repeated report, a concrete incident. A proposal motivated only by "it would be nice" is under-motivated; say so to the user and go find one signal.
- **Who is hurt today**, named (the Step 1 beneficiary), and how often.
- **Cost of doing nothing** — the status-quo baseline every alternative, including "reject this," is measured against. If doing nothing is genuinely fine, the proposal may not need to exist.
- **Non-goals — explicitly.** List what this proposal deliberately does *not* address. Non-goals are how you keep a proposal reviewable; an unbounded proposal can't be accepted because no one can tell what they're agreeing to. Put them under a clear `### Non-goals` line inside Motivation.

---

## Step 4: Design

Fill `## Design` with the actual proposal, pitched **at the altitude where a reader could disagree with it**. Too low (every function signature) and reviewers rubber-stamp a design they didn't evaluate; too high ("we'll make it faster") and there's nothing to accept. The target: a competent reader could read this section and say "no, I'd do it differently, because…"

- Describe the mechanism, the shape of the change, and the key interfaces or contracts it introduces or alters.
- Make the load-bearing choices explicit. If the design rests on one decision (a data model, a boundary, a sequencing), name it — that decision is usually what the whole proposal is really about.
- State how the Step 1 observable change is achieved. Tie the design back to the beneficiary.
- Link related specs, guides, and the decisions you're building on or revisiting, as plain relative markdown: `[the export boundary decision](./decisions/0004-export-boundary.md)`.
- Keep implementation minutiae out — that granularity is the spec's job (a sibling skill), not the proposal's.

---

## Step 5: Alternatives

Fill `## Alternatives` with **at least two real options**, each carrying **why it was not chosen**. Include the honest ones you'd have picked on a different day, plus "do nothing" if it's live.

Structure each:

```
### Alternative: <name>
What it is — one honest paragraph, argued at its best.
Why not — the specific tradeoff that lost, versus the proposed design.
```

Discipline:

- **Strawmen are a red flag — say so.** An Alternatives section where every option is obviously worse means the author didn't consider real ones, and reviewers will (correctly) distrust the whole proposal. If you can't state an alternative's genuine appeal, you haven't understood it well enough to reject it.
- "Do nothing" is a first-class alternative. Its "why not" is the Step 3 cost-of-doing-nothing.
- The right number is usually two to four. One means you're not proposing, you're announcing.

---

## Step 6: Drawbacks

Fill `## Drawbacks` with the honest cost of the proposed design — not the alternatives', its own.

- **A proposal with no drawbacks is under-examined, not perfect.** Every real design gives something up: complexity, a migration, a new failure mode, a maintenance burden, a closed door. Name them.
- Be specific about who pays and when — the cost may land on a different party than the beneficiary, and reviewers need to see that tradeoff.
- If you genuinely believe a drawback is acceptable, say why here rather than hiding it. A stated-and-accepted drawback is stronger than a silent one a reviewer discovers.

---

## Step 7: Unresolved questions

Fill `## Unresolved questions` as a **live backlog**, not a disclaimer. Each entry keeps a real open question visible instead of burying it in confident prose.

For each question:

```
- **<question>** — What would resolve it: <the evidence, experiment, or measurement>. Who decides: <role or person>.
```

- Every question names **what evidence would resolve it** and **who decides**. A question with neither is just an anxiety; either sharpen it or drop it.
- Questions that block acceptance belong here explicitly — they are the agenda for the `fcp` period.
- It is correct for this section to be non-empty at `draft`. Hiding uncertainty to look finished is the failure mode; an honest open-questions list is what makes the proposal safe to review.

---

## Step 8: Link + validate

Run before you tell the user it's ready:

- Every referenced decision, spec, or guide is a plain markdown relative link (`[text](./decisions/0004-x.md)`), never backticked, never an HTML anchor.
- Add backlinks from 1–2 closely related docs so the proposal is discoverable — the accepted decision it revisits, a related spec, the relevant guide. `links({ kind: "backlinks", ... })` to see what already points where.
- `links({ kind: "dead", sourceDocNames: ["proposals/0007-async-export-pipeline"] })` returns clean — fix or remove every dead link.
- Frontmatter complete: `type: proposal`, a one-line `description`, `status: draft`, `authors`, `created`, `tags: [proposal]`.
- All five H2 sections present and non-empty: `## Motivation`, `## Design`, `## Drawbacks`, `## Alternatives`, `## Unresolved questions`. An empty Drawbacks or a strawman Alternatives fails this check even though the section technically exists.
- `status` is still `draft`. You do not advance it — see Non-goals.

---

## Step 9: Recap + path to fcp

Close with the user in conversation:

```
## Recap

- Framed: <beneficiary> gets <observable change>; forces the decision <…>.
- Proposal: proposals/NNNN-title.md (status: draft)
- Alternatives weighed: <n>, chosen over them because <one line>.
- Honest drawbacks: <the main one>.
- Open questions still live: <count> — the fcp agenda.

**To advance to `fcp`:** a human moves status draft → fcp and opens the final comment
period. Acceptance (→ accepted, then a record in decisions/) is a human decision, not
mine. If it's rejected, mark status: rejected and keep the doc — the reasoning is the value.
```

State plainly that advancing status and accepting the proposal are human acts. Your job ended at a well-framed, honestly-argued `draft`.

---

## Non-goals

- **Don't record the decision.** Acceptance graduates a proposal to a record in `decisions/` — that's the sibling `/record-a-decision` skill, run *after* a human accepts. This skill stops at `draft`.
- **Don't write the implementation spec.** Design altitude, not build detail. The spec is `/write-a-spec`.
- **Don't mark a proposal `accepted` (or `fcp`) on your own authority.** Advancing status is a human act. Leave `status: draft`; offer the recap of what advancing would require.
- **Don't skip the Step 1 framing gate.** Solution text before an agreed problem is the exact failure this skill exists to prevent. If you've drafted Design without a confirmed beneficiary and forced decision, you skipped the gate — back up.
- **Don't pad Alternatives with strawmen or leave Drawbacks empty.** Both are tells that the proposal wasn't really examined. Reviewers read them as such.
