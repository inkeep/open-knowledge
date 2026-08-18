---
"@inkeep/open-knowledge": patch
---

Fix Claude Agent (and any npx-launched ACP agent) failing to start in the desktop app when OK is run through `pnpm dev`. pnpm broadcasts its `pnpm-workspace.yaml` `overrides` block to every child via `npm_config_overrides`, in pnpm's flat `parent>child` key shape. The ACP subprocess re-entered npm through `npx exec`, arborist rejected the flat key, and launch crashed with `npm error Override without name: <parent>><child>`. Agent launch now drops that one env var before spawn; every other npm env — user-set (`npm_config_userconfig`, nerf-darted auth tokens) or merely-warning pnpm broadcasts — still reaches the spawned agent.
