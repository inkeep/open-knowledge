---
"@inkeep/open-knowledge": patch
---

Runtime warnings from Codex now read as status instead of as part of the agent's answer. When Codex reports something mid-turn, such as skill descriptions being shortened to fit its context budget or invalid entries being ignored in `config.toml`, that text used to arrive in the transcript as ordinary assistant prose, so it looked like something the agent had said.

Those warnings now get their own inline card at the point in the conversation where they arrived, carrying a "Warning" label, a warning glyph, and a border that stays visible under high contrast and forced colors, so the severity never depends on seeing the amber tint. The wording is the agent runtime's own, left as it was sent, and the answer that follows stays separate.

The card is passive. There is no toast, no banner, no dismiss control, and nothing to retry. It lives in the transcript, so reopening a thread started on this version shows the warning again in its original place. Threads recorded before this version can still show an older warning as ordinary prose, because their transcripts were stored that way. A screen reader hears the opening line of each newly arrived warning once, in the order the warnings arrived, with the full text left on the card, while reopening a past thread stays silent and keyboard focus never moves.

Only the exact warning format of Codex added from the agent registry is treated this way. Everything else renders exactly as it did before, including a reply that happens to begin with the word "Warning", a Codex you configured yourself, and warnings from other agents.
