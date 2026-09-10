---
"@inkeep/open-knowledge": patch
---

Prevent overlapping Git sync cycles from committing conflict markers and erasing merge conflict stages. Automatic Git commits now pause while a Git operation or unresolved conflicts need attention. The app shows a localized sync pause with recovery guidance, while edits continue to save locally.
