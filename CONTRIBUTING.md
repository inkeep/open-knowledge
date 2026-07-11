# Contributing to OpenKnowledge

Thanks for contributing! Bug reports, feature requests, and pull requests are all welcome.

- **Found a bug or have an idea?** [Open an issue](https://github.com/inkeep/open-knowledge/issues/new/choose).
- **Question or setup help?** Ask in [Discord](https://discord.gg/VRKk2EaGHN).
- **Ready to code?** Open a pull request against this repository.

## Development setup

A fresh clone builds and tests with no environment variables:

```bash
bun install
bun run check        # lint, typecheck, and tests
```

Run the editor app (http://localhost:5173):

```bash
cd packages/app && bun run dev
```

Run the docs site:

```bash
cd docs && bun run dev
```

See `.env.example` for optional settings (OpenTelemetry, a custom dev port).

### Toolchain

The repo pins **Bun 1.3.13+** and **Node.js 24+** (via `.bun-version`, `.node-version`, and `engines`). With a version manager, use `fnm install`, `mise install`, or `volta install node@24`. On older Node, `bun install` warns `EBADENGINE` and builds or tests may fail — pin Node 24+ first.

## Common commands

```bash
bun run format       # format (Biome)
bun run lint         # lint (Biome)
bun run typecheck    # TypeScript
bun run test         # tests
bun run build        # build all packages
bun run check        # lint + typecheck + test
```

Run a single package's scripts from its directory, e.g. `cd packages/app && bun run test`.

## Opening a pull request

First-time contributors are asked to sign our [Contributor License Agreement](./CLA.md) — a bot comments a one-click signing link on your PR (Inkeep employees are exempt automatically). Please follow the checklist in our [Pull Request Template](./.github/PULL_REQUEST_TEMPLATE.md):

- Keep PRs focused and small enough to review.
- Add tests — or a clear manual-verification note — for behavior changes.
- Add a changeset by running `bun run changeset` if your pull request changes user-facing or programmatic behavior.
- Run `bun run check` and confirm it passes.
- Commit `bun.lock` when dependencies change, and run `bun run notices` to refresh `THIRD_PARTY_NOTICES.md` if third-party packages changed.
- Never include secrets, credentials, customer data, or local machine paths.
- Enable **Allow edits from maintainers** so reviewers can push fixes to your branch.

A maintainer will review your PR; if you don't hear back within a few business days, a friendly nudge on the thread is welcome. Accepted changes land on `main` with your authorship preserved (your PR may show as closed rather than merged).

## License

By contributing, you agree that your work is licensed under the [GNU General Public License v3.0 or later](./LICENSE) (`GPL-3.0-or-later`), the same license as OpenKnowledge.
