---
name: write-a-spec
description: "Scope a feature end to end and write an implementation spec under specs/ from an accepted proposal — current-system mapping, goals/non-goals, a Decision Log for one-way-door choices, a live Open Questions backlog, and a real migration + test plan. Read when asked to write a spec, scope this feature, turn this proposal into a spec, plan the implementation, or break this into tasks. Do NOT fire on frame a proposal or write the PRD (sibling frame-a-proposal — a PRD frames a change before it is accepted; this skill starts once one is), record a decision or write the ADR (record-a-decision), write a postmortem (write-a-postmortem), or review this design (review-a-design) — those are separate skills. Complements the platform open-knowledge skill; does not replace it."
compatibility: "Claude Code, Claude Desktop, Claude Cowork, Claude.ai web. Requires OpenKnowledge MCP server. Installed project-local by `ok seed --pack software-lifecycle`."
metadata:
  pack: "software-lifecycle"
  author: "Inkeep"
  repository: "https://github.com/inkeep/open-knowledge-skills"
---
# Write a spec — scope a feature and commit an implementation spec

> This skill is pack guidance. The platform `open-knowledge` skill (read/write/preview/linking/grounding rules) still governs every markdown operation — this layers spec-writing craft on top.

A spec is the contract between "we decided to build this" and "here is how it gets built." It is derived from an ACCEPTED proposal, maps the system that exists TODAY before proposing a change, and records its one-way-door choices in a Decision Log so the reasoning survives the author leaving. A spec that skips the current-system mapping, or resolves its open questions silently, is a liability — it reads authoritative while being unfounded.

`specs/` uses a folder-per-spec shape: `specs/NNN-name/` holding `spec.md`, and (when the work is actually going to be built) `plan.md` + `tasks.md`. The pack ships all three templates. `status` on `spec.md` flows `draft → ... → shipped`.

## Autonomy mode

| Mode | Behavior | How entered |
|---|---|---|
| **Supervised** (default) | STOP at the Step 2 scoping gate for user confirmation of Goals / Non-goals / change shape. Route open decisions interactively. | Default when a user drives the session. |
| **Headless** | Auto-confirm the scoping proposal after presenting it; auto-select routing decisions. All other gates (parent-proposal check, current-system mapping, Decision Log, validation, grounding) still enforced. | Explicit "don't wait for me", "just proceed", "run headless" — or non-interactive container environments. |

In headless mode, propose the scope AND proceed immediately; record in the Decision Log that scope was auto-confirmed without user sign-off.

---

## Mandatory execution order

**Hard gates — do NOT skip ahead.** If you find yourself about to write `## Design` before you have read the actual code the change touches, STOP — you skipped Step 1.

0. **Find the parent proposal.** No accepted proposal behind a spec is a smell.
1. **Map the CURRENT system.** Read real code + prior specs + guides. Write what exists today, with pointers.
2. **Scoping STOP gate.** Propose Goals / Non-goals / change shape. In Supervised mode, WAIT.
3. **Create the spec folder + `spec.md`** from the `spec` template; allocate `NNN` by listing, not guessing.
4. **Fill Goals / Non-goals** — non-goals temporal, each with a reason.
5. **Design** — options considered, one chosen, why; one-way doors flow to the Decision Log.
6. **Decision Log** — append the section; each entry survives the author.
7. **Open Questions** — a live backlog, each with its closing evidence and decider.
8. **Migration + Test plan** — real states, real tiers, explicit gaps.
9. **`plan.md` + `tasks.md`** — only when the spec is going to be built.
10. **Link + validate** — backlinks, dead-links clean, frontmatter complete.
11. **Recap** — and what would move it out of `draft`.

---

## Step 0: Find the parent proposal

A spec implements a decision that was already made. Before scoping anything, find the accepted proposal it derives from.

1. `exec("ls -A proposals/")` — surface the proposal set with frontmatter enrichment.
2. `exec("ls -A decisions/")` — an accepted proposal often has a matching frozen record here.
3. `search({ query: "<feature name or problem statement>" })` — semantic match across both folders when the name differs from the filename.
4. For the 1-2 strongest candidates, `exec("cat proposals/0004-x.md")` — read the accepted design and its unresolved questions in full; those unresolved questions become your Open Questions seed.

**Route on what you find:**

