/**
 * PATH augmentation for git spawns from GUI-launched processes.
 *
 * macOS GUI apps (and their descendants — including the detached OK server)
 * inherit launchd's minimal `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, not the
 * login shell's. git itself survives that (Apple ships /usr/bin/git, and
 * git-preflight probes fallback locations for the binary), but git spawns
 * PATH-resolved *helper* subprocesses mid-operation — `filter.lfs.process`
 * (git-lfs), credential helpers, `core.sshCommand`, `core.fsmonitor`, hook
 * interpreters — and those are typically package-manager installs that only a
 * shell profile puts on PATH. A missing helper aborts the whole operation
 * (`filter.lfs.required=true` makes checkout fatal), so every git spawn env
 * must carry an augmented PATH, not just a resolved git binary.
 *
 * Static augmentation (append well-known tool directories) is deliberate over
 * login-shell env resolution: it is deterministic, costs nothing at startup,
 * has no interaction with user shell configs (timeouts, non-POSIX shells,
 * stdout pollution), and behaves identically in dev and packaged builds. The
 * trade-off — installs outside these directories stay unreachable — is
 * covered by `detectMissingGitHelper`, which turns the residual failure into
 * an actionable message instead of a generic error.
 *
 * Appending (never prepending) keeps the user's existing PATH order
 * authoritative: an entry already on PATH always wins over the same name in a
 * well-known directory, so augmentation can only ADD resolution, never change
 * which binary an existing lookup finds.
 */

/** Injectable seams so the pure augmentation logic is testable per-platform.
 *  All host facts are caller-supplied — this module is bundled into the
 *  browser app via the core barrel, so it MUST NOT import `node:path` /
 *  `node:os` / `node:fs` (Vite externalizes them and the property access
 *  throws at client startup, blanking the app). */
export interface GitSpawnPathOptions {
  readonly platform: NodeJS.Platform;
  /** User home directory (`os.homedir()`). */
  readonly homeDir: string;
  /** Existence probe for a candidate directory (`fs.existsSync` in prod). */
  readonly isDir: (dir: string) => boolean;
  /** PATH separator — pass the host's `path.delimiter`. */
  readonly delimiter: string;
}

/**
 * Well-known tool directories per platform, ordered by install-base size.
 * Homebrew (both prefixes) dominates macOS; MacPorts and `~/.local/bin` cover
 * the common remainder; asdf/mise shim directories cover version-managed
 * installs whose real binaries live behind versioned paths no static list can
 * express. Windows returns empty — Git for Windows bundles git-lfs and its
 * installer manages PATH, so augmentation has nothing safe to add.
 */
export function wellKnownToolDirs(platform: NodeJS.Platform, homeDir: string): readonly string[] {
  // '/'-joined literals, not `path.join` — browser-safe (see the interface
  // note), and correct for every platform that reaches them: the win32 arm
  // (the only backslash platform) never builds a home-relative path.
  switch (platform) {
    case 'darwin':
      return [
        '/opt/homebrew/bin', // Apple Silicon brew
        '/usr/local/bin', // Intel brew + manual installs
        '/opt/local/bin', // MacPorts
        `${homeDir}/.local/bin`,
        `${homeDir}/.asdf/shims`,
        `${homeDir}/.local/share/mise/shims`,
      ];
    case 'win32':
      return [];
    default:
      return [
        '/usr/local/bin',
        '/home/linuxbrew/.linuxbrew/bin', // Homebrew on Linux
        `${homeDir}/.local/bin`,
        `${homeDir}/.asdf/shims`,
        `${homeDir}/.local/share/mise/shims`,
      ];
  }
}

/**
 * Append `dirs` to `currentPath`: only those that exist on disk and aren't
 * already present (exact string match against current entries, and against
 * dirs already appended this call). `undefined`/empty input yields just the
 * appended dirs, so a spawn env never ends up with an empty PATH. Appending
 * (never prepending) keeps existing entries authoritative. Idempotent.
 */
function appendDirs(
  currentPath: string | undefined,
  dirs: readonly string[],
  options: GitSpawnPathOptions,
): string {
  const delim = options.delimiter;
  const existing = (currentPath ?? '').split(delim).filter((entry) => entry.length > 0);
  const present = new Set(existing);
  const additions: string[] = [];
  for (const dir of dirs) {
    if (!present.has(dir) && options.isDir(dir)) {
      present.add(dir);
      additions.push(dir);
    }
  }
  return [...existing, ...additions].join(delim);
}

/**
 * Return `currentPath` with well-known tool directories APPENDED. See
 * `appendDirs` for the append/dedup/existence semantics.
 */
export function augmentGitSpawnPath(
  currentPath: string | undefined,
  options: GitSpawnPathOptions,
): string {
  return appendDirs(currentPath, wellKnownToolDirs(options.platform, options.homeDir), options);
}

/**
 * JavaScript package-manager global bin directories where coding-agent CLIs
 * (the ACP harnesses — pi, claude, codex, …) land on a global install. These
 * are put on PATH only by a shell profile, so an agent installed with e.g.
 * `pnpm add -g` is unreachable from a Dock/Finder-launched app that inherits
 * launchd's minimal PATH. Static home-relative literals, NOT `$PNPM_HOME` /
 * `$BUN_INSTALL` reads: those vars are shell-profile-set too, so they are
 * equally absent in exactly the launchd-minimal case this targets.
 */
export function agentToolDirs(platform: NodeJS.Platform, homeDir: string): readonly string[] {
  switch (platform) {
    case 'darwin':
      return [
        `${homeDir}/Library/pnpm`, // pnpm global (PNPM_HOME default on macOS)
        `${homeDir}/.bun/bin`, // bun global
        `${homeDir}/.volta/bin`, // Volta shims
        `${homeDir}/.yarn/bin`, // Yarn classic global
        `${homeDir}/.npm-global/bin`, // npm's documented non-sudo prefix
      ];
    case 'win32':
      // Explorer-launched apps inherit the registry-backed user PATH, so the
      // minimal-PATH class barely exists here — nothing safe to statically add.
      return [];
    default:
      return [
        `${homeDir}/.local/share/pnpm`, // pnpm global (XDG default on Linux)
        `${homeDir}/.bun/bin`,
        `${homeDir}/.volta/bin`,
        `${homeDir}/.yarn/bin`,
        `${homeDir}/.npm-global/bin`,
      ];
  }
}

/**
 * Like `augmentGitSpawnPath`, but for ACP agent + terminal spawns: appends the
 * well-known tool dirs (npx/uvx/node are commonly Homebrew installs) AND the
 * package-manager global bins where agent CLIs install. Same append-only,
 * existence-gated, idempotent semantics; never yields an empty PATH.
 */
export function augmentAgentSpawnPath(
  currentPath: string | undefined,
  options: GitSpawnPathOptions,
): string {
  const dirs = [
    ...wellKnownToolDirs(options.platform, options.homeDir),
    ...agentToolDirs(options.platform, options.homeDir),
  ];
  return appendDirs(currentPath, dirs, options);
}
