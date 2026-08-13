---
name: write-a-postmortem
description: "Write a blameless incident postmortem under postmortems/ following the Google SRE shape — evidence-based timeline, trigger vs root cause vs symptom, contributing factors, what went well, and owned+dated+verifiable action items. Read when asked to write a postmortem, do an incident review, run a root cause analysis, write up the outage, retro on the outage, or when the user says we had an incident and wants it documented. Do NOT read to frame a proposal (use frame-a-proposal), write a spec (use write-a-spec), record a decision (use record-a-decision), or review a design (use review-a-design) — a postmortem documents an incident that already happened, it does not propose, specify, decide, or critique future work."
compatibility: "Any agent host with the OpenKnowledge MCP server configured. Installed project-local by `ok seed --pack software-lifecycle`."
metadata:
  pack: "software-lifecycle"
  author: "Inkeep"
  repository: "https://github.com/inkeep/open-knowledge-skills"
---

# Write a postmortem

The platform `/open-knowledge` skill still governs every markdown operation here — folder scope, the read/write tool surface, linking, and preview. This skill layers postmortem craft on top of it; it does not replace those rules.

A postmortem is not a status update and not a blame ledger. It is a durable, blameless reconstruction of one incident, built from evidence, that makes the system's failure mode legible and produces action items someone will actually verify. The value compounds only when postmortems that share a subsystem link to each other — that is how a repeat class stops being invisible.

This pack scaffolds `proposals/`, `decisions/`, `specs/`, `postmortems/`, and `guides/` at the project root. Postmortems live in `postmortems/`, one file per incident, filename `YYYY-MM-DD-name.md`, template id `postmortem`. Action items that are guide-shaped produce `runbook` stubs in `guides/`.

The knowledge base is markdown owned by OpenKnowledge MCP. Read and list in-scope markdown with `exec` (`exec("ls -A postmortems/")`, `exec("cat postmortems/2024-03-02-auth-outage.md")`, `exec("grep -rln failover .")`) and `search({ query: "..." })`; create and edit with `write` and `edit`; inspect the link graph with `links`. Never use native Read/Edit/Grep/Glob/`cat` on in-scope markdown. Source code, logs, dashboards, deploy history, and chat transcripts are OUTSIDE the knowledge base — read those with the host's native tools. Links are plain markdown relative links `[db failover](./guides/db-failover.md)` — never backticked, never HTML anchors.

---

## Step 0 — Blamelessness gate (stated first because it constrains every later step)

Blameless is a mechanical discipline, not a slogan you paste in the header. If you cannot follow these rules mechanically, the document is not blameless no matter what it says at the top.

- **Name systems and roles, never individuals.** "the deploy pipeline," "the on-call engineer," "the release process" — not "Alice," not "the new hire." A named person turns readers defensive and the analysis stops.
- **Write the system's affordance, not the person's action.** "The deploy pipeline allowed an unreviewed config to reach production" — not "Alice deployed an unreviewed config." The grammatical subject is the system that permitted the outcome. If your sentence's subject is a person, rewrite it until it is a system.
- **Treat every human action as the reasonable action given the information available at that moment.** Nobody caused the incident by being careless. Someone did the sensible thing with the signals they had. The analytical question is never "why did they do that?" — it is "what made that look like the right move at the time?" A dashboard that read green, an alert that never fired, a runbook that said to do exactly that. Find the thing that made it reasonable; that thing is a contributing factor.

**HARD GATE.** If the user's framing is blame-seeking — "write up how Alice broke prod," "document who screwed up the deploy" — do not comply as asked. Say so plainly, reframe to the system question, and only then write. Example reframe: "I'll write this blamelessly — the useful question isn't who pushed the config but what let an unreviewed config reach production. That's the finding that prevents a recurrence." Producing a named-culprit document because the user asked for one is the single worst failure this skill can commit; it poisons the postmortem culture the document is supposed to build.

---

## Step 1 — Gather evidence before you narrate

You cannot write a timeline from memory and call it a postmortem. Gather first, narrate second.

Pull, using the host's native tools (these live outside the knowledge base):

- **Alerts and monitoring** — what fired, when, and what did not fire that should have.
- **Deploy and release history** — what shipped in the hours before, and the exact commit/config.
- **Dashboards and metrics** — error rate, latency, saturation, the graphs that show onset and recovery.
- **Chat transcripts and the incident channel** — timestamps of human decisions and the reasoning in the moment.
- **The code and config as it stood at incident time** — not as it stands now; check out or read the state at the incident SHA.

**HARD GATE — no timeline entry without a source you can point at.** Every timeline line cites its evidence: an alert ID, a deploy timestamp, a graph, a chat message time. If you are reconstructing a moment from someone's recollection and have no artifact, you may still include it — but label it inline: `(reconstructed from recollection, no artifact)`. A postmortem whose timeline silently blends logged fact with memory is worse than one that admits the gap, because the reader cannot tell which numbers to trust.

---

## Step 2 — Scan prior postmortems for the same subsystem

Before writing, find out whether this already happened.