- **Accepted proposal exists** → note its path; it becomes `parent_proposal:` in the spec frontmatter. Proceed to Step 1.
- **Proposal exists but is not accepted** (`draft`, `fcp`, `rejected`) → STOP. A spec for an un-accepted proposal builds on sand. Surface this: "The proposal `<path>` is at `status: <x>`, not accepted. A spec should follow an accepted proposal. Want me to help get it accepted first, or proceed anyway?"
- **No proposal at all** → say so plainly: "There's no accepted proposal behind this feature. Specs derive from proposals — the proposal is where we argue *whether* to build; the spec is *how*. I can frame a proposal first (that's the `frame-a-proposal` skill), or, if you acknowledge the risk, proceed straight to a spec and record that we skipped the proposal." If the user opts to proceed, record that choice in the Decision Log (Step 6) with its rationale. Do not silently skip it.

**HARD GATE:** do not create `spec.md` until the parent-proposal question is resolved one way or the other and, if skipped, acknowledged by the user.

---

## Step 1: Map the CURRENT system before designing the change

The most common spec failure is designing against an imagined system. You cannot write a sound `## Design` or a real `## Migration` without knowing what the running system does today.

**Read the code that exists — with native host tools.** Source code (`.ts`, `.py`, config, schema) lives OUTSIDE the knowledge base, so read it with the host's native file tools (Read / Grep / Glob), not OpenKnowledge verbs. Trace the actual flow end to end: the entry points, the modules the change will touch, the data shapes, the call chain across boundaries.

**Read the knowledge base with OpenKnowledge verbs.** Prior specs and guides ARE in-scope markdown:

- `exec("ls -A specs/")` — see what's been specced before; a sibling spec may already map the same subsystem.
- `exec("cat specs/003-x/spec.md")` — read the closest prior spec's Design + Migration for the shape and the pointers.
- `exec("ls -A guides/")` then `exec("cat guides/<runbook>.md")` — runbooks describe operational reality the code alone won't tell you.
- `search({ query: "<subsystem name>" })` — surface adjacent decisions and postmortems that constrain the design.

**Write what exists today into the spec's Design section as a "Current system" subsection first**, with file/module pointers (`src/foo/bar.ts`, the `handleX` function, the `widgets` table). Concrete pointers are what make the spec verifiable and let a reviewer check your map against the code.

**HARD GATE:** do not draft the proposed `## Design` until the current-system map is written with real pointers. If you cannot point at where a behavior lives today, you do not yet understand it well enough to change it.

---

## Step 2: Scoping STOP gate

Before writing the spec body, propose the scope and get confirmation. Getting Goals / Non-goals wrong is expensive to unwind after the spec is drafted.

Present this to the user:

```
## Proposed scope

**Parent proposal:** [path — or "none; proceeding without one per your acknowledgement"]

**Goals** (what this spec delivers):
1. [Goal — an observable capability or change]
2. ...

**Non-goals** (explicitly out of THIS spec, and why):
1. [Thing] — deferred because [reason]
2. ...

**Shape of the change:** [2-4 sentences: the approach at a high level, and which modules from the Step 1 map it touches]

**Open questions I already see:** [1-3 — the ones that will gate the design]
```

**Supervised mode:** STOP and WAIT for confirmation. Do not create the spec folder until the user confirms or adjusts.

**Headless mode:** present the scope AND proceed; note the auto-confirmation in the Decision Log.

Scoping discipline:
- If the feature is vague, narrow it here, not in the Design. "Which surfaces? For whom? What's explicitly deferred?"
- Name the beneficiary of each goal — a goal with no one who benefits is scope creep.
- Do not invent requirements the proposal never established (see Non-goals for this skill). If a goal isn't traceable to the parent proposal, flag it and ask.

---

## Step 3: Create the spec folder + `spec.md`

Allocate the next `NNN` by **listing, not guessing**:

1. `exec("ls -A specs/")` — read the existing `NNN-name/` folders. Take the highest `NNN`, add one, zero-pad to the existing width (`003` → `004`).
2. Choose a short kebab-case name from the feature: `specs/004-payment-retries/`.
3. Create the spec:

```
write({ document: { path: "specs/004-payment-retries/spec.md", template: "spec" } })
```

The `spec` template ships frontmatter and these H2 sections in order: `## Goals`, `## Non-goals`, `## Design`, `## Migration`, `## Test plan`. Fill the frontmatter now:

```yaml
type: spec
description: "<one line: what this spec delivers>"
status: draft
owner: <user>
target_release:
created: <today YYYY-MM-DD>
parent_proposal: ./proposals/0004-payment-retries.md   # or note the skip
tags: [spec]
```

