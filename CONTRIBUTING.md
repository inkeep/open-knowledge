# Contributing to OpenKnowledge

Thanks for contributing! Bug reports, feature requests, and pull requests are all welcome.

- **Found a bug or have an idea?** [Open an issue](https://github.com/inkeep/open-knowledge/issues/new/choose).
- **Question or setup help?** Ask in [Discord](https://discord.gg/VRKk2EaGHN).
- **Ready to code?** Open a pull request against this repository.
- **Read a language other than English?** Most of our interface translations are machine-translated and have never been read by a native speaker, and we ship them anyway rather than hide them from the people who could fix them. Correcting one is the most useful thing you can do for it — see [Translate the interface](https://openknowledge.ai/docs/contribute/translations).

## Development setup

A fresh clone builds and tests with no environment variables:

```bash
corepack enable pnpm  # make the pnpm commands below use the packageManager pin
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

The repo pins **Node.js 24.21.0** in `.node-version` and in `package.json`'s `devEngines.runtime`, and the `packageManager` field selects the exact **pnpm 12** version. `pnpm install` downloads that Node.js into the pnpm store the first time, from the per-platform archives `pnpm-lock.yaml` pins by checksum, so the first install needs network access. After that, every command started through `pnpm run`, `pnpm exec` or a package script runs on it, whichever `node` is on your `PATH`, and `engineStrict` in `pnpm-workspace.yaml` checks the `engines.node` range against it. Keep the two pins equal, and run `pnpm install` after changing them so the commands, and the Turbo cache key the install writes, pick up the new version. Corepack and npm both need a Node.js to provide pnpm, so install the `.node-version` release first with your Node version manager (for example `fnm install`), then run `corepack enable pnpm` once so the `pnpm` commands below use Corepack's shim, or install pnpm 12 with `npm install -g pnpm@12`. The standalone installer from [pnpm.io/installation](https://pnpm.io/installation) needs no Node.js. A pnpm 10 on your `PATH` cannot switch itself to pnpm 12, so upgrade it or use Corepack. For a script you start with `node` directly, select `.node-version` first with your Node version manager, for example `fnm use`.

Rust is pinned to one exact release. `rust-toolchain.toml` at the repo root declares it, and rustup applies it to every `cargo` and `rustc` call inside the repository and installs that release on the first build, so that build needs network access once. Install rustup from [rustup.rs](https://rustup.rs). The native-config package's build script refuses any other compiler: a `RUSTUP_TOOLCHAIN` variable, a `+toolchain` argument, a `rustup override` set on the directory, or a `cargo` or `rustc` earlier on your `PATH` that rustup does not manage (a Homebrew, distribution or Nix install, for example). Its error names the compiler it found and the release the file declares.

TypeScript is pinned twice on purpose. `@typescript/native` is this repo's alias for `typescript@~7.0.2`, the Go compiler the gates run; it owns the `tsc` binary, so `node_modules/.bin/tsc --version` at the root reports 7. The root's own `typescript` stays on `~6.0.3` only to supply tsserver to your editor, because TypeScript 7 ships none — that is an API resolution, not the compiler. The split means 7.0-only lib typings or an unchecked side-effect import can red a gate your editor calls clean. Open your editor at the repo root, not inside a package, or its language server falls back to a machine-global TypeScript. Any package that runs `tsc` in a script declares `"typescript": "~7.0.2"` of its own; `node scripts/check-typescript-resolution.mjs`, which `pnpm run check:drift:guards` runs, enforces the *resolved* 7.0 line rather than the declared range; the range is a tilde for that reason, because a caret installs clean today and reds once 7.1 ships. Its errors say why.

The base `tsconfig.json` carries three settings that red a first build. `erasableSyntaxOnly: true` makes constructor parameter properties (`constructor(private foo: string)`) an error; write the assignment out. `verbatimModuleSyntax: true` makes a plain `import { SomeType }` an error; write `import type`. `types: []` turns off automatic `@types/*` inclusion, so a package that uses Node globals lists `"types": ["node"]` in its own `tsconfig.json` and `@types/node` in its own `package.json`.

Patched dependencies (listed under `patchedDependencies` in `pnpm-workspace.yaml`, with the diffs in `patches/`) are authored with pnpm: run `pnpm patch <name>@<version>`, edit the printed temp directory, then `pnpm patch-commit <temp-dir>` to write the patch file and register it. A patch that fails to apply fails the install closed — it is never silently skipped.

### Spelling-language combobox

The spelling-language picker uses [shadcn Combobox multiple-selection chips](https://ui.shadcn.com/docs/components/radix/combobox#multiple-selection), backed by Base UI because [Radix Primitives does not provide a Combobox primitive](https://github.com/radix-ui/primitives/issues/3549#issuecomment-2895211522). Other controls, including the surrounding Settings dialog, remain Radix. Keep the popup portal inside that dialog's focus boundary and scope Escape interception to the open spelling combobox, not cmdk Settings search. The combobox inherits reduced-motion styling at the primitive level.

With the installed Base UI version, ArrowLeft from the empty search input moves focus onto a chip and closes the popup. Escape then dismisses Settings because no popup remains open. Keep this distinct from Escape in the expanded input, which closes only the popup first.

The four Floating UI overrides in `pnpm-workspace.yaml` satisfy Base UI's direct and transitive dependency floors, rather than the historical Radix dependency freeze. They are shared with Radix positioning and editor suggestion popups. Changes need regression coverage of Settings, ShareBranchSwitchDialog and CreateProjectDialog, not just the language picker. Keyboard selection/removal, popup-first Escape dismissal, empty search and reduced-motion styling have DOM coverage beside the components.

## Common commands

```bash
pnpm run format       # format (Biome)
pnpm run lint         # lint (Biome)
pnpm run typecheck    # TypeScript
pnpm run test         # tests
pnpm run build        # build all packages
pnpm run check        # lint + typecheck + test
pnpm run check:drift:guards  # unused deps/exports, generated-artifact freshness, toolchain pins (not part of `check`)
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
- Add a changeset by running `pnpm run changeset` if your pull request changes user-facing or programmatic behavior. Open Knowledge is pre-1.0, so a breaking change rides as `minor` and a `major` changeset is rejected — reaching 1.0.0 is a team decision, not one a single changeset makes.
- Run `pnpm run check` and `pnpm run check:drift:guards` and confirm both pass.
- Commit `pnpm-lock.yaml` when dependencies change, and run `pnpm run notices` to refresh `THIRD_PARTY_NOTICES.md` if third-party packages changed.
- Never include secrets, credentials, customer data, or local machine paths.
- Enable **Allow edits from maintainers** so reviewers can push fixes to your branch.

A maintainer will review your PR; if you don't hear back within a few business days, a friendly nudge on the thread is welcome. Accepted changes land on `main` with your authorship preserved (your PR may show as closed rather than merged).

## License

By contributing, you agree that your work is licensed under the [GNU General Public License v3.0 or later](./LICENSE) (`GPL-3.0-or-later`), the same license as OpenKnowledge.
