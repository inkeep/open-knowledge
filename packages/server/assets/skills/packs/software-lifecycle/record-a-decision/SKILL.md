---
name: record-a-decision
description: "Records an architecture decision as a Nygard/MADR-shaped ADR under decisions/ — capturing the context that forced the choice, the options weighed, the decision itself, and its consequences in both directions, plus the supersedes chain that keeps a decision log honest. Read when asked to record an architecture decision, write an ADR, log the decision we made, document why we chose X over Y, capture this decision for the record, or supersede an old decision with a new one. Do NOT read to frame a proposal or explore an idea not yet decided (frame-a-proposal), to write a spec or implementation plan (write-a-spec), to write an incident postmortem (write-a-postmortem), or to judge whether a design is sound (review-a-design). This skill records a decision already made; it does not make one."
compatibility: "Any agent host with the OpenKnowledge MCP server configured. Installed project-local by `ok seed --pack software-lifecycle`."
metadata:
  pack: "software-lifecycle"
  author: "Inkeep"
  repository: "https://github.com/inkeep/open-knowledge-skills"
---

# Record a decision — write an ADR under `decisions/`

The platform `/open-knowledge` skill still governs every markdown operation here (grounding, linking, the rule that OK's MCP tools own in-scope markdown); this skill layers ADR craft on top.

An Architecture Decision Record is a small, dated, frozen document that captures **one** decision, the forces that made it necessary, and what the team now has to live with. The value compounds over years: a reader who joins in three years should understand not just what was decided but *why it was even a question*. ADRs are frozen once accepted — you never rewrite one to change your mind, you **supersede** it with a new record and leave the old one standing as history. That supersedes chain is what separates an honest decision log from a pile of stale opinions.

Filenames are `NNNN-title.md` (zero-padded 4-digit sequence + kebab title). Status vocabulary: `proposed` / `accepted` / `deprecated` / `superseded`. Template id `decision`, body sections exactly `## Context`, `## Decision`, `## Consequences` in that order.

---

## Step 0 — Confirm a decision was actually MADE (HARD GATE)

**An ADR records a decision; it does not make one.** Before anything else, establish that a choice has been settled.

- If the user is still weighing options, comparing approaches, or asking "should we do X or Y?" — they do not have a decision yet. **Stop and route them to the `/frame-a-proposal` skill.** A proposal is where options get explored and argued; an ADR is where the settled outcome gets recorded. Recording a decision the user has not made produces a fake record that misleads every future reader.
- If the user says "we decided X" but you cannot tell *what lost* or *why*, ask one question: "What were the alternatives, and what made you pick this one?" An ADR with no rejected options is a press release, not a record.
- If the thing in question is whether the design itself is sound — not the record of it — hand off to `/review-a-design`. This skill assumes the decision is sound; it captures it.

Do not proceed past this gate until the user has confirmed a specific decision. State it back to them in one sentence and get a nod.

---

## Step 1 — Scan for prior art (surface supersedes candidates BEFORE writing)

A new ADR that silently contradicts an accepted one is how a decision log rots. Before allocating a number, find what already exists.

1. `search({ query: "<subsystem or topic of the decision>" })` — semantic sweep for related decisions, proposals, and specs.
2. `exec("ls -A decisions/")` — see the existing sequence and titles.
3. `exec("grep -rln <subsystem-keyword> decisions/")` — find records touching the same subsystem, interface, or constraint.
4. For each promising hit, `exec("cat decisions/NNNN-x.md")` — read its Decision and Status.

Then classify and surface to the user **before writing**:

- **Contradicts an accepted record** → this new decision reverses or replaces it. Flag the path as a `supersedes:` candidate: "This looks like it supersedes [0007-use-rest-api](./decisions/0007-use-rest-api.md), which is currently `accepted`. Confirm and I'll wire the chain in Step 7." Do not silently write a contradicting record.
- **Extends without contradicting** → note the related record; you'll link it, not supersede it.
- **Genuinely new** → proceed.

If the decision graduated from an accepted proposal in `proposals/`, locate that proposal now (`exec("grep -rln <topic> proposals/")`) — you'll link it as the parent in Step 4.

---

## Step 2 — Allocate the next number and create from the template

**Never guess the sequence number.** List the folder and take the next integer.

1. `exec("ls -A decisions/")` — read the highest existing `NNNN`.
2. Next number = highest + 1, zero-padded to 4 digits. First-ever decision is `0001`.
3. Pick a short kebab title naming the decision, not the topic: `0012-adopt-event-sourcing-for-orders`, not `0012-orders`.
4. Create it from the template:

```
write({ document: { path: "decisions/0012-adopt-event-sourcing-for-orders.md", template: "decision" } })
```

The template lays down the frontmatter scaffold and the three H2 sections. Fill the frontmatter now:

```yaml
type: decision
description: "One line: the decision, active voice."
status: proposed        # proposed until the deciders accept; then accepted
date: YYYY-MM-DD        # today
deciders: [<user>]      # who owns this decision
supersedes: []          # fill in Step 7 if this replaces an earlier record
tags: [decision]
```

Leave `status: proposed` while drafting. It becomes `accepted` only when the deciders sign off (Step 8) — an ADR that ships `accepted` before anyone agreed is backdating.

---

## Step 3 — Context: the forces at play (invest here)

`## Context` is the section that ages best. Write it so a reader three years from now understands why this was even a question — no access to the meeting, the thread, or your memory. Cover:

- **The state of the system** when the decision was forced — what exists, what's under strain.
- **What changed** to make a choice necessary now rather than never. A new requirement, a scaling limit hit, a deprecated dependency, a deadline.
- **The constraints** that bounded the options — team size, existing tech, latency budgets, compliance, a hard date.
- **The forces in tension** — the reason this is a *decision* and not an obvious call. If there were no competing pressures, there'd be nothing to record.

Write it neutrally and factually. Do not argue for the decision here — that's Step 4's job. Context describes the problem so completely that the Decision reads as one reasonable response to it. If a reader finishes Context and still can't see why a choice was needed, the section has failed; rewrite it.

Ground every factual claim about the system in something checkable — link the proposal, a spec, or a prior decision rather than asserting from memory.

---

## Step 4 — Decision: active voice, one paragraph, unambiguous

`## Decision` states what will be done, in the active voice, present or future tense: **"We will ..."** One clear paragraph. A reader must finish it knowing exactly what was chosen with zero ambiguity.

Then, briefly:

- **Name the options that were weighed and why the others lost.** Two or three sentences per rejected option is enough — "We considered X but it couldn't meet the latency budget; Y was simpler but locked us to a single vendor." This is the heart of the record; a decision with no visible alternatives is unverifiable.
- **Link the parent proposal** if the decision graduated from one: "This decision accepts [0004-orders-rearchitecture-proposal](./proposals/0004-orders-rearchitecture-proposal.md)." Plain markdown relative link, never backticked, never an HTML anchor.

Do not fold implementation detail into the Decision — *how* it gets built belongs in a spec, not the ADR. The Decision says what and why, not the migration steps.

---

## Step 5 — Consequences: both directions, honestly

`## Consequences` records what the team now lives with — **good AND bad**. A Consequences section with only upside is a marketing document, not an ADR. Cover, in whatever grouping fits:

- **What gets easier** — the wins that motivated the choice.
- **What gets harder** — the costs, the new complexity, the thing that's now more awkward.
- **What new obligation the team carries** — ongoing maintenance, a new skill to hire for, a dependency to track, an invariant someone must now uphold.
- **What this forecloses** — options you can no longer take cheaply, doors this closes.
- **Neutral consequences** — facts that are neither win nor loss but that a future reader needs.

Force yourself to write at least one genuine negative and one new obligation. If you can't find any, you haven't thought hard enough — every real decision costs something. The negatives are the most valuable part of the record; they're what a future team checks when the decision starts to hurt.

---

## Step 6 — Soundness self-check (adversarial pass before committing)

Read the draft as a skeptic who disagrees with the decision. Answer each honestly and fix what fails:

- **One-way door or reversible?** Is the reversibility of this decision stated? A one-way door (hard or expensive to undo) must say so explicitly in Consequences — that's the single most important thing a future reader needs to know before they inherit it.
- **Does Context actually motivate the Decision?** Or does the Decision arrive from nowhere, with forces in Context that don't point at it? If the two sections don't connect, one of them is wrong.
- **Would a reader who disagrees find their objection addressed?** The strongest counter-argument should appear somewhere — in a rejected option or a named consequence. If the obvious objection is missing, add it.
- **Is any consequence being hidden because it's inconvenient?** The cost you'd rather not write down is exactly the one that belongs in the record.

If this pass reveals that the *design itself* is in question — not the quality of the record but whether the decision is right — stop and hand off to `/review-a-design`. This skill records sound decisions; it is not the place to relitigate one.

---

## Step 7 — Supersedes chain (both directions or it's broken)

If this record replaces an earlier one, the chain must be wired in **both** directions or the log lies from one side.

1. **Forward, on the new record:** add the old path to `supersedes:` frontmatter.

```
edit({ document: { path: "decisions/0012-adopt-event-sourcing-for-orders.md",
  frontmatter: { supersedes: ["decisions/0007-use-rest-api.md"] } } })
```

2. **Backward, on the old record:** flip its status and add a forward link so a reader landing on the old decision is sent to the new one.

```
edit({ document: { path: "decisions/0007-use-rest-api.md",
  frontmatter: { status: "superseded" } } })
```

Then add a line near the top of the old record's Context (or a short `> Superseded by ...` note): `Superseded by [0012-adopt-event-sourcing-for-orders](./decisions/0012-adopt-event-sourcing-for-orders.md).`

**Never edit the old record's Context, Decision, or Consequences prose.** ADRs are frozen — the old decision was true when it was made and stays on the record as history. You add the status flip and the forward pointer; you do not rewrite what it said. Both edits land, or the chain is broken in one direction and the log becomes untrustworthy.

---

## Step 8 — Link and validate

- **Backlinks in:** ensure the parent proposal links forward to this decision, and any spec that *implements* this decision links back to it. `links({ kind: "backlinks", docName: "decisions/0012-adopt-event-sourcing-for-orders" })` to see who points here; add the missing ones so the record is discoverable.
- **Dead links out:** `links({ kind: "dead", sourceDocNames: ["decisions/0012-adopt-event-sourcing-for-orders"] })` returns clean — zero dead links. Fix or remove every one; a broken link to a superseded record defeats the whole chain.
- **Frontmatter complete:** `type`, `description`, `status`, `date`, `deciders`, `supersedes`, `tags` all present and correct.
- **Status reflects reality:** if the deciders have accepted, flip `status: proposed` → `accepted`. If they haven't, leave it `proposed` and tell the user it's awaiting sign-off. Do not mark a decision `accepted` on the user's behalf.
- **Body shape:** exactly `## Context`, `## Decision`, `## Consequences`, in order. No extra top-level sections — depth that doesn't fit these three belongs in a linked spec.

---

## Step 9 — Recap to the user

Close in conversation, three things:

1. **The decision in one sentence** — the "We will ..." line.
2. **Its biggest consequence** — the one cost or obligation the team most needs to remember, especially if it's a one-way door.
3. **Any record it superseded** — name the old ADR and confirm the chain is wired both ways.

Then note whether `status` is `accepted` (deciders signed off) or `proposed` (awaiting sign-off), so the user knows what, if anything, is still open.

---

## Non-goals

- **Don't decide on the user's behalf.** If no decision has been made, route to `/frame-a-proposal`. This skill records; it does not choose.
- **Don't rewrite an accepted record.** ADRs are frozen. To change a past decision, supersede it (Step 7) and leave the old one standing — never edit its Context/Decision/Consequences prose.
- **Don't fold implementation detail into an ADR.** The migration plan, the API shape, the rollout steps belong in a spec (`/write-a-spec`). The ADR captures what and why, not how.
- **Don't record a decision that has no consequences section.** A record with only upside, or with no costs and no new obligations, isn't an ADR — it's marketing. Every real decision costs something; find it and write it down.
- **Don't judge the soundness of the design here.** If the question is whether the decision is *right* rather than whether it's well-recorded, that's `/review-a-design`.
