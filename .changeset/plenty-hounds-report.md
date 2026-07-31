---
"@inkeep/open-knowledge": patch
---

Count skill installs on skills.sh, and let the MCP verbs reach every file a skill ships.

Installing a skill you found on skills.sh never registered with the marketplace you chose it from, so its install count — the signal its listing ranks on — stayed flat no matter how many people installed through OK. Explore installs now report to skills.sh. So do built-in and starter-pack skills, once per skill per machine, never on the launch reclaim. A hand-typed `owner/repo` is not reported: you never visited the marketplace, so it is not told what you installed. Turn it off in Settings → Preferences, or with `DO_NOT_TRACK` / `DISABLE_TELEMETRY`. Private and local sources are never reported.

Separately, the MCP `write` / `edit` / `delete` verbs and the `skills({ name, file })` read only accepted paths under `references/` or `scripts/`, while an import writes a skill's whole directory verbatim. OK could install a skill and then refuse to open its own files — `mattpocock/skills/grill-me` ships `agents/openai.yaml`. Any path that stays inside the skill dir is now accepted; the traversal, absolute-path and NUL guards are unchanged.
