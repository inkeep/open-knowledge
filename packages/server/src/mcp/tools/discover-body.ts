export function buildDiscoverBody(contentDir: string): string {
  return `# Discover — Project Convention Extraction + Link Graph Activation

You're invoked because (a) the user explicitly asked to set up an existing repo, OR (b) an \`exec\` directory listing surfaced a hint because content exists with no folder frontmatter / templates configured. Your job: **extract conventions from existing siblings + activate the link graph, leaving the repo more structured and more navigable than you found it.**

Content directory: \`${contentDir}\` (from \`.ok/config.yml\`)

Use OK primitives only — no new files outside \`<folder>/.ok/\`, no body rewrites without per-pair user confirmation.

**You will work through 7 phases in order. STOP gates (⛔) require user confirmation before proceeding. Do not skip or batch ahead.**

**Server requirement.** Phases 1-4 run fs-direct — \`exec\` (scan + read) and the \`write\`/\`edit\` verbs (folder frontmatter + templates) need no running server. Phase 5 (link-graph activation) composes \`links\` and \`search\`, which **require the OK Hocuspocus server** — Phase 5 step 0 checks for it and exits cleanly with a \`run ok start\` instruction if it is down.

---

## Phase 1 — Scan + classify (no user interaction, no server needed)

1. \`exec("ls ${contentDir}")\` — list every top-level entry.
2. For each top-level **directory**: \`exec("ls <dir>")\` — the enriched listing surfaces the \`.md\` count, per-child frontmatter samples, recursive count, and the folder's own descriptive \`title\`/\`description\`/\`tags\` + \`templates_available\`.
3. Classify each directory:
   - **Substantial KB folder** — >3 \`.md\` files directly, OR named in known-genre list: \`specs/\`, \`reports/\`, \`docs/\`, \`articles/\`, \`research/\`, \`stories/\`, \`projects/\`, \`external-sources/\`, \`tech-probes/\`, \`rfcs/\`, \`proposals/\`, \`design-docs/\`, \`adrs/\`.
   - **Trivial folder** — 1-3 \`.md\` files; treat as one-offs.
   - **Likely noise** — known build/vendored patterns: \`node_modules/\`, \`dist/\`, \`build/\`, \`vendor/\`, \`third_party/\`, \`.changeset/\`, \`coverage/\`.
4. Detect total \`.md\` count across content root.
5. Detect seeded layout: do any of \`external-sources/\`, \`research/\`, \`articles/\` exist? (Karpathy three-layer partial presence — informational only.)
6. **Confirm-then-extend detection.** For each substantial folder, check the \`exec("ls <folder>")\` listing:
   - If the folder already has a \`title\`/\`description\`/\`tags\` → descriptive folder frontmatter already exists; switch THAT folder to "extend mode" (propose additions, not replacement).
   - If \`templates_available\` is non-empty → template already exists for that folder; skip template extraction for it.
   - If MOST substantial folders are already configured → set up to exit early at Phase 7 with "already configured."

**Early-exit conditions:**
- If total \`.md\` count is **< 5** → STOP. Tell the user "this looks empty — try \`ok seed\` for the greenfield Karpathy three-layer, OR write your first doc and re-invoke \`discover\` later." Exit.
- If all-greenfield-already (per step 6) → STOP. Exit with "already configured."

---

## Phase 2 — Confirm scope (⛔ STOP gate 1)

Present a structured summary to the user. Example:

\`\`\`
Discover orientation — what I found:

Substantial folders (candidate KB content):
  - specs/      52 .md   (suggests spec collection)
  - reports/   134 .md   (suggests research collection)
  - stories/    19 .md
  - projects/    8 .md

Trivial folders (one-offs):
  - tech-probes/  4 .md
  - 14 root-level docs (README, AGENTS, CLAUDE, CI, CONTRIBUTING)

Likely noise (recommend .okignore):
  - node_modules/  ~200 .md  (vendored deps)
  - dist/           ~30 .md  (build outputs)
  - Per-package CHANGELOG.md  (generated)

Seeded layout: no external-sources/ / research/ / articles/ present.

Mark each substantial folder as:
  [KB]    knowledge-base content — extract conventions, add folder frontmatter + template
  [skip]  already-structured or out of scope — leave existing settings
  [noise] add to .okignore
\`\`\`

**Wait for user response. Do not proceed until each substantial folder is classified.**

---

## Phase 3 — \`.okignore\` curation (⛔ STOP gate 2)

Based on user \`[noise]\` marks + agent-detected patterns, propose \`.okignore\` entries:

\`\`\`
Proposed .okignore additions:
  node_modules/**/*.md          # vendored dep READMEs
  dist/**/*.md                  # build outputs
  **/CHANGELOG.md               # per-package generated changelogs
  THIRD_PARTY_NOTICES.md        # auto-generated notices
  <any user-marked folders>
\`\`\`

Ask user: "Apply these \`.okignore\` additions? (yes / edit list / skip)"

On confirm: read existing \`.okignore\`, append new entries, write via native \`Write\` tool (\`.okignore\` is a plain config file, not in-scope markdown — escape-hatch ok).

**Don't redundantly propose what \`.gitignore\` already covers.** \`.gitignore\` and \`.okignore\` evaluate together; if the repo's \`.gitignore\` already excludes \`node_modules/\`, you don't need to add it again.

---

## Phase 4 — Per-folder convention extraction (⛔ STOP gates 3 + 4)

For **each** folder the user marked \`[KB]\`:

1. **Pick representative siblings.** From \`exec("ls <folder>")\`:
   - Most-recently-edited doc
   - Median-sized doc (roughly: pick the middle entry)
   - Up to 3 siblings. If folder has < 2 siblings, skip template extraction; only propose folder frontmatter.

2. **Read the siblings.** \`exec("cat <doc>")\` on each. Extract:
   - **Heading set** — list every top-level heading (line starting with \`# \` or \`## \`) in document order.
   - **Frontmatter shape** — which keys appear in ≥ 2 of the 3 siblings. Note ALL recurring keys, but route them by purpose: keys that describe the FOLDER (\`title\` / \`description\` / \`tags\`, but any key is allowed) go in the folder frontmatter; recurring per-doc keys (\`status:\`, \`owner(s):\`, \`baseline-commit:\`) are starting values for NEW docs and belong in the folder's TEMPLATE. Folder frontmatter is open-shape (like a doc's) but self-only — it does NOT flow into child docs, so per-doc starting values still belong in the template, not the folder frontmatter.
   - **Filename pattern** — dated (\`YYYY-MM-DD-*\`)? Slugged? Sequential?
   - **Link patterns in body** — does the body have a "Related" / "See also" / "References" section? Note the convention.

3. **⛔ STOP gate 3 — Heading-set match check.** If top-level headings DON'T match in text + order across ≥ 2 siblings, do NOT extract a template — only propose folder frontmatter. Tell the user: "siblings in \`<folder>\` don't share a consistent body skeleton; skipping template, proposing folder frontmatter only." The operational metric for "match" is **heading-text equality** (exact strings, in order). Anything beyond that is LLM judgment and shouldn't pretend to be deterministic.

4. **Idempotency check.** Per Phase 1 step 6:
   - If this folder already has its own frontmatter → switch to "extend mode." Show existing keys to user; propose ADDITIONS only.
   - If \`templates_available\` includes a template → skip template extraction. Tell user: "existing template \`<name>\` found; preserving."

5. **Propose folder frontmatter + template.** One \`write\`/\`edit\` call per target:

   \`\`\`ts
   edit({
     folder: {
       path: '<folder>',
       frontmatter: {
         title: '<inferred>',          // e.g., "Specifications"
         description: '<inferred>',    // 1-2 sentences describing the folder's purpose
         tags: ['<inferred>'],         // e.g., ['spec']
       },
     },
   })

   write({
     template: {
       path: '<folder>/<inferred-name>', // e.g., 'specs/SPEC', 'reports/REPORT'
       frontmatter: { title: '<placeholder>', description: '<placeholder>' },
       content: '<heading skeleton from siblings; include a frontmatter region with recurring per-doc keys (status, owner, …) as starting values>',
     },
   })
   \`\`\`

6. **⛔ STOP gate 4 — Surface proposal to user.** Show: heading set + frontmatter shape + filename pattern + link patterns. Ask: "Apply this proposal? (yes / edit / skip this folder)"

7. **Apply confirmed proposals** via the \`edit({ folder })\` + \`write({ template })\` calls above. Re-run \`exec("ls <folder>")\` to confirm \`templates_available\` + the folder's descriptive \`title\`/\`description\`/\`tags\` are populated.

Repeat for every \`[KB]\` folder.

**v1 scope note:** \`discover\` does NOT attempt nested-pattern detection (e.g., applying the same folder frontmatter across \`specs/*/evidence/\` for every spec's evidence/ subfolder). Each folder is addressed by its own path — one \`edit({ folder })\` call per folder. Users who want nested folder frontmatter set it up manually after \`discover\` finishes the top-level work.

---

## Phase 5 — Link-graph activation

The largest phase. Uses the \`links\` tool (every link-graph view) plus \`search\` and \`edit\` to apply confirmed link insertions.

0. **Server check (required for this phase).** \`links\` and \`search\` need the OK Hocuspocus server. Probe via \`links({ kind: "hubs" })\`. If the response starts with \`"Error: Hocuspocus server is not running"\`, STOP — tell the user "the link-graph phase of discover needs the OK server. Start it with \`ok start\` from a terminal, then re-invoke \`discover\` (Phases 1-4 are already applied; it resumes here)." Exit cleanly.

Six sub-passes, each with its own STOP gate.

### 5a. Orphan triage (⛔ STOP gate 5a)

1. Run \`links({ kind: "orphans" })\`.
2. For each orphan, run \`links({ kind: "suggest", docName: <orphan> })\`:
   - If \`mentions[]\` is non-empty → there are docs that mention this orphan without linking. Adoption candidates.
   - If \`mentions[]\` is empty → the orphan is **genuinely standalone** (no other doc references it at all). Surface as: "this looks intentionally standalone (e.g., a README). Skip / adopt anyway by linking from a hub / add to \`.okignore\`?"
3. Confirm per orphan. For each "link" choice, \`edit({ document: { path, find, replace } })\` on the source doc — find the existing mention text \`links({ kind: "suggest" })\` surfaced and replace it wrapped in link syntax.

**Note on re-surfacing:** v1 does NOT persist "intentional standalone" markers. Each \`discover\` re-run surfaces the same intentional orphans (root \`README.md\`, \`CONTRIBUTING.md\`, etc.) and the user re-dismisses them. Acceptable minor friction.

### 5b. Hub identification (⛔ STOP gate 5b)

1. Run \`links({ kind: "hubs" })\` — surfaces the most-linked-to docs (highest *inbound* links), i.e. pages already acting as hubs.
2. For each substantial \`[KB]\` folder (those that got templates in Phase 4):
   - Check if a hub already exists (\`<folder>/README.md\`, \`<folder>/INDEX.md\`, \`<folder>/CATALOGUE.md\`).
   - If yes: don't create a new one (anti-pattern: don't create INDEX.md hubs).
   - If no: ensure the template extracted in Phase 4 includes a \`## Related\` / \`## See also\` section. If the template doesn't already have one, propose adding it.
3. Surface existing hubs to the user so they know what the link graph already provides.

### 5c. Dead-link sweep (⛔ STOP gate 5c)

1. Run \`links({ kind: "dead" })\` (no \`sourceDocNames\` → audits the whole corpus).
2. For each dead link, propose: fix candidate (via \`search\` for the correct target), or delete (remove the link, or the prose around it). Leaving it as an "intentional redlink" is not an option — every dead link is fixed or removed.
3. Confirm per dead-link. Apply confirmed fixes via \`edit\`.

### 5d. Untextualized-reference detection (⛔ STOP gate 5d)

\`links({ kind: "suggest" })\` implements server-side detection of prose mentions of a target doc that aren't wrapped in link syntax. v1 leverages it directly.

1. For each substantial \`[KB]\` doc, run \`links({ kind: "suggest", docName: <target> })\`.
2. Each call returns \`mentions[]\` with \`{ source, excerpt, offset }\` — places to insert links pointing TO this target from OTHER docs.
3. Surface batched **by source doc** (not per-link, to keep cognitive load reasonable):

   \`\`\`
   In specs/2026-04-23-foo/SPEC.md, found 3 untextualized references:
     line 12: "the existing \`ok init\` scaffolds..." → matches code, NOT a doc — skip
     line 145: "...replaces the instructional init-content MCP tool" → matches a spec — accept as link
     line 203: "...per AGENTS.md ecosystem convention" → matches root AGENTS.md — accept as link
   \`\`\`

4. Confirm per source doc (batched). Apply confirmed link insertions via \`edit({ document: { path, find, replace } })\` — find the mention text the \`suggest\` view surfaced and replace it wrapped in link syntax.

**Truncation handling:** if the \`suggest\` view returns \`truncated: true\`, the scan hit its time budget. Iterate with smaller scope or accept partial coverage and tell the user.

### 5e. Vague-referential detection (⛔ STOP gate 5e)

Harder case: prose discusses a concept covered by another doc without naming it. Example: a spec talks about "how we track who wrote what" and there's an \`agent-identity-attribution-worldmodel/REPORT.md\` covering exactly that — but the spec never says "agent identity attribution." \`links({ kind: "suggest" })\` (title/alias match) misses this; semantic detection requires LLM judgment.

1. For each substantial doc, identify its main concepts. Use frontmatter \`subjects:\` / \`topics:\` if present; else extract from heading text + first 2-3 paragraphs (LLM judgment).
2. For each concept, run \`search({ query: <concept> })\`. Take top 1-2 non-self results.
3. For each candidate sibling:
   - Verify it is NOT already linked from this doc (\`links({ kind: "forward", docName: <doc> })\`).
   - Verify content is actually relevant (re-read summary; LLM judgment).
4. Surface to user with brief justification per pair. Confirm. Apply via \`edit\` (insert link in a "Related" or "References" section).

**Caveat:** vague-referential is LLM-judgment-heavy. False positives are expected; the user is the final arbiter. If the user rejects > 50% of proposals in a batch, recalibrate (tighten concept-extraction, raise relevance bar).

### 5f. Link-style detection + standardization (⛔ STOP gate 5f)

1. Sample 10 random non-noise docs (or all if total < 10). Count occurrences:
   - Wiki-link syntax: \`[[Page Title]]\` (legacy)
   - Relative-markdown: \`[text](./path.md)\` or \`[text](path.md)\` (current OK recommended)
2. Report ratio to user. If mixed, propose a one-time standardization: convert all \`[[Page]]\` to \`[Page](./path.md)\`. Ambiguous \`[[Page]]\` (multiple matching files) → surface for confirmation.
3. Apply via \`edit\` on each affected doc, resolving page titles to file paths via \`exec("ls")\` / \`search\`.

---

## Phase 6 — Apply + validate

After all confirmed proposals are applied:

1. Re-run \`exec("ls <folder>")\` on every \`[KB]\` folder. Verify:
   - the folder's descriptive \`title\`/\`description\`/\`tags\` are populated (folder frontmatter landed)
   - \`templates_available\` includes the new template (template landed)
2. Re-run the orphan + dead-link audit in one call — \`links({ kind: ["orphans", "dead"] })\`. Confirm orphan count dropped vs. Phase 5a baseline and fixed dead links no longer report.

If any validation step fails, surface to the user — do NOT silently pass.

---

## Phase 7 — Final summary + exit

Print a structured summary the agent shares with the user. Distinguish initial-setup mode from extension mode (per Phase 1 step 6):

**Initial-setup mode:**

\`\`\`
Discover complete:

Folder frontmatter added (<folder>/.ok/frontmatter.yml):
  specs/                  title: Specifications, tags: [spec]
  reports/                title: Research Reports, tags: [report]
  stories/                title: User Stories, tags: [story]
  projects/               title: Projects, tags: [project]

Templates added (<folder>/.ok/templates/<name>.md):
  specs/.ok/templates/SPEC.md     (heading skeleton from 3 siblings, link-aware)
  reports/.ok/templates/REPORT.md (heading skeleton from 3 siblings, link-aware)

.okignore additions: 4 entries (node_modules, dist, CHANGELOG.md, THIRD_PARTY_NOTICES.md)

Link-graph activation:
  Orphan triage:          7 orphans triaged (4 adopted, 3 left as intentional standalones)
  Hub identification:     3 existing hubs surfaced; 2 templates updated with \`## Related\` sections
  Dead-link sweep:        5 dead links — 4 fixed, 1 removed
  Untextualized refs:     12 prose mentions linked (across 8 source docs)
  Vague-referential:      5 semantic cross-references added (across 4 source docs)
  Link-style:             standardized 42 wiki-links to relative-markdown

Notes:
  - 3 intentional standalones (README, CONTRIBUTING, LICENSE) re-surface on each discover run.
    v1 does not persist a "standalone" marker; you'll re-dismiss them next time.

Next steps:
  - Review the extracted templates in <folder>/.ok/templates/ — they're starter shapes, not finished.
  - The next agent in this repo will see templates_available + the folder's own frontmatter for every KB folder.
  - Re-run discover after significant content additions (new folder categories, major restructures).
\`\`\`

**Extension mode** (when prior configuration was detected):

\`\`\`
Discover extension complete (existing configuration preserved):

New folder frontmatter:
  tech-probes/            (was missing — title: Tech Probes, tags: [probe])

Updated templates:
  specs/.ok/templates/SPEC.md   (heading skeleton refreshed from current siblings)

Link-graph activation:
  Orphan triage:          3 new orphans found (all triaged)
  Untextualized refs:     8 new references linked
\`\`\`

---

## STOP rules / anti-patterns (load-bearing across phases)

- **Don't restructure existing folders** — no renaming, moving, consolidating, splitting. The folder shape as-found is the contract.
- **Don't impose Karpathy three-layer** — only propose \`external-sources/\` / \`research/\` / \`articles/\` if the user explicitly opts in. Most brownfield repos won't.
- **Don't create INDEX.md / README.md hub files** — folder frontmatter + \`exec("ls")\` give the same view live.
- **Don't extract templates from a single sibling** — need ≥ 2 with matching heading set (heading-text equality, in order).
- **Don't bulk-rewrite doc bodies** — every link insertion (5a, 5c, 5d, 5e, 5f) goes through user confirmation via STOP gates.
- **Don't auto-apply** — every phase has a confirmation gate. The tool proposes; the user disposes.
- **Don't run if the project has < 5 \`.md\` files** — exit early; redirect to \`ok seed\`.
- **Don't run if the project is already fully configured** — exit early with "already configured."
- **Don't redundantly propose what \`.gitignore\` covers** in \`.okignore\`.
- **Don't attempt nested-pattern detection** in v1 — each substantial top-level folder gets its own folder frontmatter; nested sub-patterns (\`specs/*/evidence/\`) are left for users to set up manually.

---

## Exit conditions (early termination)

- **Empty project** (Phase 1): < 5 \`.md\` files total → exit with "try \`ok seed\` instead."
- **All-greenfield-already** (Phase 1 step 6): folder frontmatter exists AND templates exist for every substantial folder → exit with "this project is already configured."
- **Server down** (Phase 5 step 0): Phases 1-4 already applied fs-direct; surface "the link-graph phase needs \`ok start\` running" and exit cleanly — re-invoking resumes at Phase 5.
- **User aborts at any STOP gate** → exit cleanly, leaving any already-applied proposals in place (apply is per-phase, not all-or-nothing).
- **Validation failure** (Phase 6) → don't pretend to succeed; surface the failed step to the user.
`;
}
