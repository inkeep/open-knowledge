# Contributing to OpenKnowledge

Thanks for contributing! Bug reports, feature requests, and pull requests are all welcome.

- **Found a bug or have an idea?** [Open an issue](https://github.com/inkeep/open-knowledge/issues/new/choose).
- **Question or setup help?** Ask in [Discord](https://discord.gg/VRKk2EaGHN).
- **Ready to code?** Open a pull request against this repository.
- **Read a language other than English?** Most of our interface translations are machine-translated and have never been read by a native speaker, and we ship them anyway rather than hide them from the people who could fix them. Correcting one is the most useful thing you can do for it — see [Translate the interface](https://openknowledge.ai/docs/contribute/translations).

## Development setup

A fresh clone builds and tests with no environment variables:

```bash
pnpm install
pnpm run check        # lint, typecheck, and tests
```

Run the editor app (http://localhost:5173):

```bash
cd packages/app && pnpm run dev
```

Run the docs site:

```bash
cd docs && pnpm run dev
```

See `.env.example` for optional settings (OpenTelemetry, a custom dev port).

### Toolchain

The repo pins **Node.js 24+** and **pnpm 10+** (via `.node-version`, the `packageManager` field, and `engines`). Enable pnpm with `corepack enable pnpm`, or install it standalone (`npm install -g pnpm@10`). With a Node version manager, use `fnm install`, `mise install`, or `volta install node@24`. pnpm enforces the engine range (`engine-strict`), so on older Node `pnpm install` fails fast — pin Node 24+ first.

Patched dependencies (listed under `patchedDependencies` in `pnpm-workspace.yaml`, with the diffs in `patches/`) are authored with pnpm: run `pnpm patch <name>@<version>`, edit the printed temp directory, then `pnpm patch-commit <temp-dir>` to write the patch file and register it. A patch that fails to apply fails the install closed — it is never silently skipped.

## Common commands

```bash
pnpm run format       # format (Biome)
pnpm run lint         # lint (Biome)
pnpm run typecheck    # TypeScript
pnpm run test         # tests
pnpm run build        # build all packages
pnpm run check        # lint + typecheck + test
```

Run a single package's scripts from its directory, e.g. `cd packages/app && pnpm run test`.

## Code comments

This repo does not use code comments, and `pnpm run lint` enforces that. It inverts the usual open-source norm, so it catches most first-time contributors by surprise — it is deliberate, not an oversight. Put the explanation in a name, a type, a test, your commit message, or the PR body instead.

A short allowlist survives: directives a tool parses (`biome-ignore lint/style/noVar: reason`, `@ts-expect-error the fixture is deliberately malformed`, `@vitest-environment jsdom`, `/// <reference types="vite/client" />`, `SPDX-License-Identifier: GPL-3.0-or-later`), JSDoc carrying `@deprecated` (the audit-tag class is empty in this repo and admits nothing), and comments that BEGIN with a contract marker — `STOP: a cross-file contract a reader must not break`, `WARN: a sibling that silently drifts if this changes`, or `UPSTREAM(electron/electron#19920): a code shape forced on us from outside this repo`.

If lint stops you, the diagnostic names the class of comment, the fix, and links to [`lint-plugins/no-comments/README.md`](./lint-plugins/no-comments/README.md) — the full policy, including how to convert a comment worth keeping into one of the allowed forms. Deleting it is usually the right answer.

## Opening a pull request

First-time contributors are asked to sign our [Contributor License Agreement](./CLA.md) — a bot comments a one-click signing link on your PR (Inkeep employees are exempt automatically). Please follow the checklist in our [Pull Request Template](./.github/PULL_REQUEST_TEMPLATE.md):

- Keep PRs focused and small enough to review.
- Add tests — or a clear manual-verification note — for behavior changes.
- Write no code comments outside the allowlist above — `pnpm run lint` fails on the rest.
- Add a changeset by running `pnpm run changeset` if your pull request changes user-facing or programmatic behavior.
- Run `pnpm run check` and confirm it passes.
- Commit `pnpm-lock.yaml` when dependencies change, and run `pnpm run notices` to refresh `THIRD_PARTY_NOTICES.md` if third-party packages changed.
- Never include secrets, credentials, customer data, or local machine paths.
- Enable **Allow edits from maintainers** so reviewers can push fixes to your branch.

A maintainer will review your PR; if you don't hear back within a few business days, a friendly nudge on the thread is welcome. Accepted changes land on `main` with your authorship preserved (your PR may show as closed rather than merged).

## License

By contributing, you agree that your work is licensed under the [GNU General Public License v3.0 or later](./LICENSE) (`GPL-3.0-or-later`), the same license as OpenKnowledge.
