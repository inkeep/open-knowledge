/**
 * Instructional body for the `workflow({ kind: 'wiki' })` guide.
 *
 * Drives an agent to generate — and later refresh — a navigable, diagram-rich,
 * source-grounded wiki of the surrounding codebase, authored as markdown INTO
 * the OK knowledge base (the `codebase-wiki` starter pack's `wiki/` layout).
 * The OK answer to Cognition's DeepWiki: repo-owned, version-controlled,
 * private by default, human+agent co-editable, and durable grounding context
 * for future agent sessions.
 *
 * Split from `workflow.ts` so the markdown content lives in a file dedicated to
 * it (mirrors `discover-body.ts`). Body is interpolated with the project's
 * resolved `contentDir` at call time; everything else is a constant.
 *
 * The recipe leans on shipped OK primitives only — no new engine code. It pairs
 * NATIVE source-code tools (read `.ts`/`.py`/config/etc.) with the OK MCP verbs
 * (`write`/`edit`/`links`/`search`/`exec`) that author and audit the markdown.
 */

export function buildWikiBody(contentDir: string): string {
  return `# Codebase Wiki — Generate + Refresh

You're invoked because the user wants a **wiki of this codebase** — DeepWiki, but living in their own repo. Your job: read the source code and author a navigable, diagram-rich, source-grounded wiki as markdown INTO the OK knowledge base, under \`wiki/\`. It is version-controlled, private by default, co-editable, renders in OK's live preview, and becomes grounding context for future agent sessions.

Content directory: \`${contentDir}\` (from \`.ok/config.yml\`). The wiki lives at \`${contentDir}/wiki/\`.

**Two toolsets, two jobs.** Read source code with your NATIVE tools (\`Read\`/\`Grep\`/\`Glob\`/\`Bash\` — OK MCP does not index non-markdown source). Author and audit the wiki with OK MCP verbs (\`write\`/\`edit\` for pages, \`links\`/\`search\` for the graph, \`exec\` for markdown listings). Never hand-write the wiki markdown with native \`Write\`/\`Edit\` — that bypasses attribution, backlinks, and the live preview.

**Server requirement.** Phases that author or audit the wiki (\`write\`/\`edit\`/\`links\`/\`search\`) need the OK Hocuspocus server. Source reading (native tools) and git (\`exec\`/native \`Bash\`) do not. If a \`write\` returns "Hocuspocus server is not running", tell the user to run \`ok start\` and retry — do NOT fall back to native file writes for the wiki markdown.

**Prerequisite.** This guide assumes the \`codebase-wiki\` pack is seeded (\`ok seed --pack codebase-wiki\` → \`wiki/\` with \`architecture/ modules/ flows/ concepts/ guides/\`, each carrying folder frontmatter + a page template, plus \`wiki/OVERVIEW.md\` + \`wiki/log.md\`). If \`exec("ls -A ${contentDir}/wiki")\` shows the layout is missing, tell the user to seed first, then re-invoke.

---

## The two knobs

Read these from the user's natural-language request (e.g. "build the wiki, public and exhaustive"). They are NOT engine config — they tune what you produce. Record the chosen profile in \`wiki/OVERVIEW.md\` frontmatter (\`profile: <audience>/<depth>\`) so refreshes stay consistent.

| Knob | Values | Effect |
|---|---|---|
| \`audience\` | \`internal\` (default) │ \`public\` | \`internal\`: dense; may cite internal infra; reference source via **relative links + symbol code-spans**. \`public\`: polished prose; **omit secrets, internal infra, ticket/PR numbers**; reference source via **GitHub blob URLs** (only if a remote exists — else fall back to relative). |
| \`depth\` | \`tour\` │ \`standard\` (default) │ \`exhaustive\` | \`tour\`: OVERVIEW + architecture + top flows only (fold modules into architecture). \`standard\`: + one page per package/module + concepts. \`exhaustive\`: + sub-module pages, \`guides/\`, per-flow failure modes, denser diagrams. |

Default when the user says nothing: \`internal\` / \`standard\`.

---

## Source-reference convention (how wiki pages point at code)

- **Intra-wiki navigation** → OK doc links (\`[Auth flow](../flows/auth.md)\`). These build the full backlink / hub / orphan graph. Link liberally — density is how the wiki stays navigable.
- **Code references, \`internal\`** → a relative markdown link to the source file plus an inline code-span for the symbol — e.g. the \`bootServer()\` symbol in [boot.ts](../../packages/server/src/boot.ts). Relative source links click-open in the asset preview and stay out of the navigation graph (the \`links\` graph tracks only \`.md\`/\`.mdx\` edges, so source links never show as graph dead-links or orphans) — but the write/edit \`brokenLinks\` response DOES validate them: a wrong-depth path resolving to a missing file is reported \`no-such-file\`, and one that overshoots the content root is \`unresolvable\`. So count the \`../\` hops from the page's own folder, not the wiki root. A cosmetic \`#Lxx\` is fine but not navigable.
- **Code references, \`public\`** → GitHub blob URLs (\`https://github.com/<org>/<repo>/blob/<branch>/path/to/file.ts\`) so a reader without the repo can follow them. Detect the remote with \`exec\` (or native \`git remote get-url origin\`); if there is none, fall back to relative links.

Never invent paths — every source reference must point at a file you actually read.

---

## Mode detection — generate vs. refresh

\`exec("cat ${contentDir}/wiki/OVERVIEW.md")\` and read its frontmatter:

- **\`source_commit\` is empty / OVERVIEW is the seeded stub** → **GENERATE** (Phases 0–7 below).
- **\`source_commit\` is stamped with a commit** → **REFRESH** (jump to the *Refresh mode* section). Reuse the recorded \`profile\` unless the user explicitly changes a knob.

---

## GENERATE — phased, STOP-gated (⛔ = wait for user confirmation)

Work the phases in order. Do not skip or batch ahead of a ⛔ gate. Each page is authored with OK \`write\`/\`edit\`; create from the seeded templates (\`write({ document: { path, template: "<name>" } })\`) so pages start with the right skeleton, then fill the sections.

### Phase 0 — Resolve profile + scope (⛔ STOP gate 0)

1. Resolve \`audience\` + \`depth\` from the request (default \`internal/standard\`).
2. Propose the **coverage set** (which packages/dirs the wiki will document) and **exclusions** (vendored deps, build output, generated code, fixtures — \`node_modules/\`, \`dist/\`, \`build/\`, \`vendor/\`, \`third_party/\`, \`coverage/\`, lockfiles).
3. Present profile + coverage + exclusions to the user. **Wait for confirmation.**

### Phase 1 — Survey (no writes) (⛔ STOP gate 1)

Read, don't write. Use native tools:

1. **Detect the stack** — languages, build system, package manager, workspace/monorepo layout, entry points. (\`Glob\` for manifests: \`package.json\`, \`Cargo.toml\`, \`go.mod\`, \`pyproject.toml\`, \`*.csproj\`; read them.)
2. **Bootstrap from existing docs** — READ \`README\`, \`AGENTS.md\`/\`CLAUDE.md\`, \`ARCHITECTURE.md\`, \`CONTRIBUTING\`, per-package READMEs. **Summarize and link to them; do NOT duplicate.** They are your highest-signal starting point.
3. **Map the modules** — list packages/top-level source dirs; note each one's rough purpose and entry points.
4. Produce an **inventory + a proposed page list scaled to \`depth\`**:
   - \`tour\` → OVERVIEW + 1–3 architecture pages + top 1–3 flows.
   - \`standard\` → + one module page per package + a concepts glossary.
   - \`exhaustive\` → + sub-module pages, \`guides/\`, per-flow failure modes.
5. Present the page list. **Wait for confirmation.**

### Phase 2 — Overview hub

Author \`wiki/OVERVIEW.md\` (edit the seeded stub in place):
1. **What this is** — 1–2 paragraphs: what the project does, who it's for.
2. **Architecture at a glance** — a big-picture \`mermaid\` diagram. Example:
   \`\`\`mermaid
   flowchart TD
     CLI[ok CLI] --> Server[Hocuspocus server]
     App[React editor] --> Server
     Server --> Disk[(markdown + .ok/)]
   \`\`\`
   (Mermaid label text has sharp edges — if a write returns a \`mermaid-parse-error\` warning, fix that fence and re-edit. \`palette({ components: ["Mermaid"] })\` lists the gotchas.)
3. **Navigation** — a map that links **every section and every page you will create**, as OK doc links. OVERVIEW is the hub; everything must be reachable from it.
4. **Stamp frontmatter**: set \`profile: <audience>/<depth>\` and \`source_commit: <git rev-parse HEAD>\` (run \`exec("git rev-parse HEAD")\` or native \`git\`). \`source_commit\` is the freshness anchor refresh mode diffs against — get it right.

### Phase 3 — Architecture pages

One page per architectural area (boundaries, layers, subsystems, cross-cutting concerns). Each: a system-context or component \`mermaid\` diagram, the key components (with source references per the convention), and the design decisions behind them. Cross-link the modules and flows each area touches. (At \`depth: tour\`, modules fold into these pages.)

### Phase 4 — Module pages

One page per package/module (skip at \`tour\`; scale sub-module depth by knob). Use the \`module-page\` template: purpose, responsibilities, public API / entry points, **key files** (linked per the convention), dependencies, and the flows it participates in. Cross-link concepts and flows.

### Phase 5 — Flows

Key end-to-end sequences (request lifecycle, build/deploy, a core interaction) as \`mermaid\` sequence or flow diagrams + narrative. At \`exhaustive\`, add a **Failure modes** section per flow. Link every module and concept the flow crosses.

### Phase 6 — Concepts / glossary

Atomic pages for domain terms and core abstractions (one term each): definition, why it matters, where it lives in the code. Keep them small and densely cross-linked so each concept becomes a hub for everywhere it appears. Link concepts from the architecture/module/flow pages that use them.

### Phase 7 — Link-graph activation + audit

1. Confirm **OVERVIEW links every page** (it is the nav hub). Add any missing nav links. This is OVERVIEW's check — it's a *source* (high out-degree), verified by forward links here, not by the \`hubs\` view below.
2. Run \`links({ kind: ["orphans", "hubs", "dead"] })\`:
   - **orphans** — pages nothing links to. Adopt each by linking it from OVERVIEW or a relevant section page (or, rarely, justify it as intentionally standalone).
   - **hubs** — ranks by *inbound* links. Confirm your **concept/module pages** show up here — that's the signal cross-linking actually happened. Don't expect \`OVERVIEW\`: a freshly authored nav page has almost no inbound links, so it won't appear (and that's correct — its coverage was checked in step 1).
   - **dead** — fix or remove every dead link. (Source-file links don't appear in this graph — only \`.md\`/\`.mdx\` edges are tracked — but they ARE validated by \`brokenLinks\` on each write/edit, per the code-reference rule above.)
3. Append a \`wiki/log.md\` entry (see *Log discipline*).
4. Tell the user the wiki is ready and surface the OVERVIEW preview URL.

---

## REFRESH mode (re-invoke after code changes)

Incremental by default — don't re-read the whole repo.

1. Read \`source_commit\` + \`profile\` from \`wiki/OVERVIEW.md\` frontmatter. Reuse the profile unless the user changed a knob.
2. \`exec("git diff --stat <source_commit>..HEAD")\` (or native \`git\`). Inspect the changed paths.
3. **Map changed code → affected pages.** For each changed package/area, update its module/architecture/flow pages (read the changed source first). Update OVERVIEW only if the structure changed (new package, removed subsystem, new top-level flow).
4. **Full-regen fallback.** If the diff is large or structural (many packages, a restructure), or git is unavailable / \`source_commit\` is missing, fall back to a full GENERATE pass rather than a partial patch.
5. **Re-stamp** \`source_commit\` to the new \`git rev-parse HEAD\` and re-run the Phase 7 link-graph audit on the touched pages.
6. Append a \`wiki/log.md\` refresh entry.

---

## Log discipline

\`wiki/log.md\` is an append-only audit trail. Append one dated entry per generation or refresh run (one per run, not per page). Reference touched pages as markdown links so they register in the backlink graph. Entry shape:

\`\`\`markdown
## YYYY-MM-DD: <generate | refresh>

- Profile: <audience>/<depth>
- source_commit: <short-sha> (was <prev-sha> on refresh)
- Coverage: <which sections/packages were written or updated>
- Pages: [Overview](./OVERVIEW.md), [Server](./modules/server.md), ...
\`\`\`

---

## STOP rules / anti-patterns (load-bearing)

- **Author wiki markdown only through OK \`write\`/\`edit\`** — never native \`Write\`/\`Edit\` (loses attribution, backlinks, live preview). Read source with native tools; write the wiki with OK.
- **Summarize existing docs, don't duplicate them** — link to \`README\`/\`ARCHITECTURE.md\`; the wiki adds navigation and synthesis, not a copy.
- **Every source reference points at a file you actually read** — no invented paths or symbols.
- **Respect the profile** — at \`audience: public\`, never write secrets, internal infra, or ticket/PR numbers; reference code via GitHub URLs (or relative if no remote).
- **OVERVIEW is the hub** — every page must be reachable from it. Don't leave orphans (Phase 7 catches them).
- **Don't scaffold folders by hand** — the \`codebase-wiki\` pack already created \`wiki/\` with templates; if it's missing, seed first.
- **Scale to \`depth\`** — don't write \`guides/\` or per-flow failure modes at \`tour\`; don't fold modules into architecture at \`exhaustive\`.
- **Refresh is incremental** — diff \`source_commit..HEAD\` and touch only affected pages; full-regen only on large/structural diffs or when git is unavailable.

---

## Exit conditions

- **Pack not seeded** — \`wiki/\` layout missing → tell the user to run \`ok seed --pack codebase-wiki\`, then re-invoke. Exit.
- **Server down** — a \`write\`/\`links\` call reports the server is not running → tell the user to run \`ok start\` and retry. Exit cleanly; re-invoking resumes (already-written pages persist).
- **User aborts at a ⛔ gate** → exit cleanly, leaving any already-written pages in place.
- **Empty / unreadable repo** (no source detected in Phase 1) → tell the user there's nothing to document yet. Exit.
`;
}
