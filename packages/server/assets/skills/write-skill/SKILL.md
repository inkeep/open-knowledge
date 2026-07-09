---
name: open-knowledge-write-skill
description: "Use when the user wants to create, author, write, or design a new Agent Skill (a SKILL.md) — for OpenKnowledge or for their editors — including requests like 'help me write a skill', 'make a skill that…', 'turn this workflow into a skill', or improving an existing skill's triggering and discipline. Also use when capturing reusable agent guidance that should live as an installable skill rather than a one-off prompt. Covers choosing scope (project vs global), the SKILL.md frontmatter contract, progressive-disclosure structure, evaluating the skill, and installing it into the user's editors."
compatibility: "OpenKnowledge project recommended (uses the `write` / `edit` / `install` MCP verbs). Authoring + validation are pure file ops; live preview + eval want a running server (`ok start`)."
metadata:
  version: "0.28.2"
  author: "Inkeep"
  repository: "https://github.com/inkeep/open-knowledge"
---

# Writing an OpenKnowledge skill

You are helping the user author an **Agent Skill** — a `SKILL.md` file (plus
optional `references/` and `scripts/`) that teaches an AI agent how to do a
recurring task. In OpenKnowledge a skill is a first-class, versioned,
installable artifact: you author it with the `write` / `edit` skill verbs, then
`install` it into the user's editors.

Skills earn their keep by being **recognized at the right moment** and **followed
faithfully**. Most of the craft is in two places: a `description` that triggers
reliably, and a body short and concrete enough that the agent actually does what
it says. Work the stages below in order, but jump to where the user already is.

## Stage 1 — Capture intent and classify the skill

**Gate — does this already exist? Check BEFORE you build.** Scan the installed
skills (the host surfaces the full catalog when this skill loads) for one whose
role or triggers already cover the task. If an existing skill covers most of it,
STOP and **recommend reuse** — a near-duplicate with overlapping triggers
mis-fires and dilutes both. Build a new skill only when it is genuinely distinct,
or a deliberately tighter companion whose `description` explicitly hands off to
the existing one. Surface the overlap and decide WITH the user before drafting or
writing anything — never discover it after the skill is written.

Ask only what you can't infer:

- **What recurring task** should this skill handle? Get one concrete example.
- **Skill type**, because it sets how much rigor to apply:
  - **Reference / technique** (most skills) — "how to do X." Prose body, examples.
  - **Discipline** — enforces a behavior the agent tends to skip under pressure
    (e.g. "always write a failing test first"). These need the RED baseline +
    pressure-testing in Stage 4–6; reference skills don't.
- **Degrees of freedom** (calibrate body precision to task fragility):
  *high* (free prose — judgment tasks), *medium* (parameterized steps), *low*
  (a fixed `scripts/` command — when any deviation breaks the result). Don't
  over-specify a judgment task or under-specify a fragile one.

## Stage 2 — Resolve scope FIRST (never infer silently)

Scope determines where the skill lives and where `install` projects it. This is
the user's decision and has different blast radius — make it explicit.

| Scope | Lives in | `install` projects to |
| --- | --- | --- |
| **Global** | `~/.ok/skills/<name>/` (your user store) | your editors, in **every** project |
| **Project** | `<kb>/.ok/skills/<name>/` (this KB, shared via git) | this project's editors; teammates get it on `git pull` |

Default heuristic: inside an OK project and the task is specific to it → **project**;
"for all my work / globally" → **global**; otherwise ask one question. State the
choice and its consequence before writing.

## Stage 3 — Plan the contents

- **Body** = the durable, reusable instructions — under ~500 lines. If it's
  growing past that, move depth into `references/<topic>.md` (loaded only when
  needed) and point at it from the body. For a **project** skill the reference
  auto-connects in the graph either way, so a backticked `` `references/<topic>.md` ``
  path is fine; use a `[[references/<topic>]]` wiki-link only when you want the
  mention to be a clickable inline link. For a **global** skill use a plain
  backtick path — global references aren't graph docs, so a wiki-link there
  dangles. Keep references **one level deep**.
- **Do NOT include**: a README/CHANGELOG/QUICK_REFERENCE, install instructions
  for the skill itself, version histories, or anything host-specific. The skill
  is the instructions, not documentation about the instructions.
- For a **discipline** skill, plan the failure mode you're correcting and how
  you'll prove the skill fixes it (Stage 4).

## Stage 4 — RED baseline (discipline skills only)

