---
name: open-knowledge
description: "Authoritative agent-runtime contract for working inside an OpenKnowledge project — a markdown-CRDT knowledge base exposed over MCP. Use whenever reading, listing, searching, or editing any `.md` or `.mdx` file in the project, and before any `mcp__open-knowledge__*` tool call (`exec`, `search`, `write`, `edit`, and the rest). Installed by `ok init`, so its presence means this is an OpenKnowledge project and it governs every markdown file here. Covers the read/write tool surface, grounding and linking rules, folder/template conventions, the live browser preview, and the rule that OK's MCP tools — never native file tools — handle in-scope markdown."
compatibility: "Claude Code, Claude Desktop, Claude Cowork, Claude.ai web. Requires OpenKnowledge MCP server + code execution."
metadata:
  version: "0.20.0"
  author: "Inkeep"
  repository: "https://github.com/inkeep/open-knowledge"
---
# OpenKnowledge — agent guidance

OpenKnowledge (OK) is a markdown-CRDT collaboration platform exposed via MCP. This skill is the single source of OK agent guidance. Every rule below is a MUST unless marked otherwise. **Depth lives in `references/*.md` — one level deep; load a reference when its task comes up.**

> Skill version tracks `@inkeep/open-knowledge-server`. `cat ~/.ok/skill-state.yml` shows what's installed. `ok seed` needs `@inkeep/open-knowledge` >= 0.4.0; if it errors `unknown command`, `npm install -g @inkeep/open-knowledge`.

> **Setup (not connected yet?).** If the `mcp__open-knowledge__*` tools aren't available in your client, this project isn't wired up on this machine — see [`references/setup.md`](references/setup.md) for the rung ladder (approve `.mcp.json` → `ok start` CLI → optional desktop app) and the canonical quickstart.

## TL;DR — the 90% case

1. **Reads:** `exec("cat …")` for one doc, `exec("ls -A …")` for a directory (folder defaults + template menu), `exec("grep …")` for literal, `search` for ranked retrieval. Native `Read` / `Grep` only on source code (`.ts` / `.py` / …), never on in-scope `.md` / `.mdx`.
2. **Writes:** `write({ document: { path, content } })` for a new or full-replace doc; `edit({ document: { path, find, replace } })` for a body find/replace; `edit({ document: { path, frontmatter } })` for a frontmatter merge-patch (`null` deletes a key). `delete({ document })` removes, `move({ from, to })` moves/renames. Body find/replace is body-only. Pass a one-line `summary` (≤80 chars, user-facing outcome) on every content write.
3. **Preview:** every read/write response carries a route-only `previewUrl` (`/#/<doc>`, no host:port). Open the browser once at session start. Don't `preview_screenshot` to confirm edits — the tool response is the confirmation. Full multi-host contract: `references/preview.md`.
4. **Workflow guides:** `workflow({ kind: 'ingest' | 'research' | 'consolidate' | 'discover' })` returns a procedural guide, not data. Use it when the work fits the layer.
5. **Direct questions:** a plain business question ("which customers…", "what did we decide about…") routes to `search` / `exec` + a cited chat answer — no "research" keyword needed. Persist only when durable + multi-doc + not already covered, and *offer* first. See `references/corpus-qa.md`.
6. **Authoring or improving a skill** ("write/make a skill", "improve this skill", "turn this into a skill"): STOP and invoke the **`open-knowledge-write-skill`** skill — it owns scope choice (project vs global), the SKILL.md contract, evaluation, and install; don't improvise from this skill. Author through the `skill` target (`write({ skill })`), never a raw `.ok/skills/…` document. **Never read, diff, or edit the installed projections under `.claude/skills/` · `.cursor/skills/` · `.codex/skills/` · `.opencode/skills/` · `.agents/skills/`** — `install` generates them and overwrites them on the next sync; they are NOT source of truth.

## Tool index — 19 tools (router; the MCP tool descriptions carry each tool's full contract)

