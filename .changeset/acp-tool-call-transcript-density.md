---
"@inkeep/open-knowledge": patch
---

Quiet the agent thread transcript: tool calls, permission prompts, and thoughts now signal by exception instead of decorating every row.

Permission prompts lay out as at most three controls — refusal pinned far left, the least-privilege grant far right, and every escalating grant collapsed into a secondary split button beside it. Options are grouped by stance rather than by looking up one option per `kind`, since ACP treats `kind` as a styling hint and agents do offer several grants that differ only by name ("Allow for This Session" vs "Allow and Don't Ask Again"). The card is neutral rather than amber, and a settled prompt whose gated tool call is in the transcript now renders on that call's row instead of as a second card restating the tool name; a prompt whose call never appears keeps its standalone card so an outcome is never unreachable.

Tool calls render collapsed, with failures the exception that opens itself. Completion is no longer badged — a call that finishes while you watch flashes a check that fades, and a replayed transcript carries no per-row status chrome at all, so the one row that failed is the one that stands out. Status still reaches assistive technology in every state. A row only draws its border when expanded, calls with nothing to reveal are no longer interactive controls, and consecutive calls sit tighter as a single burst of activity. An approval leaves no trace; a refusal says so in words, and only when the row's own status does not already explain it.

Agent thoughts parse markdown instead of printing literal `**` around the summary line agents prefix them with, with emphasis flattened so a thought stays quieter than the reply. Code renders one size down to sit optically level with surrounding prose, and a markdown fence wrapping a whole tool-output block no longer leaves its backticks on screen.
