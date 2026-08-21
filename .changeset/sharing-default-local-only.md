---
"@inkeep/open-knowledge": minor
---

New projects now keep their OpenKnowledge config to yourself by default. Setting up a project asks whether to share that setup with your team, and the answer now starts at **Only me**, so `.ok/`, `.mcp.json`, and the project skills are written but excluded from git until you choose to share them. Previously the answer started at **Shared**, which meant a user who never opened the setting committed their config by omission.

This applies to both entry points. `ok init` uses the new default when it is scaffolding a project for the first time; re-running it on a project that already has `.ok/` keeps whatever posture that project is in, so a scripted re-run cannot un-share a team's repo. The desktop app's setup dialogs pre-select the same option, and both still take an explicit answer: `ok init --shared` (or `--local-only`), the prompt in an interactive terminal, or the radio cards in the dialogs.

If you rely on a committed `.mcp.json` — Claude Code's cloud routines do, since they run against a fresh clone and see only what is committed — choose **Shared** during setup, or run `ok config-sharing share` afterwards. `ok config-sharing status` prints the mode a project is in and the paths it excludes.
