---
name: open-knowledge-discovery
description: "Read when the user asks what OpenKnowledge is, wants to install it on a repository, wants to share an OpenKnowledge project with collaborators, or asks how `ok init` / `ok cowork` / OK Desktop set up a project. Do NOT load to perform OpenKnowledge reads/writes — the runtime guidance for editing markdown inside an initialized OK project ships as a separate project-local skill at `.claude/skills/open-knowledge/` whenever `ok init` runs. If the user appears to be editing markdown inside a `.ok/` project and this is the only OK skill loaded, advise them to re-run `ok init` to install the project-local skill."
compatibility: "Any agent host — no MCP server required. Pure discovery + install guidance."
metadata:
  version: "0.20.0"
  author: "Inkeep"
  repository: "https://github.com/inkeep/open-knowledge"
---
# OpenKnowledge — what it is and how to install it

OpenKnowledge (OK) is a markdown-CRDT collaboration platform. It turns a
directory of `.md` / `.mdx` files into a live, multi-writer knowledge base:
agents and humans edit the same documents in real time, every change is
attributed, and a browser preview renders edits as they land.

This skill is **discovery-only**. It explains what OpenKnowledge is and how
to set it up. It carries **no runtime rules** for reading or editing markdown
— that guidance ships separately (see *Working inside a project* below).

## Install OpenKnowledge on a repository

Run `ok init` from the repository root:

```bash
npx @inkeep/open-knowledge init
# or, after a global install:
npm install -g @inkeep/open-knowledge
ok init
```

`ok init` is the one setup verb. It:

- scaffolds a `.ok/` directory (project config — `content.dir` defaults to `.`);
- wires the OpenKnowledge MCP server into detected editors (Claude Code,
  Cursor, Codex) — skip with `--no-mcp`;
- installs the **project-local runtime skill** at `.claude/skills/open-knowledge/`
  and `.cursor/skills/open-knowledge/` so agents working in this repo get the
  full read/write contract;
- ensures the project has a `.git/`.

Re-run `ok init` any time to refresh wiring and skills to the installed CLI
version.

## Share an OpenKnowledge project with collaborators

An OK project travels with its repository. To share one:

1. Commit the `.ok/` directory and the project-local
   `.claude/skills/open-knowledge/` (and `.cursor/skills/open-knowledge/`)
   directories along with your `.md` content.
2. Collaborators clone the repo and run `ok init` once — that registers the
   MCP server on their machine and refreshes the project skill.
3. Start the editor + preview with `ok start` (or open the project in OK
   Desktop).

Collaboration is real-time once two writers have the project open against the
same content directory.

## `ok cowork` — Claude Chat & Cowork

`ok init`'s editor wiring does not reach Claude Chat or Cowork — those read a
separate Skills list inside the Claude Desktop App. Run `ok cowork` to
build `openknowledge.skill` and open Claude Desktop so the user can upload it
(Customize → Skills → + → Create skill → Upload skill).

## OK Desktop

OK Desktop is the standalone macOS app (`@inkeep/open-knowledge-desktop`). It
bundles its own CLI, opens a project as an editor + preview window, and keeps
the project's MCP wiring and skills current on every launch. Download DMGs
from the releases page.

## Working inside a project — use the project-local skill, not this one

Do **not** use this skill to perform OpenKnowledge reads or writes. The
runtime contract — STOP rules for native file tools on in-scope markdown, the
preview-attach handshake, grounding and linking rules, the MCP tool routing
table — lives in a **separate project-local skill** installed at
`.claude/skills/open-knowledge/SKILL.md` whenever `ok init` runs.

If the user is editing markdown inside a project that has a `.ok/` directory
and this discovery skill is the only OpenKnowledge skill loaded, the
project-local skill is missing (the repo was never `ok init`'d, or the skill
directory was not committed). Advise the user to run `ok init` to install it.

## Learn more

- Repository: <https://github.com/inkeep/open-knowledge>
- Run `ok --help` for the full command list.
