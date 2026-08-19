---
"@inkeep/open-knowledge": patch
"@inkeep/open-knowledge-server": patch
"@inkeep/open-knowledge-desktop": patch
---

Your home directory is no longer treated as a project by any entry point. Setting one up there ran `git init` in your home, wrote `config.yml` into `~/.ok/` (OpenKnowledge's own user-global directory), and landed project MCP config and skills on your editors' user-global paths, since at home every editor's project config path IS its global config. The refusal now lives in the two scaffold writers every path goes through, `ensureProjectGit` and `initContent`, so it covers `ok init`, `ok share publish --project-dir`, the desktop's Open Folder confirm, the desktop `ok-init` IPC, and `POST /api/local-op/ok-init`. Picking your home folder in the desktop is refused before the setup dialog opens, which also covers reopening a home "project" left behind by the old bug. And `ok deinit` refuses to run in your home directory, where it used to queue your entire user-global store for removal: `global.yml`, `skills/`, `auth.yml`, `secrets.yml`.
