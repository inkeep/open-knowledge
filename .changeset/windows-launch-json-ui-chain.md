---
'@inkeep/open-knowledge': patch
---

Make the `open-knowledge-ui` entry in `.claude/launch.json` launchable on Windows. Previously `ok init` always wrote a `/bin/sh` chain, so Claude Code Desktop's preview pane could not start the OpenKnowledge UI on Windows (there is no `/bin/sh`). On Windows, `ok init` now scaffolds a `powershell -NoProfile -NonInteractive -Command <chain>` entry that resolves the npm-global `ok.cmd` shim first, then `npx.cmd`, then common version-manager/installer paths, and runs `ok start --ui-port` so the opened folder gets its own collab server. The `ok start` launch.json repair sweep now recognizes both platforms' canonical shapes on every OS, so a `launch.json` committed on one platform is never rewritten back and forth by the other, and custom entries are still preserved.
