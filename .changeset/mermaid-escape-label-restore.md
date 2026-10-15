---
"@inkeep/open-knowledge": patch
---

Cancelling a Mermaid label edit with Escape now restores the label exactly as the diagram showed it. Before, the editor read the label's source text as HTML, which skipped Mermaid's sanitizer.