1. `exec("ls -A postmortems/")` — see every prior incident at a glance.
2. `search({ query: "<subsystem> <failure mode>" })` — semantic match on the affected component (e.g. "database failover replication lag").
3. `exec("grep -rln <subsystem-keyword> postmortems/")` — exact-term sweep for the service, the error, the mechanism.
4. `exec("cat postmortems/<candidate>.md")` on the 1–3 closest matches — read their Root cause and Action items.

**If this is a repeat of a class already documented, that is the most important finding in the entire document — and it belongs in the Summary, not buried in Related.** A recurrence means a prior action item did not land, or landed and did not prevent recurrence. State it in the first two sentences: "This is the third connection-pool exhaustion incident in the payments service (see [2024-01-11](./postmortems/2024-01-11-payments-pool.md), [2024-03-02](./postmortems/2024-03-02-payments-pool.md)); the action item from the second was never completed." Repeat classes are where postmortems earn their keep — surface them loudly.

---

## Step 3 — Create the postmortem from the template

```
write({ document: { path: "postmortems/YYYY-MM-DD-name.md", template: "postmortem" } })
```

- **The date is the incident date, not today's.** If the outage was 2024-03-02, the filename is `postmortems/2024-03-02-name.md` even if you write it a week later.
- `name` is a short kebab slug of the affected system and failure: `payments-pool-exhaustion`, `auth-cert-expiry`, `search-index-corruption`.
- The `postmortem` template scaffolds the SRE shape: Summary / Timeline / Root cause / What went well / Action items. Fill each in the steps below; do not invent a different structure.

---

## Step 4 — Summary: impact first, cause second

The Summary is read by people who will never read the rest. Write it for the org, not for the on-call engineer.

- **Lead with user-visible impact:** who was affected, how, and for how long. "For 47 minutes, roughly 12% of checkout attempts failed with a 500." Not "the connection pool saturated."
- **Then one sentence of cause,** plain: "A config change halved the pool size while traffic was at peak; the pool exhausted and requests queued past timeout."
- **If Step 2 found a repeat class, it goes here** (see Step 2).

A summary that leads with the technology ("the connection pool saturated at 14:03") and buries the impact is written for engineers, not for the organization that needs to weigh the incident. Impact is the currency; state it first and in human terms.

---

## Step 5 — Timeline: timestamped, sourced, with the detection gap made explicit

Reconstruct the incident chronologically. Every entry: a timestamp **with time zone**, what happened, and the evidence it came from.

```
- 13:52 UTC — Config change #4821 merged, halving `pool.max` from 200 to 100. (deploy log, PR #4821)
- 14:03 UTC — Checkout error rate crosses 5%. (Grafana, checkout-errors panel)
- 14:19 UTC — First page fires to on-call. (PagerDuty incident #9917)
- 14:26 UTC — On-call acknowledges, begins investigating a suspected upstream issue. (incident channel)
- 14:41 UTC — Config change identified as cause; rollback initiated. (incident channel)
- 14:50 UTC — Error rate returns to baseline. (Grafana)
```

- **Call out detection time and mitigation time explicitly.** Mark the entry where the incident began, where it was *detected*, and where it was *mitigated*.
- **The gap between incident start and detection is usually the most actionable number in the document.** Here: onset 14:03, first page 14:19 — sixteen minutes blind. Name that gap in prose right after the timeline: "Detection lagged onset by 16 minutes; there was no alert on checkout error rate, only on host CPU." That sentence is often the source of the highest-leverage action item.
- Keep entries factual and sourced. Analysis goes in Root cause, not here.

---

## Step 6 — Trigger vs root cause vs symptom

Give the reader the three definitions, then separate them cleanly. Conflating them is the most common way a postmortem produces a shallow fix.

- **Symptom** — what was observed. "Checkout requests returned 500s; the pool showed zero free connections." The symptom is real but it is not the cause; fixing the symptom (restart, scale up) ends the incident without preventing the next one.
- **Trigger** — the specific thing that set it off. "Config change #4821 halved the pool size at peak traffic." The trigger is necessary to the story but rarely the whole cause.
- **Root cause** — the condition that made the trigger *sufficient* to cause the outage. Not "a bad config was pushed" — ask what made a bad config *pushable to production at peak with no guard*. The root cause is usually a missing safeguard, not the triggering action.

**Push past the first plausible cause.** If your answer is "someone pushed a bad config," you have named the trigger and stopped. Keep going: What allowed an unreviewed config to reach production? Why was there no validation on pool-size bounds? Why did no canary catch it? Techniques like "five whys" help you keep asking — but they are a prompt, not a proof, and they tend to walk you down a single chain when reality had several. Most incidents have **several contributing factors and one or two root causes**, not a single linear chain. Name the one or two conditions that, if they had not held, the trigger would have been harmless.

---

## Step 7 — Contributing factors

The conditions that widened the blast radius, delayed detection, or slowed recovery. These are not the root cause but they are why the incident was as bad as it was — and each is usually its own action item.

Look specifically for:

