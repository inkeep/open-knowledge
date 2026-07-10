---
"@inkeep/open-knowledge": minor
"@inkeep/open-knowledge-core": minor
"@inkeep/open-knowledge-server": minor
"@inkeep/open-knowledge-app": minor
"@inkeep/open-knowledge-desktop": minor
---

Remove the launch.json preview machinery and the pane-target arming subsystem. Claude Code Desktop's in-app Browser pane now opens the preview URL directly (`preview_start({url})` + `navigate({url})`), so OK no longer scaffolds `.claude/launch.json`.

Breaking for consumers: the `@inkeep/open-knowledge` package drops the `scaffoldLaunchJson`, `LAUNCH_UI_CHAIN_*`, and `LaunchJsonResult` exports; the `preview_url` MCP tool drops the `armPaneTarget` param; and the `/api/config` response drops the `paneTarget` field. The `ok start` repair sweep now removes any pre-existing `open-knowledge-ui` launch.json entry instead of rewriting it.
