---
'@inkeep/open-knowledge': minor
---

Remove the deprecated `ok ui` command and the sibling UI spawn machinery. Plain `ok start` has served the editor UI, API, and MCP on one port since the single-listener flip, and the Desktop attaches via server.lock v2 — the two-process sibling model is gone.

- `ok ui` no longer exists. If you were running it directly, run `ok start` instead; if a tool spawned it for you (an old `.claude/launch.json` entry), re-run `ok init` or delete the stale entry — current OK never scaffolds one.
- `ok start` drops `--ui-port` (the worktree-preview sibling recipe) and no longer auto-spawns a UI sibling in any mode. `--only ui --server-url` (the explicit split-mode proxy) still works but now prints a deprecation notice; it will be removed together with `ui.lock` in a later release.
- The clone/open flow that previously spawned `ok ui` next to a headless server now resolves the redirect from `server.lock` directly. A server started with `--only server` reports "no UI mounted — restart with plain `ok start`" instead of spawning a sibling.
- Operator and agent hints that pointed at `ok ui` (404 pages, MCP preview messages, CLI errors, config-migration redirects) now point at `ok start`.

`ui.lock` is still written and read for compatibility; it retires in a follow-up release.
