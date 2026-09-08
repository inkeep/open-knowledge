---
"@inkeep/open-knowledge": patch
---

Turning off a project's Agent Skill for one editor no longer deletes it for another that shares the same folder.

Each editor gets its own project skills folder, but some setups point two of them at one place — `.codex/skills` symlinked to `.agents/skills` is a common one. In that layout, removal followed the link: switching the skill off for Cursor deleted the bundle Claude was reading, and Claude's row went on showing it as installed. Removal now declines when the folder is shared, naming what shares it, rather than repointing a link you set up yourself. The shared `.agents/skills` hub counts too, since several tools read it directly. An alias that nothing else reads still removes normally.
