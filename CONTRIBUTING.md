# Contributing to OpenKnowledge

Thanks for contributing! Bug reports, feature requests, and pull requests are all welcome.

- **Found a bug or have an idea?** [Open an issue](https://github.com/inkeep/open-knowledge/issues/new/choose).
- **Question or setup help?** Ask in [Discord](https://discord.gg/VRKk2EaGHN).
- **Ready to code?** Open a pull request against this repository.

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

## Opening a pull request

First-time contributors are asked to sign our [Contributor License Agreement](./CLA.md) — a bot comments a one-click signing link on your PR (Inkeep employees are exempt automatically). Please follow the checklist in our [Pull Request Template](./.github/PULL_REQUEST_TEMPLATE.md):

- Keep PRs focused and small enough to review.
- Add tests — or a clear manual-verification note — for behavior changes.
- Add a changeset by running `pnpm run changeset` if your pull request changes user-facing or programmatic behavior.
- Run `pnpm run check` and confirm it passes.
- Commit `pnpm-lock.yaml` when dependencies change, and run `pnpm run notices` to refresh `THIRD_PARTY_NOTICES.md` if third-party packages changed.
- Never include secrets, credentials, customer data, or local machine paths.
- Enable **Allow edits from maintainers** so reviewers can push fixes to your branch.

A maintainer will review your PR; if you don't hear back within a few business days, a friendly nudge on the thread is welcome. Accepted changes land on `main` with your authorship preserved (your PR may show as closed rather than merged).

## License

By contributing, you agree that your work is licensed under the [GNU General Public License v3.0 or later](./LICENSE) (`GPL-3.0-or-later`), the same license as OpenKnowledge.
