---
'@inkeep/open-knowledge': patch
---

Source-mode diffs now render through Pierre instead of react-diff-view.

The Timeline "Source" toggle and the Agent Activity Panel share one diff
renderer, and on prose it read poorly: at the narrowest pane width it spent
more space on two gutter columns than it left for text, and it broke words
mid-token when wrapping. It also had no intra-line highlighting, so a
one-word edit inside a long paragraph showed up as two near-identical walls
of red and green with nothing marking what actually changed.

The new renderer gives a single gutter, wraps at word boundaries, and tints
the changed words inside the line. Syntax highlighting is deliberately off
for prose, where competing colours drown out the diff signal.

Two defects go with it: the change stepper could show an unreachable
denominator such as `4 / 3` because it measured Pierre's rows once and
latched, and opening a burst diff for one agent could show another agent's
diff on the same document, because the per-document cache key left the agent
out.

Line numbers are now hidden from screen readers on this surface. Pierre
renders the gutter and the content as separate columns, so without this a
screen reader announced every line number in a block before reaching any of
the text.
