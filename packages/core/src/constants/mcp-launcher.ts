export type McpLauncherEnvelope = 'split-command-args' | 'opencode-argv';
export type McpLauncherFamily = 'unix-chain' | 'windows-chain';

export type McpLauncherCapability =
  | 'macos-bundle'
  | 'linux-deb-bundle'
  | 'windows-global-cli'
  | 'npx-fallback';

export type KnownMcpLauncherDescriptor = {
  readonly envelope: McpLauncherEnvelope;
  readonly family: McpLauncherFamily;
  readonly revision: number;
  readonly knowledge: 'known';
  readonly capabilities: readonly McpLauncherCapability[];
};

export type FutureMcpLauncherDescriptor = {
  readonly envelope: McpLauncherEnvelope;
  readonly family: McpLauncherFamily;
  readonly revision: number;
  readonly knowledge: 'future';
  readonly capabilities: 'opaque';
};

export type McpLauncherDescriptor = KnownMcpLauncherDescriptor | FutureMcpLauncherDescriptor;

export type McpLauncherDeclineReason =
  | 'not-an-object'
  | 'unknown-envelope'
  | 'foreign-command'
  | 'malformed-argv'
  | 'malformed-marker'
  | 'unknown-revision'
  | 'dev-mode';

export type McpLauncherClassification =
  | {
      readonly kind: 'recognized';
      readonly disposition: 'keep' | 'upgrade';
      readonly descriptor: McpLauncherDescriptor;
    }
  | { readonly kind: 'declined'; readonly reason: McpLauncherDeclineReason };

export type McpLauncherRevisionCatalog = Readonly<
  Record<McpLauncherFamily, Readonly<Record<number, readonly McpLauncherCapability[]>>>
>;

export const DEFAULT_MCP_LAUNCHER_REVISION_CATALOG = {
  'unix-chain': {
    1: ['macos-bundle', 'npx-fallback'],
    2: ['macos-bundle', 'linux-deb-bundle', 'npx-fallback'],
  },
  'windows-chain': {
    1: ['windows-global-cli', 'npx-fallback'],
  },
} as const satisfies McpLauncherRevisionCatalog;

type ExtractedLauncher = {
  readonly envelope: McpLauncherEnvelope;
  readonly family: McpLauncherFamily;
  readonly body: string;
};

function decline(reason: McpLauncherDeclineReason): McpLauncherClassification {
  return { kind: 'declined', reason };
}

function extractLauncher(
  entry: Record<string, unknown>,
): ExtractedLauncher | McpLauncherClassification {
  if (entry.command === 'node') return decline('dev-mode');

  if (typeof entry.command === 'string') {
    if (!Array.isArray(entry.args)) return decline('malformed-argv');
    if (entry.command === '/bin/sh') {
      if (
        entry.args.length !== 3 ||
        entry.args[0] !== '-l' ||
        entry.args[1] !== '-c' ||
        typeof entry.args[2] !== 'string'
      ) {
        return decline('malformed-argv');
      }
      return { envelope: 'split-command-args', family: 'unix-chain', body: entry.args[2] };
    }
    if (entry.command === 'powershell') {
      if (
        entry.args.length !== 4 ||
        entry.args[0] !== '-NoProfile' ||
        entry.args[1] !== '-NonInteractive' ||
        entry.args[2] !== '-Command' ||
        typeof entry.args[3] !== 'string'
      ) {
        return decline('malformed-argv');
      }
      return { envelope: 'split-command-args', family: 'windows-chain', body: entry.args[3] };
    }
    return decline('foreign-command');
  }

  if (entry.type !== 'local' || !Array.isArray(entry.command)) {
    return decline('unknown-envelope');
  }
  const [interpreter, ...args] = entry.command;
  if (interpreter === 'node') return decline('dev-mode');
  if (interpreter === '/bin/sh') {
    if (args.length !== 3 || args[0] !== '-l' || args[1] !== '-c' || typeof args[2] !== 'string') {
      return decline('malformed-argv');
    }
    return { envelope: 'opencode-argv', family: 'unix-chain', body: args[2] };
  }
  if (interpreter === 'powershell') {
    if (
      args.length !== 4 ||
      args[0] !== '-NoProfile' ||
      args[1] !== '-NonInteractive' ||
      args[2] !== '-Command' ||
      typeof args[3] !== 'string'
    ) {
      return decline('malformed-argv');
    }
    return { envelope: 'opencode-argv', family: 'windows-chain', body: args[3] };
  }
  return decline('foreign-command');
}

function revisionFromFirstLine(body: string, family: McpLauncherFamily): number | null {
  const firstLine = body.split(/\r?\n/, 1)[0];
  const pattern = family === 'unix-chain' ? /^# ok-mcp-v([1-9]\d*)$/ : /^# ok-mcp-win-v([1-9]\d*)$/;
  const match = firstLine?.match(pattern);
  if (match === null || match === undefined) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? revision : null;
}

export function classifyMcpLauncherEntry(
  entry: unknown,
  catalog: McpLauncherRevisionCatalog = DEFAULT_MCP_LAUNCHER_REVISION_CATALOG,
): McpLauncherClassification {
  if (typeof entry !== 'object' || entry === null) return decline('not-an-object');
  const extracted = extractLauncher(entry as Record<string, unknown>);
  if ('kind' in extracted) return extracted;

  const revision = revisionFromFirstLine(extracted.body, extracted.family);
  if (revision === null) return decline('malformed-marker');

  const registry = catalog[extracted.family];
  const highestKnown = Math.max(...Object.keys(registry).map(Number));
  if (revision > highestKnown) {
    return {
      kind: 'recognized',
      disposition: 'keep',
      descriptor: {
        envelope: extracted.envelope,
        family: extracted.family,
        revision,
        knowledge: 'future',
        capabilities: 'opaque',
      },
    };
  }

  const capabilities: readonly McpLauncherCapability[] | undefined = registry[revision];
  if (capabilities === undefined) return decline('unknown-revision');
  return {
    kind: 'recognized',
    disposition: revision === highestKnown ? 'keep' : 'upgrade',
    descriptor: {
      envelope: extracted.envelope,
      family: extracted.family,
      revision,
      knowledge: 'known',
      capabilities,
    },
  };
}