Set `parent_proposal:` to the relative markdown path from Step 0. Leave `target_release:` blank until the plan exists.

---

## Step 4: Fill Goals and Non-goals

Edit the `## Goals` and `## Non-goals` sections via `edit({ ... })`.

**Goals** — each an observable outcome, not an implementation detail. "Failed payments retry with backoff and surface a final status" is a goal; "add a `retryCount` column" is a design choice. Tie each goal to the beneficiary and, where possible, to the parent proposal's motivation.

**Non-goals are TEMPORAL, not eternal.** Frame each as "not in THIS spec" with the reason it's deferred — never as "we will never do this." "Multi-currency retries — deferred; the retry engine is currency-agnostic and multi-currency is its own proposal" tells a future reader the door is open and why it's closed for now. "We don't support multi-currency" reads as a permanent product stance the spec has no authority to make. Every non-goal carries its *why*.

---

## Step 5: Design

Edit `## Design`. It has two layers, in order:

1. **Current system** (from Step 1) — what exists today, with file/module pointers. Keep this; it is what makes the proposed change legible.
2. **Proposed change** — the options you considered, the one you chose, and why.

For each meaningful design fork, write: the options on the table, the one chosen, and the reasoning. Name the trade-off you accepted. A design that presents only the chosen option hides the fact that a choice was made — and hides it from the reviewer whose job is to pressure-test it.

**Every one-way-door choice goes to the Decision Log (Step 6).** A one-way door is a decision that is expensive or impossible to reverse once code ships on it: a wire format, a schema migration that drops data, a public API shape, a security boundary. Reversible choices (an internal helper name, a log level) do not need a log entry — keep the log to decisions that will cost real money to undo.

---

## Step 6: Decision Log

The `spec` template does NOT ship a Decision Log — **you append it.** Add an `## Decision Log` section to `spec.md` after `## Test plan`. This is the single most valuable artifact in the spec: it is what a new owner reads to understand why the system is shaped the way it is, without having to re-derive it or ask someone who has left.

Each entry is a short block:

```markdown
### DL-1: <the question, as a question>

- **Options:** A [...], B [...], C [...]
- **Choice:** B
- **Rationale:** [why B beat A and C — the trade-off accepted, the evidence]
- **Date:** YYYY-MM-DD
- **Reverses if:** [what new fact or condition would force revisiting this]
```

Discipline:
- One entry per one-way-door choice from Step 5, plus any process decision (e.g. "proceeded without a parent proposal per the user's acknowledgement on <date>").
- The `Reverses if` line is not optional — a decision with no stated reversal condition can never be re-examined honestly.
- This log is scoped to THIS spec. It is not the project's decision record. Recording an architecture decision in `decisions/` is the sibling `record-a-decision` skill's job; do not write ADRs here.

---

## Step 7: Open Questions

A spec ships with its open questions MARKED, not silently resolved. Guessing at an answer and writing it as settled is how a spec misleads everyone downstream.

Append an `## Open Questions` section (the template does not ship one). Keep it as a live backlog:

```markdown
### OQ-1: <the unresolved question>

- **Blocks:** [which goal / design decision this gates, or "nothing — nice to know"]
- **Closed by:** [the evidence that would resolve it — a benchmark, a load test, a product call, a spike]
- **Decider:** [who has authority to close it — a role, not a name that will rot]
- **Status:** open
```

Discipline:
- If a question blocks a Decision Log entry, say so in both places — the log entry stays provisional until the question closes.
- Prefer "we don't know yet, here's how we'd find out" over a confident guess. The boundary of what you know is information; a fabricated answer is a hazard.
- As questions close during the spec's life, flip `Status: open` to `resolved → DL-N` and move the resolution into the Decision Log — don't just delete the question.

---

## Step 8: Migration and Test plan

Both real, not decorative. A migration section that says "migrate the data" and a test plan that says "add tests" are worse than nothing — they signal coverage that doesn't exist.

**`## Migration`** — name the STATES a live system passes through, in order, and what is true at each. A running system does not teleport from old to new; it lives in intermediate states where both must work:

- The states, e.g.: (1) new code deployed, feature flag off, old path live. (2) backfill runs, both schemas readable. (3) flag on for a cohort, dual-write. (4) flag on globally. (5) old path + old column removed.
- What is reversible at each state and where the point of no return is (link that point to its Decision Log entry).
- Data at rest: what gets backfilled, what gets dropped, whether the drop is recoverable.
- If the change needs no migration (net-new, no live data, no deployed callers), say so explicitly and why — don't leave the section empty.

