---
name: review-a-design
description: "Reviews whether a design is SOUND — solving the right problem, derived from its stated goals and constraints — and emits ranked, evidence-backed findings, not edits. Read when asked to 'review this design', 'is this design sound', 'pressure-test this proposal', 'do a design review', 'does this solve the right problem', 'poke holes in this spec', 'should we build this', or to critique a proposal / spec / ADR / architecture or product decision. Do NOT read when the user wants to AUTHOR one of these — routing a new proposal is frame-a-proposal, a spec is write-a-spec, a decision record is record-a-decision, a postmortem is write-a-postmortem. Do NOT read for code review of a diff, or to fact-check individual claims (that is a correctness pass, a different job)."
compatibility: "Any agent host with the OpenKnowledge MCP server configured. Installed project-local by `ok seed --pack software-lifecycle`."
metadata:
  pack: "software-lifecycle"
  author: "Inkeep"
  repository: "https://github.com/inkeep/open-knowledge-skills"
---

# Review a design — is it sound, not just complete

The platform `/open-knowledge` skill still governs every markdown operation here (reads via `exec`, writes via `write`/`edit`, links as plain relative markdown, MCP owns in-scope `.md`); this skill layers design-review craft on top of it.

**Three reviews are not the same review, and only one is this skill's job.**

- **Completeness review** asks: is every section filled in? (Are Drawbacks and Alternatives non-empty?)
- **Correctness review** asks: are the individual claims true? (Does the benchmark really say 40ms? Is that API deprecated?)
- **Soundness review** asks: *should this be built at all, and is this the design that follows from the stated goals and constraints?*

You are doing the third. A proposal can be complete and factually correct and still be the wrong design — solving a symptom, chosen before its goals, engaging only strawman alternatives. Completeness and correctness are cheap to check and someone else's pass. Say this to the user up front if there's any ambiguity about what kind of review they want, then do soundness.

You produce **findings, not edits.** The author decides what to change. Never rewrite the artifact under review unless explicitly asked.

---

## Step 0: Identify the artifact and read it — and what it inherits

**HARD GATE: never review a design you have not read end to end, and never review it in isolation from the decisions it inherits.** A review of the first half is worse than no review — it spends the author's trust on partial understanding.

1. Identify the type. It is one of:
   - a **proposal** (`proposals/NNNN-name.md` — Motivation / Design / Drawbacks / Alternatives / Unresolved questions),
   - a **spec** (`specs/NNN-name/spec.md` — Goals / Non-goals / Design / Migration / Test plan, with a `parent_proposal:`),
   - a **decision** (`decisions/NNNN-title.md` — Context / Decision / Consequences, with a `supersedes:` chain), or
   - an **in-flight choice with no document yet** (the user is deciding in conversation). This is a valid target — see Step 1.
2. Read it whole: `exec("cat proposals/0003-feature.md")`.
3. Read what it depends on. A design is only as sound as the ground it stands on:
   - the **parent proposal** a spec links via `parent_proposal:`, and any proposal a decision implements;
   - the **decisions it assumes** — `exec("grep -rln <subsystem-keyword> decisions/")`, then `cat` the relevant ones. A design that contradicts an accepted ADR without noting it is a finding by itself.
   - the **prior postmortems in the same subsystem** — `exec("ls -A postmortems/")` and `search({ query: "<subsystem> failure" })`. A postmortem names a failure mode; a design that reintroduces it is your highest-value catch.
   - **sibling proposals/decisions** it supersedes or overlaps — follow the `supersedes:` chain both directions.
4. If the design references source code, read the code with the host's **native** tools (`Read`, `Grep`) — source is outside the knowledge base. In-scope markdown stays on `exec`/`search`.

Do not proceed until you can name the goal, the constraints, and the prior decisions this design sits on top of.

---

## Step 1: Reconstruct the design's own argument — and show it back

Before you critique anything, state the design's argument in your own words: **the goal it serves, the constraints it accepts, and why this design follows from them.** Show it to the user before Step 2.

Why this gate exists:

- If you can reconstruct it cleanly, the author gets a free confirmation that the intended reader understood it — often the most useful thing a review returns.
- **If you cannot state the goal, the constraints, and why this design follows from them, the reviewable object does not exist yet — and that IS the finding.** Stop and report it: "I can't reconstruct why this design follows from its goals; here's where the chain breaks." Reviewing the surface of a design whose argument you can't state produces confident noise. Hand it back to the authoring skill to make the argument legible first.

For an in-flight choice with no document, this step is where you force the argument into words for the first time. Frequently the act of reconstruction resolves the question without a single lens.

---

## Step 2: Run the soundness lenses

Pass the design through each lens below. A lens is a named question plus the failure it catches — run the ones that bite for this artifact, skip the ones that plainly don't, and add any that earn their place. Do not mechanically fill all nine; a review that says the same shallow thing nine times teaches nothing.

- **Problem lens** — *Is the stated problem the real problem, or a symptom of one upstream?* Whose problem is it, and what evidence says it hurts today (not hypothetically)? A design aimed at a symptom is unsound however elegant. Failure it catches: solving the wrong problem beautifully.
- **Goal-derivation lens** — *Does the design follow from the stated goals, or were the goals reverse-engineered to justify a design chosen first?* Read the goals, then read the design cold: could you have predicted this design from these goals? If the design has a feature no goal demands, either the goal is unstated or the feature is scope. Failure it catches: solution-first rationalization.
- **Alternatives lens** — *Are the alternatives real, or strawmen?* Take the strongest version of the rejected option — steelman it — and check whether the document engages with *that*, or with a weak caricature. An Alternatives section that dismisses each option in one dismissive sentence is a tell. Failure it catches: a foregone conclusion dressed as a comparison.
- **Constraint lens** — *Which constraints are hard, and which are inherited habit?* Hard: physics, compliance, a one-way door already walked through, a contract with a downstream team. Soft: "we've always done it this way", a limit of the current tool, a deadline that could move. A design that treats a soft constraint as hard is under-imagined and probably larger than it needs to be. Failure it catches: unnecessary complexity justified by a fake wall.
- **Cost lens** — *What does this design foreclose, and what does it hand the team every week for the next three years?* Name the ongoing obligation: the migration that can't be undone, the schema that now needs backfilling forever, the on-call surface. Blast radius is not just the launch; it's the maintenance tail. Failure it catches: a cheap-looking design with an expensive tail.
- **Reversibility lens** — *One-way door or two-way door?* A two-way door (easily reverted) should be walked through, not committee'd — if the design is cheap to undo, over-reviewing it wastes everyone's time and the finding is "just ship it and learn." A one-way door (data migration, public API, external contract) deserves the scrutiny the two-way door didn't. Failure it catches: mis-spent rigor — heavy process on reversible choices, light process on irreversible ones.
- **Failure lens** — *What has to be true for this to work, and what happens at each assumption's boundary?* List the load-bearing assumptions, then push each to its edge: what at 10x load, at zero network, at a hostile input, at the second concurrent writer? **Cross-check the prior postmortems from Step 0: does this design reintroduce a named past failure?** Failure it catches: a design sound in the happy path and broken at every boundary.
- **Simplicity lens** — *Is there a materially smaller design that satisfies the stated goals?* Name it concretely — "drop the queue and call synchronously; the goals never mention throughput" — not "simplify it," which is not a finding. YAGNI is a soundness argument, not a style note: speculative generality is unsound because it pays cost for a goal no one stated. Failure it catches: a design solving problems it doesn't have yet.
- **Scope lens** — *Are the non-goals temporal and justified, or is load-bearing scope being smuggled out the back?* A good non-goal says "not now, because X, and here's the seam that lets us add it later." A bad non-goal quietly excludes the hard half of the actual problem so the design looks tractable. Read every non-goal and ask whether the design still solves the real problem without it. Failure it catches: a tractable design for a shrunken problem.

---

## Step 3: Write findings

Each finding has four parts, and a finding missing the second is an opinion — drop it:

1. **Claim** — one sentence. What is unsound.
2. **Evidence** — quote the passage or link it: `the Design section says "[quoted text]"` or `[the Migration plan](./specs/012-sync/spec.md)` assumes X. **A finding with no evidence pointer is an opinion; delete it.** This is the single discipline that separates a review the author acts on from one they resent.
3. **Severity** — one of:
   - **blocking** — the design should not proceed as written; a load-bearing assumption is wrong, or it reintroduces a known failure, or it solves the wrong problem.
   - **substantive** — the design can proceed, but this materially weakens it and deserves an answer before acceptance.
   - **minor** — worth noting, safe to defer or wave off.
4. **Resolution** — a concrete alternative *or* the question that would settle it. "This is worse" is not actionable; "consider a two-way-door version that does X, which drops the migration" or "what happens when two agents write the same doc — does the design address that?" is.

**Rank by severity, not by reading order.** Lead with the blocking findings; the author reads the top of your review and stops when they've got the gist. Burying the one blocking finding under six minor ones wastes it.

---

## Step 4: Calibrate — adversarially re-read your own findings

Before you deliver, turn the lenses on yourself. **Reviews that flag everything teach the author to ignore reviews** — the moment your review has one indefensible finding, the author discounts all of them.

- Re-read each finding as the author would and try to kill it. If you can't defend the evidence, cut it.
- State **confidence per finding** and **what would change your mind**: "blocking, high confidence — unless the load numbers in the parent proposal are wrong, in which case this drops to minor." A finding you can't attach a falsifier to is probably a preference, not a finding.
- Collapse duplicates. Three findings that are the same root cause are one finding with three symptoms.
- If after calibration you have zero blocking and zero substantive findings, say so plainly — "this is sound; here are two minor notes" is a complete and valuable review. Do not manufacture severity to look thorough.

---

## Step 5: Deliver

**In conversation by default.** Most reviews are a message: the reconstructed argument (Step 1), the ranked findings (Step 3), the calibration notes (Step 4).

**Persist as a document ONLY when** the user asks, or the review is substantial enough to be cited later (a blocking review of a proposal heading to accept/reject). Then:

- Write it beside the artifact it reviews: `write({ document: { path: "proposals/0003-feature-review.md" } })`.
- Link it **from** the artifact's Unresolved questions (proposal) or Open questions (spec) section via `edit` — a plain markdown link `[design review](./0003-feature-review.md)`, never backticked, never an HTML anchor.
- Mark it **advisory** in its own frontmatter/opening line: this is input to the author, not a verdict. The author owns the artifact and decides what lands.

Never edit the design under review to "apply" a finding. You emit findings; the authoring skill applies them.

---

## Step 6: Hand off

Route blocking and substantive findings back to whoever owns the fix:

- Findings on a **proposal** → `/frame-a-proposal` (the argument, alternatives, or motivation needs rework).
- Findings on a **spec** → `/write-a-spec` (goals, non-goals, migration, or test plan needs rework).
- A finding that has *resolved into a made choice* ("we discussed it; we're going with the synchronous version") → `/record-a-decision`, so the choice and its rationale land in `decisions/` with a `supersedes:` link if it overturns a prior ADR.
- A finding that a **past failure is being reintroduced** → point the author at the specific `postmortems/YYYY-MM-DD-name.md` so the design engages with it explicitly.

Name the skill and the reason in your handoff so the author knows exactly where to go.

---

## Non-goals

- **Not a completeness checklist.** "Section X is empty" is only a finding if the emptiness makes the design unsound (no Alternatives means no evidence the option space was explored — *that's* the finding, not the empty heading).
- **Not a fact-check.** Whether an individual claim is true is a correctness pass — a different job. You assume the claims and test whether the design that rests on them is sound. Flag a claim only when it's load-bearing AND you have specific reason to doubt it; otherwise route the fact-check separately.
- **Not a code review.** Reviewing a diff for bugs, style, or implementation quality is out of scope. This skill reviews the design, not its code.
- **Not a rewrite.** Never edit the artifact under review without being asked. You produce findings; the author changes the design.
- **Never the final verdict.** The review is advice to the author, who owns the decision. A review that reads as a ruling — "rejected" — overreaches; a review that reads as "here's what would make this stronger, and here's what I'd block on and why" is doing its job.
