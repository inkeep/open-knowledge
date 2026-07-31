---
'@inkeep/open-knowledge': minor
---

Editing the globs that scope a frontmatter schema to a set of docs got three fixes, all from the same root: once you pressed Enter, the pattern became something you could neither read accurately nor change.

**Patterns read as you typed them.** A committed pattern was displayed in capitals — `blog/**` rendered as `BLOG/**`. The pattern on disk was always correct, so nothing was ever scoped wrong by this, but globs are case-sensitive and the display gave you no way to confirm what you had actually saved. The same fix reaches every place these value pills are used, including the schema editor's "Allowed values", where an enum of `Draft` / `Published` was shown as `DRAFT` / `PUBLISHED`.

**Double-click a pattern to edit it.** Correcting `blog` to `blog/**` meant deleting the entry and retyping it from scratch. Double-clicking a pattern now lifts it back into the input with the text selected; the corrected pattern is written back in its original position, so an exclude that only applies to the includes before it stays where you put it. Enter or Space does the same thing from the keyboard, and Escape cancels.

**Problems point at the glob that caused them.** A pattern matching zero docs was reported in a "Configuration problems" list that named the pattern but not which schema's input it came from — with several schemas and several globs each, you could see something was wrong without being able to tell what to fix. The offending pattern is now marked on the input itself, with the reason on hover, and that is its only home. Deleting a flagged pattern no longer flashes a warning about it on the way out: the problems channel is composed from the file on disk and briefly lags the edit, so a pattern you just removed still had a live finding for a moment. Problems about the schema file rather than a glob still appear in the list.
