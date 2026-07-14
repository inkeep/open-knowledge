---
'@inkeep/open-knowledge': patch
---

**Terminal CLI launch rows now reflect what's installed.** Across every
launch surface — the header / tab-strip "New chat", the "Ask X" composer
button, and the "Open with AI" menus — the docked-terminal CLI rows are gated
on a PATH-detection probe, so you only see the CLIs you actually have (e.g. no
Codex or Cursor-agent row when they aren't on PATH). Claude always keeps its
row as an install anchor. The gate fails open: a CLI whose install state is
still unknown (probe pending, probe failure, or an older desktop bridge) stays
visible rather than being silently dropped, so a probe miss never hides a CLI
you have installed.
