---
"@inkeep/open-knowledge": minor
---

Broken-link handling is now configurable, and dead links get a one-shot fix. A new **Content rules** tab under Settings → This project holds two project-shared knobs: how broken internal links are reported — hidden, warning (the new default, since a broken link is often a typo or a page-yet-to-be-written), or error — and whether the file explorer tints and badges files that have problems. Both persist as `validation.*` in config.yml; lint plugins keep their own tab. In the Problems panel, every dead-link row (doc and project scope) now offers a **Create page** action that creates the missing target — the same action as the Links panel's missing-page affordance, surfaced where the problem is listed. It is deliberately not part of Fix all: bulk-creating targets could silently mint duplicate files, so creation stays a per-row decision.
