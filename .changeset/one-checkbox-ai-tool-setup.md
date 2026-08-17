---
'@inkeep/open-knowledge': patch
---

Setting up your AI tools is now one checkbox instead of a checklist.

The first-launch screen used to ask for a row-by-row audit — a checkbox per tool
(including tools you don't have), a checkbox per skill, and a Skip button that
meant something subtly different from unchecking everything. Now it's a single
pre-checked box covering every tool we found, with a "What this changes" expander
listing the exact files it writes. Adding `ok` to your terminal stays a separate
checkbox, since that's an unrelated decision. The same treatment applies when you
create a project: the AI-tool choice moves out of Advanced settings and becomes
one checkbox with the same disclosure.

You see more than before, not less. The checkbox names every tool it will write
to whether or not you expand it, and if setup would replace an existing
OpenKnowledge entry, that warning sits right next to the checkbox.

It also only names tools it can actually set up. Creating a project used to
offer tools that take no per-project setup at all — Claude Desktop, OpenClaw,
Antigravity, LM Studio, Hermes — where ticking the box did nothing. Copilot is
listed once its OpenKnowledge connection exists, since until then its project
skill can't load.

Two behavior changes worth knowing: onboarding no longer installs the
`open-knowledge-write-skill` bundle — it's an authoring convenience, so it now
waits for you to turn it on in Settings, and any copy you already have is left
alone. And declining setup never removes anything: it writes nothing and tears
nothing down. Removal lives in Settings, where the row tells you what it removes.
