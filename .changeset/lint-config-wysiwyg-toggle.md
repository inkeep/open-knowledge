---
"@inkeep/open-knowledge": patch
---

Opening a JSON markdownlint config file (`.markdownlint.json` / `.markdownlint.jsonc`) now offers a toggle between a **Source** view and a **Rules** view. Source is the raw, read-only file (comments, `extends`, and formatting intact); Rules is the same searchable rule browser as Settings — flip rules on or off and edit their options, with changes written back to the file through the format-preserving writer (comments, `extends`, and trailing commas are preserved). Rule editing targets the project's root config, so a nested or not-yet-created config opens in Source with the Rules option disabled and an explanation. Your Source/Rules choice is remembered per user, separately from the markdown editor's own mode.
