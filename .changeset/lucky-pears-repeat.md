---
'@inkeep/open-knowledge-desktop': patch
'@inkeep/open-knowledge-core': patch
---

Fix "Reveal in Finder" for global skills and skill bundle folders. Global skills live outside every project (`~/.claude/skills`, `~/.agents/skills`, the plugin caches, `~/.ok/skills`), so the desktop's path containment silently refused every reveal from the Skills panel. Those roots are now admitted the same way the bug-report dir is. Nested bundle folders (`scripts/`, `references/`) also gain the Reveal item their sibling file rows already had.
