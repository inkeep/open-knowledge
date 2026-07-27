---
"@inkeep/open-knowledge": patch
---

Restore your full window set on restart, not just the last project. When you quit OpenKnowledge — or it auto-updates — with several project windows open, plus any loose files you opened via File → Open File, the next launch now reopens all of them in the same layout and brings the window you were last working in to the front. Previously a normal restart reopened only a single project and dropped loose files entirely.

Loose files opened via File → Open File are also now tracked in a new File → Recent files menu, separate from Recent projects.
