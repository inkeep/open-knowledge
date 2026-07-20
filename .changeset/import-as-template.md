---
'@inkeep/open-knowledge': patch
---

Add "Import as template" to the File Tree context menu. Right-click a markdown file to copy it into the folder's `.ok/templates/`, with the option to keep the original or convert it (delete the source). Backed by a new `POST /api/template/import` endpoint that carries over the source frontmatter.
