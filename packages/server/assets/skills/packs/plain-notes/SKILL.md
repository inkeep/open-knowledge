---
name: open-knowledge-pack-plain-notes
description: "How to work in a Plain Notes project (the `plain-notes` starter pack): a flat notes/ folder plus a daily/ journal. The 'I just want to write' layout. Read when the project has these folders, OR when asked to jot a note, capture a quick thought, or write today's journal entry. Carries the linking habit and daily-entry behavior so templates and folder descriptions stay minimal. Complements the platform `open-knowledge` skill; does not replace it."
compatibility: "Claude Code, Claude Desktop, Claude Cowork, Claude.ai web. Requires OpenKnowledge MCP server. Installed project-local by `ok seed --pack plain-notes`."
metadata:
  pack: "plain-notes"
  author: "Inkeep"
  repository: "https://github.com/inkeep/open-knowledge"
---
# Plain Notes pack — how to work here

The lightest pack: no posture imposed, just write and link.

> This skill is pack guidance. The platform `open-knowledge` skill (read/write/preview/linking/grounding rules) still governs every markdown operation — this layers the notes habit on top.

## Folders

- **`notes/`** — one file per topic, flat. Promote a note into a more structured layout later if you outgrow this.
- **`daily/`** — one journal entry per day (`YYYY-MM-DD.md`): morning intentions, capture through the day, evening reflection.

## Agent behaviors

- **Link liberally.** The value of this pack is the graph that emerges from links — when a note or entry mentions something worth its own page, link it (stub the page if it doesn't exist yet). OK's link graph builds itself from those edges.
- **Daily entries:** on the first entry of a day, link to yesterday's entry (its own dated file, e.g. `2026-07-08.md`) and pre-fill the date, so the linear journal is also a navigable graph.
- The `mood`, `top3`, and `gratitude` frontmatter fields on daily entries let you look back across days; fill them when journaling.

## Templates

`note` and `daily` carry only structure; write freely.
