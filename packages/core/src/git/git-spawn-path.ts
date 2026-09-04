export interface GitSpawnPathOptions {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly isDir: (dir: string) => boolean;
  readonly delimiter: string;
}

export function wellKnownToolDirs(platform: NodeJS.Platform, homeDir: string): readonly string[] {
  switch (platform) {
    case 'darwin':
      return [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/opt/local/bin',
        `${homeDir}/.local/bin`,
        `${homeDir}/.asdf/shims`,
        `${homeDir}/.local/share/mise/shims`,
      ];
    case 'win32':
      return [];
    default:
      return [
        '/usr/local/bin',
        '/home/linuxbrew/.linuxbrew/bin',
        `${homeDir}/.local/bin`,
        `${homeDir}/.asdf/shims`,
        `${homeDir}/.local/share/mise/shims`,
      ];
  }
}

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

export function augmentGitSpawnPath(
  currentPath: string | undefined,
  options: GitSpawnPathOptions,
): string {
  return appendDirs(currentPath, wellKnownToolDirs(options.platform, options.homeDir), options);
}

export function agentToolDirs(platform: NodeJS.Platform, homeDir: string): readonly string[] {
  switch (platform) {
    case 'darwin':
      return [
        `${homeDir}/Library/pnpm`,
        `${homeDir}/.bun/bin`,
        `${homeDir}/.volta/bin`,
        `${homeDir}/.yarn/bin`,
        `${homeDir}/.npm-global/bin`,
      ];
    case 'win32':
      return [];
    default:
      return [
        `${homeDir}/.local/share/pnpm`,
        `${homeDir}/.bun/bin`,
        `${homeDir}/.volta/bin`,
        `${homeDir}/.yarn/bin`,
        `${homeDir}/.npm-global/bin`,
      ];
  }
}

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
