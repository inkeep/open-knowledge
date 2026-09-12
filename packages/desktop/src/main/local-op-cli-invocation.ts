import { win32 } from 'node:path';
import type { LocalOpCliInvocation } from '@inkeep/open-knowledge-server';
import { wrapperPathInBundle } from './bundle-paths.ts';

export interface ResolveLocalOpCliInvocationInput {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly execPath: string;
  readonly resourcesPath: string;
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
}

function bundledCliEntryOnWindows(resourcesPath: string): string {
  return win32.join(resourcesPath, 'cli', 'dist', 'cli.mjs');
}

export function resolveLocalOpCliInvocation(
  input: ResolveLocalOpCliInvocationInput,
): LocalOpCliInvocation {
  if (!input.isPackaged) {
    return { cliArgs: ['open-knowledge'] };
  }
  if (input.platform === 'win32') {
    const nodeOptions = input.parentEnv.NODE_OPTIONS;
    return {
      cliArgs: [input.execPath, bundledCliEntryOnWindows(input.resourcesPath)],
      cliEnv: {
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: undefined,
        ...(nodeOptions ? { OK_NODE_OPTIONS: nodeOptions } : {}),
      },
    };
  }
  return { cliArgs: [wrapperPathInBundle(input.execPath, input.platform)] };
}

export function resolveLocalOpCliArgsForUtilityFork(invocation: LocalOpCliInvocation): string[] {
  if (invocation.cliEnv !== undefined) {
    throw new Error(
      'local-op CLI invocation carries a cliEnv overlay that bare argv would drop; the utility-fork path cannot run this invocation',
    );
  }
  return [...invocation.cliArgs];
}
