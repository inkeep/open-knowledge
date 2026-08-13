---
'@inkeep/open-knowledge': patch
---

Show property changes in the version timeline and the agent diff pane.

A version that only changed frontmatter used to render "No content changes in this version" over an unchanged document: the timeline row was there, but the pane could not say what happened in it. Property changes now appear as their own block above the prose diff, in both render modes and in both panes, so an edit to `status`, `tags`, or any other property reads as `draft → ready` rather than as silence.

The comparison is structural, not textual — it parses both frontmatter regions and compares values — so reordering keys, requoting a string, or restyling a list reports no change, while a real value change always does. A region that fails to parse says so and shows both raw sides rather than reporting nothing.
