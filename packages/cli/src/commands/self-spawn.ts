
import { existsSync } from 'node:fs';
import { resolveHelperBundleBinary } from '@inkeep/open-knowledge-core/helper-bundle';

const APP_CONTENTS_MACOS_RE = /\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/;

export interface MaybeRedirectToHelperBundleInput {
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly exists: (path: string) => boolean;
}

export function maybeRedirectToHelperBundle(
  input: MaybeRedirectToHelperBundleInput,
): string | null {
  if (input.platform !== 'darwin') return null;
  if (!APP_CONTENTS_MACOS_RE.test(input.execPath)) return null;
  const helperPath = resolveHelperBundleBinary(input.execPath);
  if (!input.exists(helperPath)) return null;
  return helperPath;
}

export interface ResolveSelfSpawnDeps {
  readonly execPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly argv?: readonly string[];
  readonly exists?: (path: string) => boolean;
}

export function resolveSelfSpawn(deps: ResolveSelfSpawnDeps = {}): {
  command: string;
  prefixArgs: readonly string[];
} {
  const execPath = deps.execPath ?? process.execPath;
  const platform = deps.platform ?? process.platform;
  const argv = deps.argv ?? process.argv;
  const exists = deps.exists ?? existsSync;

  const entry = argv[1];
  if (!entry) {
    console.warn(
      '[self-spawn] process.argv[1] is empty — falling back to `npx -y @inkeep/open-knowledge@latest`. ' +
        'This re-introduces the registry-fetch surface that re-exec was fixing. ' +
        `Observed argv: ${JSON.stringify(argv)}`,
    );
    return { command: 'npx', prefixArgs: ['-y', '@inkeep/open-knowledge@latest'] };
  }

  const redirected = maybeRedirectToHelperBundle({ execPath, platform, exists });
  const command = redirected ?? execPath;
  return { command, prefixArgs: [entry] };
}