- **Reads** — `exec` (primary; read-only `cat`/`ls`/`grep`/`find`/`head`/`tail`/`wc`/`sort`/`uniq`/`cut` + frontmatter/backlink/history enrichment; one command or one pipe, not a shell), `search` (ranked BM25 + recency), `history` (versions for a doc), `links` (`kind: backlinks|forward|dead|orphans|hubs|suggest`, or an array for a one-call audit), `skills` (find + read skills: omit `name` to LIST every skill across Project + Global, pass `name` to READ one — addressed by `name`+`scope`, NEVER by path), `config` (resolved config), `palette` (markdown-native authoring forms + `html preview` starters + theme tokens; `palette({ components })` for JSX schemas), `preview_url` (browser preview URL on demand), `share_link` (GitHub-substrate share URL; read-only, errors when no GitHub remote).
- **Writes** — four native CRUD verbs, polymorphic over `document` / `folder` / `template` / `skill` / `asset` (pass EXACTLY ONE target, nested under its address key): `write` (create/overwrite; `write({ skill: { name, description, body, scope? } })` authors a skill → `.ok/skills/<name>/SKILL.md`, a **Draft** until `install`), `edit` (body find/replace OR frontmatter merge-patch; no asset), `delete` (remove), `move` (move/rename, rewrites referrers; a skill also takes `scope`/`toScope` to move Project↔Global — history resets, re-`install`). Output mirrors the input target key; the preview envelope (`previewUrl`, `warning`) stays top-level. Plus `install` (the Draft → Installed step for a `skill` — projects it into your editors; run after `write({ skill })`), `checkpoint` (named version), and `restore_version` (roll back). A folder's frontmatter is open-shape and self-only (does NOT cascade); templates are what new docs start with. **Authoring/improving a skill? invoke `open-knowledge-write-skill` (TL;DR #6), don't improvise.**
- **Conflicts** — `conflicts` (`kind: list|content`), `resolve_conflict` (write a resolution + commit; destructive). See `references/conflict-resolution.md`.
- **Workflow** — `workflow` (`kind: ingest|research|consolidate|discover`; procedural guides, not data). See `references/workflow-guides.md`.

**Self-correcting on misuse:** constraints JSON Schema can't express ("exactly one target", "`find` needs a `replace`", body-XOR-frontmatter) return `isError: true` with a one-line corrective shape. Read it and retry with that shape; don't guess.

