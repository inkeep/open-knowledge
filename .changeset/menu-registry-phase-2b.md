---
"@inkeep/open-knowledge": patch
---

Internal refactor (no user-facing change): the native application menu now
renders its actionable command leaves from the same shared command registry the
Cmd+K palette uses, so each command's identity — label, accelerator, keyboard
shortcut, availability, and menu placement — is declared once in
`@inkeep/open-knowledge-core` instead of being hand-maintained in two lists.
Command availability is a pure, declarative evaluator both surfaces call; the
menu's structural scaffolding (roles, separators, submenus, the dynamic
Recent-project list, and the platform branches) stays declarative. The
"Check for updates" and "Settings" platform placements are now data-driven,
and a ratchet fails the build if a command is ever hand-placed twice in the same
platform's menu bar. Menu items, order, labels, accelerators, and enabled/checked
states are unchanged on every platform.
