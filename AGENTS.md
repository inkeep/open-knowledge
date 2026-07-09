# OpenKnowledge Agent Guide

This is the public OpenKnowledge repository. Keep changes compatible with the published package and standalone clone experience.

## Start Here

- Read [README.md](./README.md) for the project overview.
- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before changing public PR flow, dependencies, or exported docs.
- Use Bun 1.3.13 or newer and Node.js 24 or newer.

## Commands

```bash
bun install
bun run check
bun run build
```

Use these during development:

```bash
bun run format
bun run lint
bun run typecheck
bun run test
```

Run local apps:

```bash
bun run --filter @inkeep/open-knowledge-app dev

cd docs
bun run dev
```

## Repo Layout

- `packages/app` - web app and editor UI
- `packages/cli` - CLI and package entrypoint
- `packages/core` - shared domain logic
- `packages/desktop` - Electron desktop app
- `packages/plugin` - agent integration package
- `packages/server` - local collaboration server
- `docs` - documentation site

## Public Mirror Rules

- This repo is generated from an allowlist. Do not rely on hidden source-only folders being present.
- Public PRs are reviewed by maintainers and accepted changes sync back here automatically. A PR may close rather than show as merged; that is expected for this mirror.
- Top-level public docs such as `README.md`, `CONTRIBUTING.md`, and `AGENTS.md` are overlay files. Keep them public-safe and standalone.
- Do not add secrets, private customer context, internal-only specs, local paths, or generated debug artifacts.
- Keep dependency updates paired with `bun.lock`. Run `bun run notices` when third-party notices may change.

## Changesets

Every behavior-changing PR ships a `.changeset/<kebab-name>.md` file. The body becomes the user-facing entry on the next beta's GitHub Release and on the aggregated stable Release notes — that's how npm consumers and DMG auto-update users learn what changed. Write release-note copy, not a commit-message reprise.

- Create one with `bun run changeset`, or hand-write a file named `.changeset/<descriptive-kebab-slug>.md`.
- Front-matter: at minimum `'@inkeep/open-knowledge': patch`. OpenKnowledge follows semver with a **pre-1.0 shift-down**: while we're below `1.0.0`, what semver would call a major (breaking API change) is encoded as `minor`, and what semver would call a minor (new feature) is encoded as `patch`. Most changesets are `patch`. `minor` is rare — reserve it for large API contract changes or large feature additions. **Never declare `major` pre-1.0** (see the `"//"` line in `.changeset/config.json`).
- Body should lead with the user-visible verb, name the affected command or surface in a code-span, and (if relevant) show before/after. Skip internal references like spec IDs or story numbers — those rot and aren't visible to readers of the public release notes.
- Don't write inline references to sibling-package versions (e.g. `@inkeep/open-knowledge-core@0.5.0-beta.6`) — the fixed-group lock-step bumps are computed at release time and any number you'd write would be wrong.
- Skip changesets for docs-only edits, test-only edits, or CI-only edits that don't change runtime behavior.

Cadence: merging a PR with a changeset triggers a beta publish within minutes via the event-driven `release.yml` on the public mirror.

## Before Finishing

Run the smallest relevant check while iterating, then run:

```bash
bun run check
```

For UI or editor changes, also run the affected package tests from `packages/app`.