Tools NOT in OK MCP (your host's): `preview_start`, `preview_screenshot`, `WebFetch`, `WebSearch`, native `Read` / `Grep` / `Glob` / `Edit`. The STOP rule governs which you may use on in-scope markdown.

## STOP — native tools on in-scope `.md` / `.mdx`

**Route every in-scope markdown read and write through OK's MCP tools — never your host's native file tools.** Native `Edit` / `sed` / direct `Write` on in-scope markdown bypasses the CRDT and loses agent attribution in the shadow repo; native reads skip frontmatter, backlinks, shadow-repo activity, and project git history that OK returns for every matched file. When this workspace has OpenKnowledge MCP configured, do **not** use native file tools on markdown paths inside the content directory. The ban covers every common rationalization:

- **Native `Read` / `Grep` / `Glob` on in-scope `.md` / `.mdx`** — the original case.
- **`Bash ls` / `Bash find` / `Bash cat` on dirs containing in-scope markdown** — use `exec("ls -A …")` / `exec("find … -name '*.md'")` / `exec("cat …")`. Native returns bare names; `exec` returns frontmatter, backlink counts, and recent activity. `-A` shows hidden entries (`.ok/`, `.okignore`) without the `.`/`..` noise.
- **Glob patterns that target markdown** (`**/*.md`, `specs/**`, `reports/**`, `docs/**`) — use `exec` with `find` or `exec("ls -A <dir>")`.
- **Dispatching the Explore / general-purpose subagent for markdown-heavy exploration** — subagents use native tools internally and bypass OK. Do markdown exploration yourself via `exec` / `search`. Subagents remain appropriate for **source-code** exploration.
- **Native `Read` / `Grep` on in-scope markdown inside `.ok/`** — `.ok/` is in-scope; treat its `.md` / `.mdx` like any other KB file.
- **`ls` / `cat` / `find` on `.ok/skills/` to discover or read a skill** — `.ok/skills/` is opaque internal state; skills are addressed by `name`+`scope`, not by path. Use the `skills` tool (omit `name` to list across Project + Global, pass `name` to read one); never browse `.ok/skills/...` paths.

**MCP tool visibility — not seeing `exec` is NOT the escape hatch.** MCP wiring varies by client (Claude Code, Cursor, Codex, Windsurf, VS Code). Server labels are user-defined; tools may not appear as top-level symbols named `exec`. If OpenKnowledge is registered as an MCP server here, route markdown reads through its `exec` / `search` via your client's documented MCP invocation (including any generic "call MCP tool" flow). Registration is the test, not top-level-symbol visibility.

**Your initial tool list is NOT exhaustive — run tool discovery before concluding the MCP is missing.** Some clients (notably Codex) defer MCP tools behind a lazy `tool_search` / tool-discovery step, so `mcp__open-knowledge__*` is absent from the upfront tool set and only appears after you search for it. Absence from the visible list means "I have not discovered it yet," NOT "it is not registered." If you don't see the tools, your first move is to run your client's tool-discovery / `tool_search` for `open-knowledge` (or `exec` / `search` / `write`) — do not infer unavailability from the initial list.

**Escape hatch.** Native `Read` / `Grep` / `Glob` on `.md` / `.mdx` is allowed **only** when, after running tool discovery (above), no OpenKnowledge MCP server is registered for this project, **or** immediately after you actually invoked an MCP call and it failed — then begin a user-visible sentence with `OpenKnowledge MCP unavailable:`. "Not registered" is a conclusion you may only reach after tool discovery turned it up empty — never from the initial tool list alone. Never use the hatch because you skipped your client's MCP path, didn't see `exec` as a top-level tool, didn't run tool discovery, or rationalized the skill wasn't necessary.

**Source code and non-markdown files** (`.ts`, `.py`, `package.json`, …): native `Read` / `Grep` / `Glob` always.

## Reads — examples

- Read a file: `exec("cat <path>.md")` — contents + full enrichment.
- List a directory: `exec("ls -A <dir>")` — per-child frontmatter, recursive markdown counts, most-recently-updated doc per subdir, the folder's own `title`/`description`/`tags` + `templates_available`. Prefer `-A` over plain `ls`.
- Literal search: `exec("grep -rn <term> <dir> | head -5")` — matches + enrichment on matched files.
- Ranked search: `search({ query })` — title boost + body BM25 + recency; use when picking the best doc, not when listing every occurrence.

## Writing

Call `write` / `edit` as soon as you have content (route through MCP per the STOP rule).

**Persist incrementally — the knowledge base IS your checkpoint (MUST).** On any multi-step or long-running task — a research sweep, a multi-source synthesis, a batch of docs — write completed work to the KB as you finish each unit: per section, per source, per doc. Never hold finished findings only in your context waiting for one final write at the end. A rate limit, crash, or context compaction mid-task discards everything still unwritten; work already persisted survives, and you resume by reading the doc back. Create the target doc early (skeleton + frontmatter), then `edit` each section in as it firms up.

**Pass a `summary` on every content write (SHOULD)** — a one-line (≤80 chars) user-facing change-note that becomes the timeline entry. **Reach for visual structure** (Callout, `mermaid`, table, `html preview`) where it carries the point better than prose; call `palette` as you draft. Advisory write-warnings, MDX authoring, delete/move mechanics, and visual authoring: `references/writing.md` + `references/components-and-visuals.md` + `references/media-and-assets.md`.

## Grounding — every factual claim needs a source (MUST)

Knowledge-base docs are factual artifacts. Every claim must be traceable, and **the source has to live inside the knowledge base**, not float on the public web.

- **The knowledge base is source-of-truth — closed loop.** External sources don't get cited out to the live web; they get pulled in via `ingest`, then cited locally. A bare `[source](https://...)` URL inside a KB doc is **not** a finished citation — it's a TODO that says "this source still needs to be ingested." The chain only works if every leaf is a local doc.
- **Every factual claim MUST cite its source at the point of claim.** No unsourced speculation.
- **Web sources for KB docs** → fetch the page (host `WebFetch` / `WebSearch`), then `ingest` it as a local doc, then cite the local path: `[source name](./path/to/source.md)` (the local doc carries the URL in `source_url:`). Inline `[source](URL)` is a chat affordance, not a KB one.
- **Self-fetched counts.** When YOU fetched a URL to ground a claim landing in the KB, that fetch triggers `ingest` exactly like a user share — don't downgrade to inline-URL citation because the fetch was agent-initiated.
- **Internal cross-refs** → standard markdown link to the OK doc with the authoritative claim; that doc must cite its own sources (chains terminate in preserved local docs).
- **If you don't have evidence:** run a web search and `ingest` it, OR mark inline `(TODO: needs source)`, OR don't write the claim. Do NOT fabricate. Unsourced speculation rots into untraceable tribal knowledge.

## Linking — standard markdown links (MUST)

Link every noun-phrase that names another document — `[text](./relative/path.md)` — and link liberally. **Every link must resolve to a doc that exists by the time you're done** (a same-pass forward-reference you create later in the pass is fine; for one that genuinely won't exist, leave the mention as plain prose + a tracked task). Never backtick a link (`` `[text](./foo.md)` `` is a bug) and never use HTML `<a>`. **Read `brokenLinks` on every `write`/`edit` response: `[]` means all links resolve; a populated list names each broken `href` + `reason` (`no-such-doc` / `no-such-file` / `unresolvable`) — fix them in a follow-up `edit`.** `links({ kind: "dead" })` is the authoritative end-state audit (the editor's red-underline is slug-tolerant and lies, so trust the tool). External web sources are NOT inline body links (see Grounding). Full rule set + the `[[Page]]` legacy note: `references/linking.md`.

## Folders, frontmatter, templates

Every `.md` / `.mdx` needs YAML frontmatter — `title` + `description` required, `tags` recommended. Two **opt-in, nested** folder mechanisms: folder frontmatter (`<folder>/.ok/frontmatter.yml` — the folder's own open-shape properties; self-only, does NOT cascade into child docs) and templates (`<folder>/.ok/templates/` — what new docs start with). Most folders have NO `.ok/`. A doc's frontmatter is exactly its own on-disk YAML. Structural model + the full pre-write checklist: `references/folder-model.md`. Template authoring + folder editing: `references/template-authoring.md`. Frontmatter-vs-body edit rules: `references/doc-editing.md`.

- **Read the folder before writing (MUST).** Before creating/editing docs in a folder, call `exec("ls -A <folder>")` once per folder per session — it returns the folder's `title`/`description`/`tags` + `templates_available`. Skipping it lands docs that violate folder discipline. (If a folder has no frontmatter AND no templates AND the repo has substantial content elsewhere, it isn't onboarded — invoke `workflow({ kind: 'discover' })` first.)
- **Use a template when one fits (MUST).** Instantiate via `write({ document: { path, template } })`; inherited templates count. Skip only when none match or the user asked for free-form (note why in chat). Create templates proactively when a shape recurs.
- **When recurring per-doc properties emerge (MUST).** Writing the same frontmatter on multiple siblings → bake those starting values into a template (`write({ template })`). Folder frontmatter does not cascade values into docs.

## Conflict-aware writes

Projects with GitHub sync may carry docs in merge-conflict state; mutating calls against them return RFC 9457 `urn:ok:error:doc-in-conflict` (409). Detect proactively — `exec("cat <path>.md")` returns `lifecycle: {status, reason} | null`; on `status === 'conflict'` switch to the `conflicts` + `resolve_conflict` flow. Full flow: `references/conflict-resolution.md`.

## Anti-patterns — the top offenders

| Task | Don't | Do |
| --- | --- | --- |
| List / find / read markdown | `Bash: ls`/`Glob: **/*.md`/`Read: foo.md` | `exec("ls -A …")` / `exec("find …")` / `exec("cat …")` |
| Explore a markdown-heavy dir | `Agent(Explore)` (bypasses OK) | `exec`/`search` yourself |
| Reference another doc | `` `[text](./p.md)` `` (backticked) or HTML `<a>` | `[text](./p.md)` |
| Embed an image | `<img>`, a `localhost`/`preview_url` URL, hot-link | save locally + `![meaningful alt](./path)` |
| Factual claim in a KB doc | prose with no citation, OR inline `[src](https://…)` | `ingest` the source, cite the local path |
| Confirm an edit landed | `preview_screenshot` / verification loop | trust the CRDT tool response |
| Delete a markdown doc | `Bash: rm` / native deletion | `delete({ document })` (`checkpoint()` first if risky) |
| Write in an unfamiliar folder | straight to `write` | `exec("ls -A <folder>")` first |

Full table: `references/anti-patterns.md`.

## Workflow tools — when to invoke them

`workflow` returns **procedural guidance, not fetched data** — follow its numbered steps; don't skip STOP gates. **These are your default move over `write`** when the work fits a layer.

| `kind` | When |
| --- | --- |
| `ingest` | Preserve a shared URL/PDF/file verbatim, OR you fetched a URL to ground a KB claim (binary sources preserved, not scraped). |
| `research` | Investigate / compare / synthesize multiple sources → `status: provisional` article + `sources:`. |
| `consolidate` | A decision was actually made → commit canonical source-of-truth with a `supersedes:` chain. |
| `discover` | First arrival at a repo with existing content and no folder frontmatter/templates → extract conventions, activate the link graph. |

Don't chain silently — let the user drive `ingest` → `research` → `consolidate` transitions; per-tool STOP gates override session-level "don't stop to ask" hints. After any turn that changes KB content, check for a `log.md` and follow its contract (see `references/cadence-and-logs.md`). Interleave a multi-doc batch so the preview shows narrative progress. Operating detail + starter packs: `references/workflow-guides.md`; binary-source (`ingest`-produced) wrapper frontmatter: `references/ingest-and-sources.md`.

## Server lifecycle

If `write` / `edit` returns `"Hocuspocus server is not running"`, run `ok start` (via Bash) and retry. Never fall back to native `Edit` / `Write` for in-scope markdown.

## Scope recap

OK looks for documents under the resolved `content.dir` (runtime: `config({ key: 'content.dir' })`); `.gitignore` and `.okignore` (at root or any folder depth) define exclusions. **Every `.md` / `.mdx` under `content.dir` not excluded is an OpenKnowledge document** — including under `specs/`, `reports/`, `docs/`. Folder metadata + templates live in nested `<folder>/.ok/`, not in `.ok/config.yml`. **Working in a git worktree?** Pass the worktree's absolute path as `cwd` on your OK tool calls once — it sticks for the session, so reads, writes, and the preview all target that worktree.
