---
"@inkeep/open-knowledge": patch
---

Setting up OpenKnowledge in an existing folder now asks about AI tools the same way creating a new project does: one checkbox covering the tools found on your machine, with a "What changes?" list of the exact files it writes. It replaces a list of eleven per-tool checkboxes buried in Advanced settings, and it fixes what that list promised. Five of those tools — Claude Desktop, OpenClaw, Antigravity, LM Studio and Hermes — only ever store settings for your whole account, never per project, so ticking them here wrote nothing at all; GitHub Copilot was listed the same way before it had been connected, when its project skill cannot be installed yet. Accepting the defaults also created config files for tools you don't have installed, scattering `.codex/`, `.opencode/` and `.pi/` folders into repositories that never asked for them.

The row now sits in plain view rather than behind Advanced settings — whether your project is reachable from your agents at all is not an advanced setting. Turning off individual tools still lives in Settings, under This project, where each row says what it writes and can be switched off again later.
