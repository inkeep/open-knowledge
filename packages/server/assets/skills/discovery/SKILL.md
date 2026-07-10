---
name: open-knowledge-discovery
description: "Read when the user asks what OpenKnowledge is, wants to install it on a repository, wants to share an OpenKnowledge project with collaborators, or asks how `ok init` / `ok cowork` / OK Desktop set up a project. Do NOT load to perform OpenKnowledge reads/writes — the runtime guidance for editing markdown inside an initialized OK project ships as a separate project-local skill at `.claude/skills/open-knowledge/` whenever `ok init` runs. If the user appears to be editing markdown inside a `.ok/` project and this is the only OK skill loaded, advise them to re-run `ok init` to install the project-local skill."
compatibility: "Any agent host — no MCP server required. Pure discovery + install guidance."
metadata:
  version: "0.29.0"
  author: "Inkeep"
  repository: "https://github.com/inkeep/open-knowledge"
---
# OpenKnowledge — what it is and how to install it

OpenKnowledge (OK) is a markdown-CRDT collaboration platform. It turns a
directory of `.md` / `.mdx` files into a live, multi-writer knowledge base:
agents and humans edit the same documents in real time, every change is
attributed, and a browser preview renders edits as they land.

This skill covers **discovery, install, and opening OpenKnowledge files** —
including single files that are not part of a project (see *Opening a file
outside a project* below). It does **not** carry the in-project read/write
runtime contract (the STOP rules for native file tools, the grounding and
linking rules, the MCP routing table) — that ships separately as the
project-local skill installed by `ok init` (see *Working inside a project*
below).

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

## Opening a file outside a project

OpenKnowledge can open a single markdown file that is **not** part of an OK
project — a loose `.md` / `.mdx`, **or a file that lives inside a regular
repo/folder which was never `ok init`'d**. It opens in a throwaway session (a
temp project in the OS temp dir — your repo is never touched, no `.ok/` is
written into it) with the same live preview you get inside a project.

**Never run `ok init` just to view or open a file.** `ok init` turns a repo
into a shared OpenKnowledge project; it is not a prerequisite for opening one
file. Opening a file needs no project, no `.ok/`, and no server already
running — each path below boots the session itself.

When asked to open or preview such a file, **decide by the viewing surface you
actually have** — check the tool, not the host name. Only open a browser when
you genuinely have one; never pop a browser tab on a host that has none.

- **You have an in-app / built-in browser** (Cursor, Codex, and similar) — this
  is the default: call the **`preview_url` MCP tool** with `file` set to the
  absolute path (it finds, or boots on demand, the session and returns a full
  `url`), then **immediately open that `url` in your in-app browser**. "Open it"
  means navigate your browser — don't just print the URL and stop. This is also
  the only way to view it in a browser when the OK Desktop app is installed
  (`ok open` prefers the Desktop app). Get the URL from `preview_url` only —
  never hunt for it via `ok ps` / `ok status` / `ok ui` / `ok start` or a guessed
  port.
- **You have a Claude Code Desktop preview *pane* but no general browser** — the
  pane is project-only: it shows in-project docs via `preview_start`, but it
  **cannot host a file from outside the project**. For such a file run
  `ok open /abs/path/to/file.md` (the Desktop app) instead; don't try to force
  the file into the pane.
- **No in-app browser and no pane** (a pure-stdio CLI) — run
  `ok open /abs/path/to/file.md`: it opens the Desktop app when installed, else a
  browser, and boots the session itself. Don't force a browser tab the user
  didn't ask for; `ok open` is the right default here. If `ok` isn't on PATH,
  `npx @inkeep/open-knowledge open /abs/path/to/file.md` does the same.

If the OK MCP server isn't wired into this host there is no `preview_url` to
call — use the `ok open` path above. Don't reconstruct what `preview_url` does
by hand (spawning `ok mcp` yourself, scraping ports from `ok ps`).

The path must be absolute (a file outside a project has no cwd to anchor a
relative path). Re-opening the same file lands on the same session. Never
construct or guess the URL — use the one `preview_url` returns.

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
