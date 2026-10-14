import { win32 } from 'node:path';
import {
  type HostCliInvocation,
  isDevChannel,
  OkCliCommand,
} from '@inkeep/open-knowledge-core/constants/product';
import { wrapperPathInBundle } from './bundle-paths.ts';

export type { HostCliInvocation };

export interface ResolveLocalOpCliInvocationInput {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly execPath: string;
  readonly resourcesPath: string;
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  readonly workspaceCliEntry: string;
  readonly workspaceCliBuilt: boolean;
}

function bundledCliEntryOnWindows(resourcesPath: string): string {
  return win32.join(resourcesPath, 'cli', 'dist', 'cli.mjs');
}

export function resolveLocalOpCliInvocation(
  input: ResolveLocalOpCliInvocationInput,
): HostCliInvocation | undefined {
  if (!input.isPackaged) {
    if (!isDevChannel(input.parentEnv)) return { cliArgs: ['open-knowledge'] };
    return input.workspaceCliBuilt ? { cliArgs: ['node', input.workspaceCliEntry] } : undefined;
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

export function resolveLocalOpCliArgsForUtilityFork(invocation: HostCliInvocation): string[] {
  if (invocation.cliEnv !== undefined) {
    throw new Error(
      'local-op CLI invocation carries a cliEnv overlay that bare argv would drop; the utility-fork path cannot run this invocation',
    );
  }
  return [...invocation.cliArgs];
}

export function mainProcessOkCli(
  invocation: HostCliInvocation | undefined,
  env: Readonly<Record<string, string | undefined>>,
): OkCliCommand {
  return OkCliCommand.resolve({ host: invocation, env });
}
