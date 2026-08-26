# Folder model — frontmatter + templates structure

(Core carries the MUST gates: read the folder before writing, use a template when one fits, bake recurring properties into a template. This file is the structural model.)

Every `.md` / `.mdx` file needs YAML frontmatter — `title` + `description` required, `tags` recommended (except in OKF projects, where the `okf` pack's reserved-file rules override this — see core):

```yaml
---
title: Article Title
description: Brief summary
tags: [relevant, tags]
---
```

Two folder mechanisms, both opt-in and nested: **folder frontmatter** in `<folder>/.ok/frontmatter.yml` (the folder's own properties — open-shape like a doc's, with `title` / `description` / `tags` as conventional keys the UI surfaces; describes the folder, self-only, does NOT flow into child docs) and **templates** in `<folder>/.ok/templates/` (the single mechanism for what new docs in a folder start with). **Most folders have NO `.ok/`** — sparse, lazy-create, auto-clean. A folder gets one only when it carries its own frontmatter or a template.

```
content-root/
├── .ok/                        ← project root .ok/ (config.yml, cache)
├── meetings/
│   ├── .ok/
│   │   ├── frontmatter.yml     ← this folder's own title/description/tags
│   │   └── templates/
│   │       └── prep-notes.md   ← what new meeting docs start with
│   └── 2026-05-01.md
└── research/                   ← no .ok/
    └── auth-providers.md
```

A doc's frontmatter is exactly its own on-disk YAML — folder frontmatter never overlays values onto it. Give new docs starting properties with a template, not with folder frontmatter.

## Read the folder before writing (MUST) — full checklist

Before creating or editing docs in a folder, **always** call `exec("ls -A <folder>")` once. The response carries the folder's own `title`/`description`/`tags` + `templates_available` (the template menu for `write({ document: { template } })`). Skipping this is how agents land docs that violate folder discipline.

0. **First-contact check.** If the folder has no frontmatter of its own AND `templates_available` is empty AND `exec("ls -A")` shows substantial content elsewhere, the project hasn't been onboarded — STOP and run `onboard-existing-repo.md`. Skip on subsequent writes once confirmed.
1. **Read the folder's description** — its `title`/`description`/`tags` tell you what the folder is for. (These describe the folder; they are NOT defaults the doc inherits.)
2. **Read `templates_available`** — each entry has `name`, `title`, `description`, `scope` (`local` / `inherited`). If one matches, **prefer it** over free-form markdown (it's the folder's contract — templates carry frontmatter + body structure hand-authored docs routinely miss).
3. **Read recent siblings** — new docs should match the shape of existing ones (filename, frontmatter, body structure).
4. **Confirm content scope** — `content.dir` (`.ok/config.yml`) defines the root. `.gitignore` / `.okignore` (nested at any depth) define exclusions.

**Once per folder per session** — the checklist doesn't repeat unless you (or the user) changed a folder rule or template since.