Before writing the skill, run the scenario WITHOUT it and capture what the agent
does wrong — verbatim, including its rationalizations ("the test is trivial so I
skipped it"). Those rationalizations are the exact loopholes the skill body must
close. If you have a running server, use the agent simulator
(`cd packages/app && bun run src/server/agent-sim.ts`) as the executor; otherwise
reason through the baseline transcript with the user. Skip this stage for plain
reference skills.

## Stage 5 — Draft the skill

Author the source with the skill verb (fs-direct; a live preview updates if a
server is running):

```
write({ skill: { name: "<lowercase-hyphen-name>", description: "<triggers>", body: "<markdown>", scope: "project" } })
```

Frontmatter contract (validated on write — get it right):
- `name` — lowercase letters, digits, hyphens; ≤64; **equals the directory**.
- `description` — **≤1024 chars, no XML tags, no `version` field**. See Stage 7.
- Nothing else. OK never injects its own frontmatter; bookkeeping lives in `.ok/`.

Write the body as direct instructions to the agent (imperative, second person),
concrete over abstract.

Add depth files — `references/*.md` (loaded on demand) and `scripts/*` (shown as
text, never executed by OK) — through the skill verbs, never native `Write`/`cat`:

```
# write one or more bundle files (independent of body — no need to resend SKILL.md)
write({ skill: { name: "<name>", files: [{ path: "references/tiers.md", content: "..." }] } })

# surgical edit inside one bundle file (mirrors edit({ document }))
edit({ skill: { name: "<name>", file: "references/tiers.md", find: "...", replace: "..." } })

# list the bundle, then read one file (no native cat)
skills({ name: "<name>" })                         # → files: [{ path, kind }]
skills({ name: "<name>", file: "references/tiers.md" })   # → { path, kind, text }

# delete specific bundle files (omit `files` to delete the whole skill)
delete({ skill: { name: "<name>", files: ["references/tiers.md"] } })
```

Paths are skill-relative and must live under `references/` or `scripts/` (one
level deep). A project `.md` reference becomes a live content doc that
auto-connects to its SKILL in the graph regardless of how the body mentions it —
a backticked `` `references/<name>.md` `` path joins the graph just like a
`[[references/<name>]]` wiki-link. Reach for a wiki-link (or
`[label](references/<name>.md)`) only when you want a clickable inline link.
Global skills are different: their references aren't graph docs, so use a plain
backtick path there — a wiki-link would dangle.

## Stage 6 — GREEN eval + refactor

Re-run the scenario WITH the skill. For a discipline skill, **pressure-test**:
combine 2–3 pressures (time, authority, sunk cost) and confirm the agent still
follows the rule — then patch any loophole and re-test (`references/pressure-testing.md`).
For a reference skill, confirm the agent now does the task correctly and the body
isn't longer than it needs to be. Cut anything the agent already knows.

## Stage 7 — Optimize the description (this is what makes the skill fire)

The `description` is the **only** thing the agent sees when deciding whether to
load the skill. Get it right (`references/description-optimization.md`):
- **Triggers, not a summary.** Say WHEN to use it, in the user's words and
  phrasings — NOT a recap of the body. Summarizing the workflow in the
  description makes the agent follow the description and skip the body.
- **Concrete and a little pushy** to fight under-triggering: name the situations,
  verbs, and phrasings that should activate it.
- Sanity-check against near-miss queries: phrasings that SHOULD trigger it and
  adjacent ones that should NOT.

## Stage 8 — Install (the deliberate Draft → Installed step)

Drafting doesn't change the agent's behavior until you project it:

```
install({ name: "<name>" })
```

This fans the validated skill into the project's configured editors
(`.claude/skills/`, `.cursor/skills/`, `.codex/skills/`, `.opencode/skills/`, `.pi/skills/`). For a project skill,
commit `.ok/skills/<name>/` and the projections so teammates get it on pull. Edit
later with `edit({ skill })` then `install` again; `delete({ skill })` removes it
and uninstalls. Roll back a **project** skill with `history({ skill })` →
`restore_version({ skill, version })` — global skills are unversioned in this
build, so they have no history to restore.

## Reminders

- Prefer ONE good skill over many overlapping ones; split only when triggers diverge. (The Stage 1 gate is where you ENFORCE this — don't leave overlap to discover later.)
- Scope is the only placement decision — don't fold harness/format/toolchain assumptions into it, and don't bake one into the scope question's wording. You are authoring an OpenKnowledge skill: write it with `write({ skill })` and project it with `install`; never hand-write skill files into editor dirs (`.claude/skills/`, `.cursor/skills/`, `.codex/skills/`) — `install` owns those and overwrites them. If you load this flow, author through it.
- Ground claims about how skills behave (versioning, install targets, scope semantics) in this guide or the tool descriptions — don't assert system facts from assumption.
- Avoid blanket ALWAYS/NEVER rules without a stated reason — they read as noise and
  get ignored. Explain the why.
- A skill that ships executable `scripts/` is projected verbatim into another
  agent's trust domain — only include scripts the user has reviewed.
