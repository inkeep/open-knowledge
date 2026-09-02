# OpenKnowledge Agent Guide

This is the public OpenKnowledge repository. Keep changes compatible with the published package and standalone clone experience.

## Start Here

- Read [README.md](./README.md) for the project overview.
- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before changing public PR flow, dependencies, or exported docs.
- Use Node.js 24 or newer and pnpm 10 or newer.
- This repo does not use code comments. Read [Comment policy](#comment-policy) before writing any.

## Commands

```bash
pnpm install
pnpm run check
pnpm run build
```

Use these during development:

```bash
pnpm run format
pnpm run lint
pnpm run typecheck
pnpm run test
```

Run local apps:

```bash
pnpm --filter @inkeep/open-knowledge-app run dev

cd docs
pnpm run dev
```

## Repo Layout

- `packages/app` - web app and editor UI
- `packages/cli` - CLI and package entrypoint
- `packages/core` - shared domain logic
- `packages/desktop` - Electron desktop app
- `packages/plugin` - agent integration package
- `packages/server` - local collaboration server
- `docs` - documentation site

## Comment policy

**Write no comments.** Explanation belongs in names, types, tests, the commit message, the PR body, or a doc — a comment is the one place it rots unseen. This inverts the usual open-source norm, so it surprises people; it is deliberate, and `pnpm run lint` enforces it.

Keep only these, and nothing else:

- **Directives a tool parses**, anchored at the comment's first line: `biome-ignore lint/style/noVar: reason`, `@ts-expect-error the fixture is deliberately malformed` (a reason is required), `oxlint-disable-next-line`, `@vitest-environment jsdom`, `@ts-nocheck`, `prettier-ignore`, `@vite-ignore`, `/// <reference types="vite/client" />`, `SPDX-License-Identifier: GPL-3.0-or-later`, `/* @lintignore knip cannot see the dynamic import site */` (block or JSDoc form only; the line-comment form is rejected because knip does not read it). If a tool reads it, it is code.
- **JSDoc carrying `@deprecated`.** The allowlist also defines an audit-tag class, but its tag list is empty in this repo, so that class admits nothing here: a tag-bearing JSDoc block is rejected as prose.
- **Contract markers**, which the comment must BEGIN with: `STOP: a cross-file contract a reader must not break`, `WARN: a sibling that silently drifts if this changes`, `UPSTREAM(electron/electron#19920): a code shape forced on us from outside this repo`.
- **A validated citation**, as in `precedent #42`.
- **Registered guard markers**, each of which a specific checker reads: `error-log-shape-ok: <why>`, `presence-exempt: <why>`, and `documented exemption from Precedent #30`. The set is fixed — you cannot invent a new one.

An `UPSTREAM` referent must be one of four shapes, so it always resolves to something a reader can look up: a GitHub issue (`electron/electron#19920`), an RFC (`RFC 9457`), a CommonMark section (`CommonMark §6.5`), or a package version (`vite@7.1.0`). Anything else fails lint.

Banned: `plain prose`, JSDoc description text, `//////// section dividers`, commented-out code such as `const disabled = true;`, `TODO`, `FIXME`, `@ts-ignore`, and process metadata such as `PRD-1234` or `at line 370`. Process metadata stays banned **inside** an allowlisted comment too: a legitimate STOP marker still fails lint if it carries a ticket number, a spec path, or a line reference.

A marker is not a license, and passing lint is not the same as being legitimate. Lint rejects a referent it cannot resolve (`UPSTREAM(some blog post): not a resolvable referent`) and a citation of a precedent that does not exist (`precedent #999`). It cannot tell whether a well-formed marker is load-bearing, so a `STOP:` essay or a `WARN:` that warns of nothing passes lint and gets caught in review instead — as a worse finding than the comment it disguises. The same applies to reasoning parked in a suppression's reason slot: a suppression reason is free text, so a paragraph of design rationale smuggled into one passes lint, and is a review finding for the same reason.

If `pnpm run lint` fails on a comment, the diagnostic names the class, the fix, and a link into [`lint-plugins/no-comments/README.md`](./lint-plugins/no-comments/README.md), which is the full policy. Delete the comment, or convert it to one of the forms above.

## Public Mirror Rules

- This repo is generated from an allowlist. Do not rely on hidden source-only folders being present.
- Public PRs are reviewed by maintainers and accepted changes sync back here automatically. A PR may close rather than show as merged; that is expected for this mirror.
- Top-level public docs such as `README.md`, `CONTRIBUTING.md`, and `AGENTS.md` are overlay files. Keep them public-safe and standalone.
- Do not add secrets, private customer context, internal-only specs, local paths, or generated debug artifacts.
- Keep dependency updates paired with `pnpm-lock.yaml`. Run `pnpm run notices` when third-party notices may change.

## Changesets

Every behavior-changing PR ships a `.changeset/<kebab-name>.md` file. The body becomes the user-facing entry on the next beta's GitHub Release and on the aggregated stable Release notes — that's how npm consumers and desktop auto-update users learn what changed. Write release-note copy, not a commit-message reprise.

- Create one with `pnpm run changeset`, or hand-write a file named `.changeset/<descriptive-kebab-slug>.md`.
- Front-matter: at minimum `'@inkeep/open-knowledge': patch`. OpenKnowledge follows semver with a **pre-1.0 shift-down**: while we're below `1.0.0`, what semver would call a major (breaking API change) is encoded as `minor`, and what semver would call a minor (new feature) is encoded as `patch`. Most changesets are `patch`. `minor` is rare — reserve it for large API contract changes or large feature additions. **Never declare `major` pre-1.0** (see the `"//"` line in `.changeset/config.json`).
- Body should lead with the user-visible verb, name the affected command or surface in a code-span, and (if relevant) show before/after. Skip internal references like spec IDs or story numbers — those rot and aren't visible to readers of the public release notes.
- Don't write inline references to sibling-package versions (e.g. `@inkeep/open-knowledge-core@0.5.0-beta.6`) — the fixed-group lock-step bumps are computed at release time and any number you'd write would be wrong.
- Skip changesets for docs-only edits, test-only edits, or CI-only edits that don't change runtime behavior.

Cadence: merging a PR with a changeset triggers a beta publish within minutes via the event-driven `release.yml` on the public mirror.

## Before Finishing

Run the smallest relevant check while iterating, then run:

```bash
pnpm run check
```

For UI or editor changes, also run the affected package tests from `packages/app`.
