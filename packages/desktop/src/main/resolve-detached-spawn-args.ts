import type { SpawnOptions } from 'node:child_process';
import { posix as pathPosix, win32 as pathWin32 } from 'node:path';
import { resolveHelperBundleBinary } from '@inkeep/open-knowledge-core/helper-bundle';
import { fallbackPaths } from '@inkeep/open-knowledge-server';

/**
 * Inputs that determine the detached-server spawn shape. The caller
 * (`spawnDetachedServer` in `./index.ts`) has already opened the
 * `SPAWN_ERROR_LOG` fd, resolved the bundled CLI path, and computed the
 * react-shell dist dir — this function only decides what binary to spawn
 * and how to wire env / stdio / cwd, returning a shape the caller passes
 * verbatim to `child_process.spawn(...)`.
 *
 * On darwin packaged builds, `parentExecPath` resolves to
 * `<parent .app>/Contents/MacOS/<MainBinary>` — invoking that path with
 * `ELECTRON_RUN_AS_NODE=1` causes macOS LaunchServices to register a
 * duplicate `.app` launch, which `coreservicesd` displays as a stuck
 * "exec" Dock placeholder for the lifetime of the child. To avoid that,
 * we redirect the spawn to a helper bundle at
 * `<parent .app>/Contents/Frameworks/OpenKnowledge Server.app/Contents/MacOS/OpenKnowledge Helper`.
 * The helper bundle's `Info.plist` declares `LSUIElement=true`, telling
 * LaunchServices to launch the process without a Dock tile (the canonical
 * Apple convention used by Electron's own `Electron Helper.app`). Off
 * darwin or in dev mode the parent execPath is used directly — no Dock
 * concern outside packaged macOS.
 *
 * The bundle name + executable basename + path arithmetic
 * (`resolveHelperBundleBinary`) live in
 * `@inkeep/open-knowledge-core/helper-bundle.ts` so the CLI self-spawn
 * site (`packages/cli/src/commands/self-spawn.ts`, covering the
 * `ok mcp → ok start` and `ok start → ok ui` auto-spawn paths) shares the
 * same path-arithmetic source of truth as this resolver. The CLI's
 * redirect predicate is colocated with its sole consumer there because
 * it encodes a CLI-only heuristic (`.app/Contents/MacOS/` regex + an
 * `exists` probe), needed only because the CLI runs under
 * `ELECTRON_RUN_AS_NODE=1` and lacks Electron's authoritative
 * `app.isPackaged` signal that this resolver gates on. The "four sites
 * must agree" contract — Info.plist `CFBundleExecutable`,
 * `afterPack.mjs`, `electron-builder.yml`'s `extraFiles[].to`, and the
 * shared path-resolution — is unchanged.
 */
export interface ResolveDetachedSpawnArgsInput {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly parentExecPath: string;
  readonly bundleCliMjsPath: string;
  readonly reactShellDistDir: string;
  readonly contentDir: string;
  readonly spawnErrorLogFd: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * No-project ephemeral single-file mode (`ok <file>`). When set, the child is
   * spawned with `start --single-file <singleFile> --project-dir <projectDir>`
   * so the CLI boots the slim single-file shape (git + MCP off; content scoped
   * to the one doc). `projectDir` is the throwaway temp project root carrying the
   * synthesized `.ok/config.yml` — distinct from `contentDir`, the file's real
   * parent. The spawn `cwd` becomes `projectDir` (where the lock lands) so
   * the parent's `pollServerLock` reads `<projectDir>/.ok/local/server.lock`.
   * Both fields are absent in the normal project-open spawn.
   */
  readonly singleFile?: string;
  readonly projectDir?: string;
}

export interface ResolvedDetachedSpawnArgs {
  readonly file: string;
  readonly args: readonly string[];
  readonly opts: SpawnOptions;
}

/**
 * Cross-platform PATH delimiter derived from the *target* platform, not the
 * host `path.delimiter`. The function must be pure with respect to the input
 * — the resolver is exercised across all (platform, isPackaged) combinations
 * under the bun:test contract.
 */
function platformPathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':';
}

