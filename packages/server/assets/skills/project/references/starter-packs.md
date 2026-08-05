# Knowledge layers + starter packs — depth

(Core carries the layer table. This file carries the operating detail.)

## The layer model

Three of the layers correspond to [Karpathy's three-layer knowledge-base pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f): **ingest** (raw sources, immutable) → **research** (wiki, provisional) → **consolidate** (wiki, canonical). Onboarding an existing repo operates one level up, at the project-metadata layer, and is the brownfield counterpart to the greenfield `ok seed` CLI.

Typical day-2 flow: user shares a URL → ingest (preserve) → user asks "now research this" → research (provisional article; ingests more sources as needed) → decision lands → consolidate (canonical article, supersedes the research).

**None of these are MCP tools.** They are procedures that ship as skill guidance, in one of two shapes: a **reference file** inside a skill's bundle, which you open by path once that skill is loaded; or a **skill of its own**, which loads on description match when its pack is seeded.

- ingest → reference file `ingest-and-sources.md`, here in this bundle. Ships with every `ok init` because Core's Grounding rule depends on it, pack or no pack.
- onboard a repo that already has content → reference file `onboard-existing-repo.md`, here in this bundle.
- research / consolidate → their own skills, `/research-with-sources` and `/consolidate-notes`, installed alongside their pack by `ok seed --pack knowledge-base`. **Not available otherwise** — if the pack isn't seeded, say so rather than improvising a lookalike pipeline.
- generate / refresh a codebase wiki → reference file `generate-and-refresh.md`, inside the `codebase-wiki` skill's bundle and readable once that skill loads. Installed by `ok seed --pack codebase-wiki`.

Read the relevant procedure and execute its numbered steps with the OK verbs; don't skip its STOP gates.

**Autonomy gates vs session-level autonomy.** A procedure's STOP gates (research's scoping gate, consolidate's decision-confirmation gate) are not overridden by session-level "work without stopping for clarifying questions" hints. The session-level hint covers trivial back-and-forth ("which file did you mean?"); the gates exist for one-way-door decisions where the procedure deliberately wants confirmation before continuing. When in doubt, treat the gate as authoritative and the session-level autonomy hint as a default for the in-between turns.

**Do not chain silently.** After ingest, ask the user whether to proceed to research. After research, let the user decide whether the findings are ready to consolidate. Each procedure completes on its own terms — the user drives the transitions.

**Project scaffolding — two paths.** **Empty repo:** run `ok seed` once from a terminal (scaffolds the layout + seeds `log.md` + folder defaults). **Existing content:** work through `onboard-existing-repo.md`. Neither is required; the layer procedures work against any folder structure. Only mention each when explicitly relevant.

## Starter packs — reference for inspiration

The `ok` CLI (a Bash surface beside the MCP tools; other verbs `ok start` / `ok open` are documented in the core) ships proven layouts you can study to build a *similar* structure of your own — adapt the idea, don't clone the pack:

- `knowledge-base` — source-grounded research articles
- `software-lifecycle` — proposals, decisions, specs
- `codebase-wiki` — agent-authored wiki of your codebase
- `plain-notes` — notes + daily journal
- `worldbuilding` — fiction story wiki
- `writing-pipeline` — drafts → published
- `entity-vault` — people / companies / meetings (personal CRM)
- `okf` — Open Knowledge Format–conformant base

A pack that ships skills installs them project-local when seeded. Those skills are where the pack's procedures live; a pack may ship one skill or several.

To reference one **without installing it**: `ok seed --list-packs` (the menu) → `ok seed --pack <name> --dry-run` (its folders + the *why* of each folder + templates; writes nothing). Then either adapt the ideas into your own folders (`write({ folder })` + a template) or adopt the pack as-is by re-running without `--dry-run`. Reach for this when a user wants structure and an archetype fits — propose a tailored variant, not a verbatim copy.
