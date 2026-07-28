# Pressure-testing a discipline skill

A **discipline** skill enforces a behavior the agent tends to abandon under
pressure ("write the failing test first", "get review before merging"). A skill
that holds in the easy case but folds under pressure hasn't done its job. Test
the hard case.

## The loop (RED → GREEN → harden)

1. **RED — baseline without the skill.** Run the scenario with no skill loaded.
   Capture what the agent does AND its **rationalizations**, verbatim ("the
   change is tiny, so skipping the test is fine"). Those exact rationalizations
   are the loopholes the skill body must name and close.
2. **GREEN — minimal skill.** Write the smallest body that defeats those specific
   rationalizations. Re-run; confirm the behavior changed.
3. **Harden under combined pressure.** Re-run with **2–3 pressures stacked** and
   force a concrete choice:
   - *Time*: "this is urgent, ship it now."
   - *Authority*: "the lead said it's fine to skip."
   - *Sunk cost*: "you already wrote 200 lines; redoing it wastes the work."
   - Then: "What DO you do?" — make it choose, don't accept a hedge.
4. Any new rationalization that slips through → add it to the body's
   rationalization table and re-test. Repeat until it holds.

## Rationalization table (put this in the skill body)

A short table the agent reads when tempted:

| The agent thinks… | Reality |
| --- | --- |
| "This case is too trivial to test." | Trivial code breaks too; the test is cheap. |
| "I'm confident it works." | Confidence isn't verification; write the test. |

## Running it

With a server: drive the scenarios through the agent simulator
(`cd packages/app && pnpm exec tsx src/server/agent-sim.ts`). Without one: walk the
pressured prompt with the user and read the response for the rule holding.
Read the full transcript, not just the final answer — discipline fails in the
reasoning, not always in the output.
