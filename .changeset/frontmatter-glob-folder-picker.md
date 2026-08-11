---
"@inkeep/open-knowledge": patch
---

Frontmatter schema mappings can now be scoped by picking folders from a checkbox tree instead of hand-writing globs. Each schema row in Settings → Plugins → Frontmatter schemas gains a "Pick folders" button that shows the project's folder tree with per-folder doc counts; checking a folder writes the `folder/**` pattern it stands for, and the generated glob stays visible in the pattern list next to anything written by hand, which remains untouched as the power-user escape hatch. The plain-language summary under the patterns now also reports "Matches N of M docs right now", computed live against the project's actual documents — so a bare folder name like `blog` (which matches nothing; the pattern needs to be `blog/**`) is visible as "Matches 0 of M docs" the moment it's typed, instead of only after the server's zero-match warning lands.
