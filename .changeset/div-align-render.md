---
"@inkeep/open-knowledge": minor
---

GitHub-style `<div align="center">` wrappers now render the way GitHub shows them: the tag lines disappear and everything between them — headings, text, badge images — actually centers (left/right/justify work too). The content inside stays fully editable, and the `<div align>` markdown is preserved byte-for-byte on disk. Divs with other attributes keep their literal rendering.
