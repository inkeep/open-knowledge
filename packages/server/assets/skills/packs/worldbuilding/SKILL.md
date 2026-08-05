---
name: worldbuilding
description: "How to work in a Worldbuilding project (the `worldbuilding` starter pack): a fiction encyclopedia of characters, settings, themes, factions, and lore. Read when the project has these folders, OR when asked to add a character, setting, faction, or piece of lore, or to check the world for internal consistency. Carries the auto-stub and consistency behaviors so that guidance does not live inside template bodies or folder descriptions. Complements the platform `open-knowledge` skill; does not replace it."
compatibility: "Claude Code, Claude Desktop, Claude Cowork, Claude.ai web. Requires OpenKnowledge MCP server. Installed project-local by `ok seed --pack worldbuilding`."
metadata:
  pack: "worldbuilding"
  author: "Inkeep"
  repository: "https://github.com/inkeep/open-knowledge-skills"
---
# Worldbuilding pack — how to work here

This project is a fiction encyclopedia. The graph is the product: characters, settings, themes, factions, and lore that link to each other. The agent's main jobs are auto-stubbing new entities as they're mentioned and flagging contradictions. This skill holds those behaviors so templates and folder descriptions stay clean.

> This skill is pack guidance. The platform `/open-knowledge` skill (read/write/preview/linking/grounding rules) still governs every markdown operation — this layers the worldbuilding conventions on top.

## Folders

- **`characters/`** — one file per character (PC + NPC); frontmatter carries type, status, faction, first appearance.
- **`settings/`** — locations, regions, world-rules; frontmatter carries region, controlling faction, danger level. The "where" of the story.
- **`themes/`** — recurring narrative concerns (love, betrayal, identity). The "why." Themes work via opposition; each entry captures the theme and its tension.
- **`factions/`** — political, social, criminal, magical, religious groups. Ships `faction`, `political-faction`, and `religion` templates.
- **`lore/`** — history, mythology, cosmology, magic systems. Ships `lore`, `magic-system`, and `historical-event` templates.

## Agent behaviors (the core value)

- **Auto-stub on mention.** When a chapter, session log, or existing entry references a name not yet captured, stub a file in the right folder with backlinks to where it was mentioned.
- **Flag contradictions.** When a character's `faction` (or any field) contradicts their actions in narrative, or a setting is described two ways, surface the conflict — in fiction a contradiction is itself a story-shaping detail worth noting, not silently "fixing."
- **Thread the graph.** Link characters ↔ factions ↔ settings ↔ lore so each entry becomes a hub for everywhere it appears.
- Do NOT add TTRPG stat-block fields (`xp_awarded`, etc.) — those belong in a future TTRPG variant.

## Templates

Create with `write({ document: { path, template: "<name>" } })`. Templates carry only structure; section meaning is described here, not inside the document body.
