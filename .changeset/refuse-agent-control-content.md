---
"@inkeep/open-knowledge-core": patch
"@inkeep/open-knowledge-server": patch
"@inkeep/open-knowledge": patch
---

Document, template, skill-body and Markdown bundle-file writes now reject unsupported control characters with actionable errors, including template writes from agents and the app. Stored bytes are not rewritten; existing templates, skills and Markdown bundle files must have these characters removed before full saves or edits.
