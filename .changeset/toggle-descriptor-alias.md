---
'@inkeep/open-knowledge': minor
---

Register `<Toggle>` as a canonical block descriptor — Notion-style vocabulary alias for `<Accordion>`. Same props (`title`, `defaultOpen`, `icon`, `description`, `id`, `name`, children), same expand/collapse component; the two descriptors serialize under their own JSX names so `<Toggle>` and `<Accordion>` both round-trip without rewriting. `/toggle` in the slash menu now inserts a first-class `<Toggle>` instead of routing to `<Accordion>`.
