---
'@inkeep/open-knowledge-app': minor
---

Page-top cover images now read `banner:` in addition to `cover:` (Obsidian vaults with `banner`/`banner_y` plugin frontmatter light up without a rename). Adds a vertical focal-position control: drag the cover up or down to reframe, or focus it and use arrow keys / Home / End for keyboard adjustment. The chosen position writes to `banner_y` (or `cover_y`, matching the source key) as a 0.0–1.0 float, the Obsidian convention.
