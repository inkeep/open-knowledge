---
"@inkeep/open-knowledge": patch
---

`ok repair-skills` no longer creates project skill folders in directories that aren't projects. Run from your home directory, it used to read the user-global MCP configs at `~/.cursor/mcp.json` and `~/.codex/config.toml` as though they were project configs, and create two new project skill folders in your home while cleaning others out of it. Each editor is now skipped when its project config path resolves to that editor's own global config, which also covers the cases a home-directory-only check would miss: OpenCode's global config lives at `~/.config/opencode/`, and `CODEX_HOME` or `COPILOT_HOME` can move those globals anywhere. Colliding hosts are reported in the summary and still exit 0.
