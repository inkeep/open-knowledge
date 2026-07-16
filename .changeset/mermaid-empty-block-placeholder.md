---
"@inkeep/open-knowledge": patch
---

Fix the Mermaid slash command inserting an invisible, zero-height block. Selecting Mermaid from the `/` menu previously dropped a near-zero-height sliver: nothing appeared to happen, repeated inserts stacked invisibly, and the hover toolbar (edit / delete) was clipped. An empty Mermaid block now renders a clear "Add a Mermaid diagram" placeholder card and opens the diagram source editor on insert, so there is always a visible, adequately-sized target to author or remove.