- **Missing or misrouted alerts** — the detection gap from Step 5 almost always lands here.
- **Absent or stale runbook** — no documented recovery path, so the on-call improvised. Check `guides/` and its `last_verified` dates.
- **Unclear ownership** — nobody knew who owned the failing component, so acknowledgement lagged.
- **A stale guide** — a runbook that said to do the thing that made it worse, or whose `last_verified` was long past.
- **Compounding conditions** — peak traffic, a concurrent deploy freeze, a second on-call already paged.

List each as a discrete factor. Vague "communication could have been better" is not a factor; "there was no owner mapping for the payments pool, so the first page went to the wrong team for 7 minutes" is.

---

## Step 8 — What went well (genuinely)

This section is not filler and skipping it quietly is a failure mode. Something limited the damage; name it so the org preserves it.

- What made detection or recovery faster than it could have been? A good dashboard, a fast rollback path, a clear escalation.
- What held up under load? The circuit breaker that shed load cleanly, the read replica that absorbed traffic.
- Which prior action item paid off here? If a previous postmortem's fix limited this incident, say so and link it — that is the strongest possible argument for funding action items.

Write it honestly. If genuinely little went well, say that plainly rather than manufacturing praise — "recovery was slow and manual; the one thing that worked was that rollback was a single command." Preserving what worked is as much the point as fixing what didn't.

---

## Step 9 — Action items: owned, dated, verifiable

An action item with no owner is a wish. Every item gets three things or it does not go in the list:

- **An owner** — a role or team (blameless: "the payments team," not a person's name unless the person self-assigns).
- **A due date** — a real date, not "soon."
- **A verifiable done-condition** — something you could check and unambiguously call done. "Add an alert on checkout error rate >2% for 3 minutes, tested by triggering it in staging" — not "improve alerting."

Classify each item by what it buys you:

- **Prevention** — stops this exact recurrence (add pool-size validation to the config pipeline).
- **Mitigation** — limits the damage next time it happens anyway (auto-shed load when the pool saturates).
- **Detection** — finds it sooner (the missing error-rate alert from Step 5).

A healthy postmortem has items across all three; a list that is all prevention often means the detection and mitigation gaps went unexamined.

**Guide-shaped action items produce runbook stubs.** When an item is "write/fix the recovery runbook for X," don't just name it — stub it now:

```
write({ document: { path: "guides/db-pool-exhaustion-runbook.md", template: "runbook" } })
```

Pre-fill the stub with the **symptom** (how you'd recognize this again — "checkout 500s + pool free-connections at zero") and the **relevant timeline excerpt** (the rollback steps that actually worked, lifted from Step 5). Then link the stub from the action item: `- [ ] Payments team, by 2024-03-16: complete the [pool-exhaustion runbook](./guides/db-pool-exhaustion-runbook.md), verified by a tabletop dry-run.` The runbook carries `last_verified` frontmatter so it surfaces in review when it goes stale.

---

## Step 10 — Link and validate

- Add a `## Related` section linking **every prior postmortem that shares a subsystem** (from Step 2), plus the `decisions/` and `specs/` implicated — the decision that set the config policy, the spec for the component that failed. `[2024-01-11 payments pool](./postmortems/2024-01-11-payments-pool.md)`, `[connection-pool sizing decision](./decisions/2023-11-04-pool-sizing.md)`.
- Link the runbook stubs you created in Step 9 from their action items (done above) and from `## Related`.
- Update the hub of any folder you touched if it has one (an `INDEX.md` in `postmortems/`) so the new incident shows up in the index — the preview becomes a live progress bar.
- Validate: `links({ kind: "dead", sourceDocNames: ["postmortems/YYYY-MM-DD-name"] })` returns clean — fix or drop every dead link. Confirm frontmatter is complete and the Summary / Timeline / Root cause / What went well / Action items sections are all filled, none left as template placeholder.

---

## Step 11 — Recap

Close in conversation with four things, tightly:

1. **Impact** in one line, user-visible terms.
2. **Root cause** in one sentence (the condition, not the trigger).
3. **The single highest-leverage action item** — usually the one that closes the detection gap or the missing safeguard.
4. **Whether this is a repeat class** — and if so, why the prior fix didn't hold.

Then point at the file: `postmortems/YYYY-MM-DD-name.md` and any runbook stubs created.

---

## Non-goals

- **Don't assign blame to people.** Systems and roles, never individuals. If a name is load-bearing to the story, the story is framed wrong — find the system affordance instead.
- **Don't stop at the first plausible cause.** "A bad config was pushed" is a trigger. Keep asking what made the trigger sufficient until you reach a missing safeguard.
- **Don't write action items you cannot verify.** No owner, no date, no checkable done-condition means it is a wish, not an action item. Leave it out or fix it.
- **Don't quietly omit "what went well."** Skipping it loses the practices worth preserving. If little went well, say so honestly rather than dropping the section.
- **Don't use a postmortem to relitigate a design decision.** A postmortem documents what happened and what to change operationally. Arguing that the architecture should have been different belongs in a proposal (`/frame-a-proposal`) or a design review (`/review-a-design`) — link to it from Related; don't fight it here.
- **Don't fabricate the timeline.** No entry without a source you can point at; reconstructed-from-memory entries are labelled inline as such.