**`## Test plan`** — name WHAT is verified and at WHICH tier, and explicitly what is NOT verifiable and why:

- Per goal: the tier that proves it — unit (a pure function's edges), integration (a component against its real collaborators), end-to-end (the user-visible flow), contract (a boundary both sides must honor).
- The failure modes worth a test, not just the happy path — the retry that exhausts, the migration that half-completes, the concurrent write.
- **What cannot be verified before ship, and why** — a production-only load characteristic, a third-party behavior you can't stage, a race that only manifests under real traffic. Naming the gap is what lets the reviewer decide whether it's acceptable; hiding it is how the gap becomes an incident.

---

## Step 9: `plan.md` and `tasks.md`

**Only when the spec is actually going to be built.** A spec at `status: draft` that may not be implemented does not need these yet — creating them early produces stale scaffolding. Create them when the spec is greenlit for implementation.

```
write({ document: { path: "specs/004-payment-retries/plan.md",  template: "spec-plan"  } })
write({ document: { path: "specs/004-payment-retries/tasks.md", template: "spec-tasks" } })
```

Set `parent_spec: ./spec.md` in both frontmatter blocks.

**`plan.md`** (`## Approach`, `## Phases`, `## Risks + unknowns`, `## Dependencies`, `## Rollout`) — the how-to-build sequenced into phases. `Risks + unknowns` pulls from the Open Questions that block implementation; `Rollout` mirrors the Migration states.

**`tasks.md`** (`## Tasks` checklist, `## Done when`, `## Out of scope`) — the work broken down. Two rules:
- **Ordered by dependency.** A task that depends on another comes after it. The reader should be able to work top to bottom.
- **Each task independently verifiable.** "Add retry backoff to the payment worker — verified by the exhaustion integration test" is a task; "improve reliability" is not. If you can't state how a task is checked, it's not decomposed enough.

`## Done when` restates the spec's Goals as the completion bar. `## Out of scope` mirrors the Non-goals.

---

## Step 10: Link and validate

Specs that don't link back are islands. Wire the spec into the graph and prove it's clean:

- **Backlink the parent proposal** inline in the spec body: `derived from [Payment retries proposal](./proposals/0004-payment-retries.md)`. Plain markdown relative link — never backticked, never an HTML anchor.
- **Link every decision the spec depends on** — if the design rests on a frozen record in `decisions/`, link it where it's relied upon.
- Update the parent proposal (and any hub) to link forward to this spec, so the spec is discoverable via backlinks. `links({ kind: "backlinks", ... })` to confirm the reverse edge registered.
- `links({ kind: "dead", sourceDocNames: ["specs/004-payment-retries/spec"] })` — returns clean, zero dead links. Fix or remove every one.
- Frontmatter complete: `type`, `description`, `status`, `owner`, `parent_proposal`, `created`, `tags` all present.

---

## Step 11: Recap

Close the loop with the user:

```
## Recap

- Spec at specs/004-payment-retries/spec.md, status: draft
- Derived from [proposal] (or: proceeding without one, logged as DL-N)
- N goals, M non-goals (all temporal, with reasons)
- Decision Log: K one-way-door choices recorded
- Open Questions: J open — [name the ones that block the design]
- Migration: [one line] · Test plan: [what's covered / what can't be]

**To move out of `draft`:** [the specific things — usually: close the design-blocking open questions, get the owner's sign-off, and create plan.md + tasks.md once greenlit for build]
```

State plainly what is still open. A spec's honesty about its own gaps is what makes it trustworthy.

---

## Non-goals

- **Don't invent requirements the proposal didn't establish.** The spec is *how*, not a second bite at *whether*. A goal with no root in the parent proposal is scope creep — flag it, don't smuggle it in.
- **Don't record decisions in `decisions/`.** That's the sibling `record-a-decision` skill. The spec's Decision Log is scoped to THIS spec's one-way doors; it is not the project's ADR record.
- **Don't skip the current-system mapping.** Designing against an imagined system is the top failure mode. No `## Design` before Step 1's map with real pointers.
- **Don't mark `shipped` before the work ships.** `status` reflects reality. A spec is `draft` until built, and only `shipped` once the code is live — never aspirationally.
- **Don't write the postmortem.** If the shipped feature breaks, the incident write-up is the `write-a-postmortem` skill's job, not an addendum here.
- **Don't silently resolve Open Questions.** A marked open question is information; a fabricated answer is a hazard. Ship the spec with its unknowns visible.
