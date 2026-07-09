---
"@inkeep/open-knowledge": patch
---

Windows: hide the remaining brief console windows that could flash during CLI and MCP operations. A recent release stopped the server's per-edit `git` reads from popping a console window; this extends the same hiding to the hand-rolled `child_process` spawns on the CLI side — the MCP host launching the server (`ok start`) and the UI (`ok ui`), the git worktree probe, project-root detection, `share` git calls, the `npm` uninstall step, the browser opener (`cmd /c start`), and diagnostics. Each now runs with the console hidden. No effect on macOS or Linux (the flag is a no-op there).
