---
'@inkeep/open-knowledge': patch
---

Settings rows with a label and a description now have room to breathe: vertical padding goes from 8px to 12px, and the description drops to the 13px scale the rest of the settings dialog already uses. Previously the label and its description rendered at the same size in a tight row, so each entry read as one flat block — the "markdownlint entry looks crowded" report.

Screen readers now announce what a setting actually does before you change it. The Plugins, Content rules, Search, and Link previews toggles are each wired to their own row description — previously that description was shown on screen but never announced, so the semantic-search and link-preview toggles in particular gave no spoken indication that turning them on sends content off your machine.
