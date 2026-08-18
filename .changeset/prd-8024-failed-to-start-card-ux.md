---
"@inkeep/open-knowledge": patch
---

Fix the ACP failed-to-start surface. A retried launch that failed the same way each time used to stack three visually-identical `"Claude couldn't start · initialize failed: ACP connection closed"` cards in the transcript — with the real error buried under a wall of unrelated `npm warn …` lines behind a `Show details` toggle, and the `Retry` button only on the last card. The card now coalesces adjacent identical failures into one entry (with a subtle `(N attempts)` count), pulls the primary error line out of the stderr tail and surfaces it under the headline, and colorizes `error` / `warn` lines when the reader does expand the full detail. Retry is always on the active card because there's now only one.
