---
"@inkeep/open-knowledge": minor
---

Refuse a whole-document replace, writing nothing, when an editor or a different agent just changed the document, including when the replace sends no `agentId`. Wait a few seconds and retry, or write with position `append` or `prepend`, which are not refused.
