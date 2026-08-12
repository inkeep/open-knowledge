---
"@inkeep/open-knowledge": patch
---

Wiki-links to notes whose filename contains a dot now open the note. Previously `[[acp.daemon]]` read the text after the dot as a file extension, so the link was treated as a file rather than a document and opened a viewer for a file type that doesn't exist, ending in a 404 — even when the note sat in the same folder. Namespaced and versioned names like `acp.daemon` or `v1.2 release` are common in imported vaults, so this met people on their first click.

The Problems panel and `links({ kind: "dead" })` now agree with what the editor actually opens. A link that resolves by bare name is no longer reported broken, and a wiki-link that genuinely cannot be resolved is no longer silently omitted from the report — previously the two were inverted, flagging working links while staying quiet about broken ones. Write-time `brokenLinks` uses the same resolution, so it can only ever retract a report, never add one. Links naming a real asset, and wiki-embeds, behave exactly as before.

Two documents in different folders that share a filename now always resolve to the same one of them, in the editor and in the dead-link report alike. The tie-break no longer depends on the machine's locale, so a name can no longer resolve to different documents on different computers.

Note: the extension-qualified form `[[acp.daemon.md]]` still does not resolve — it fails for a separate reason and is not covered by this change.
