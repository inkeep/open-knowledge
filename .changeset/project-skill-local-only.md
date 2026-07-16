---
"@inkeep/open-knowledge": patch
---

Stop OpenKnowledge's built-in `open-knowledge` project skill from causing recurring git sync conflicts. The app regenerates that skill into each editor's host dir (`.claude/skills/open-knowledge/`, `.cursor/…`, `.codex/…`, `.github/…`, `.opencode/…`, `.pi/…`) on every open, and different app builds stamp a different version into it — so when it was committed, teammates on different builds collided under git auto-sync (merge conflicts, or a repeatedly "paused, external changes pending" sync).

It is now treated as a local, per-machine artifact. On `ok init` and on project open, OpenKnowledge writes a committed `.gitignore` entry that always excludes this projection (in both shared and local-only sharing modes, and it travels to every clone so a fresh checkout is protected before the app ever runs). Nothing is lost, since the app regenerates the file on each open. For repos where the skill was already committed, opening the project untracks it automatically via a dedicated, conflict-safe commit; teammates will see it removed on their next pull. Authored skills you place under `.{editor}/skills/<your-name>/` are unaffected and continue to follow your OpenKnowledge sharing setting.