/**
 * Likely git install directories per platform. Derived mechanically from
 * `fallbackPaths(platform)` in `@inkeep/open-knowledge-server` (the same set
 * the two-stage probe in `git-preflight.ts` Stage 2 walks). Stays in lockstep
 * with the fallback path list by construction — if a new path lands in
 * `fallbackPaths`, this picks it up without a second edit site.
 *
 * Dispatches to `path.win32.dirname` vs `path.posix.dirname` via the target
 * platform — `node:path`'s host-default `dirname` returns `'.'` for Windows
 * paths on POSIX hosts because `\` isn't seen as a separator. Keeping this
 * pure w.r.t. the input platform matters for the bun:test cross-platform
 * matrix (the resolver is exercised across all platforms).
 */
function gitEnrichmentDirs(platform: NodeJS.Platform): readonly string[] {
  const dn = platform === 'win32' ? pathWin32.dirname : pathPosix.dirname;
  return fallbackPaths(platform).map((p) => dn(p));
}

/**
 * Prepend `gitEnrichmentDirs(platform)` to the inherited PATH and de-duplicate,
 * preserving the original PATH order at the tail. Closes the Cursor-class
 * "git installed but launchctl-PATH-blind" failure mode at the Electron
 * server-child spawn site: when OK Desktop is launched from Spotlight / Dock /
 * Alfred, the inherited PATH lacks `/opt/homebrew/bin` (and Windows / Linux
 * equivalents), and the child's git probe falls through to Stage 2. With
 * enrichment, the child reaches git via Stage 1.
 *
 * The two-stage probe in `git-preflight.ts` stays as defense-in-depth — Electron
 * main itself can't self-enrich, and CLI users with non-standard install
 * locations still rely on Stage 2.
 */
function buildEnrichedPath(platform: NodeJS.Platform, currentPath: string | undefined): string {
  const delimiter = platformPathDelimiter(platform);
  const dirs = gitEnrichmentDirs(platform);
  const currentSegments = (currentPath ?? '').split(delimiter).filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const seg of dirs) {
    if (!seen.has(seg)) {
      seen.add(seg);
      result.push(seg);
    }
  }
  for (const seg of currentSegments) {
    if (!seen.has(seg)) {
      seen.add(seg);
      result.push(seg);
    }
  }
  return result.join(delimiter);
}

export function resolveDetachedSpawnArgs(
  input: ResolveDetachedSpawnArgsInput,
): ResolvedDetachedSpawnArgs {
  const {
    platform,
    isPackaged,
    parentExecPath,
    bundleCliMjsPath,
    reactShellDistDir,
    contentDir,
    spawnErrorLogFd,
    env,
    singleFile,
    projectDir,
  } = input;

  // Note on the `: parentExecPath` branch: in production-darwin-dev runs this
  // branch is unreachable. `index.ts` only wires `spawnDetachedServer` when
  // `bundleCliMjsPath !== null`, which is the `app.isPackaged` path; dev mode
  // takes `forkUtility` (utilityProcess.fork) and never enters this resolver.
  // The branch is preserved for symmetry under the bun:test contract, where
  // the resolver is exercised across all (platform, isPackaged) combinations
  // to pin the full shape — and so non-darwin packaged builds (win/linux,
  // landing in future milestones) work without further wiring.
  const file =
    platform === 'darwin' && isPackaged
      ? resolveHelperBundleBinary(parentExecPath)
      : parentExecPath;

  // Ephemeral single-file mode runs the project root (where the lock lands +
  // the spawn cwd) at `projectDir` (the throwaway temp dir), distinct from
  // `contentDir` (the file's real parent). The CLI's `--single-file` derives
  // the real contentDir from the file itself, so we only need to forward the
  // temp project root + the file path. `projectRoot` falls back to `contentDir`
  // for the normal project-open spawn (no `projectDir` passed).
  const projectRoot = projectDir ?? contentDir;
  const args = [
    bundleCliMjsPath,
    'start',
    '--serve-content-assets',
    '--react-shell-dist-dir',
    reactShellDistDir,
    ...(singleFile !== undefined
      ? ['--single-file', singleFile, '--project-dir', projectRoot]
      : []),
  ];

  const opts: SpawnOptions = {
    env: {
      ...env,
      PATH: buildEnrichedPath(platform, env.PATH),
      ELECTRON_RUN_AS_NODE: '1',
      OK_LOCK_KIND: 'interactive',
    },
    detached: true,
    stdio: ['ignore', 'ignore', spawnErrorLogFd],
    cwd: projectRoot,
  };

  return { file, args, opts };
}
