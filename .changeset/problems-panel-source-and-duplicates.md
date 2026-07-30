---
"@inkeep/open-knowledge": patch
---

The Problems panel now names the validator behind each finding instead of tagging every row `LINT` — a frontmatter-schema failure reads `FRONTMATTER` and a markdownlint rule reads `MARKDOWNLINT`, so the two are distinguishable at a glance (the chip carries the producer, so the line below it now shows the bare rule code). Repeated findings collapse into one row with an instance count ("Frontmatter property is missing · 10 instances") that expands to the individual lines, each keeping its own Fix and Ask AI actions, instead of burying the rest of the plane under identical rows. The project-scope refresh icon finally explains itself on hover.
