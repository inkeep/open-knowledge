# Answering direct questions from the corpus

A direct question you can answer from existing documents — "which customers have non-standard indemnity?", "can we use Alloy's logo?", "what did we decide about X?" — does **not** need the words "research" or "report" to route here. Retrieve with `search` / `exec`, read the relevant docs, and **answer in chat with inline citations to the source docs you used**. That is the complete, correct default — most questions end here. This is NOT the **research** layer: research gathers and synthesizes *external* sources behind a scoping gate; a corpus question just reads what the knowledge base already holds. (Inside an active research pass, research's own "file valuable Q&A back" step governs how answers are persisted — not this section.)

**Offer to persist the answer only when it is durable knowledge the KB is currently missing** — when ALL of these hold:

- it **synthesizes across multiple docs** or surfaces a non-obvious fact a reader couldn't get from a single doc in one read — two docs that independently state the *same* fact are NOT synthesis; synthesis means combining information no single source holds in isolation;
- it's **reusable** — likely to be asked again, or it records a decision / reference others will need;
- **no existing doc already answers it** — scan first (`search`, `exec("grep …")`); if one does, point the user to it instead of writing a near-duplicate;
- the answer is **sourced** per §Grounding, not speculation.

When all hold, *offer* — don't write yet: "This pulls together [N docs] — want me to save it as `<slug>.md` under `<folder>` so it's findable next time?" On a yes, `write` it with frontmatter + inline citations to the source docs (§Grounding, §Linking). **Never auto-create the page.** A single-doc lookup, a navigational question, or anything you'd hesitate to call durable does NOT warrant an offer — answer in chat and stop; don't even prompt to save it. When in doubt, stay in chat: a missing page costs one re-query; a junk page pollutes the corpus permanently.

**Headless / no user to ask** (autonomous run): still produce the answer — surface it with inline citations in the tool / run output as you would in chat, so the run log is the record. Default to NOT persisting unless the four criteria are unambiguously met; never persist on a maybe.
