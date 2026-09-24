import { dirname, isAbsolute } from 'node:path';
import type { InitializeResponse } from '@agentclientprotocol/sdk';
import { isTerminalLaunchEnvName } from '@inkeep/open-knowledge-core';
import type {
  ThreadAuthMethod,
  ThreadAuthTerminalLaunch,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import type { ResolvedLaunch } from './launch.ts';

export type TerminalAuthBase = ThreadAuthTerminalLaunch;

const NUL = String.fromCharCode(0);

export function terminalAuthBaseFor(
  launch: Pick<ResolvedLaunch, 'cmd' | 'args' | 'env' | 'kind'>,
  processEnv: NodeJS.ProcessEnv = process.env,
): TerminalAuthBase {
  const managedRuntime = (launch.kind === 'npx' || launch.kind === 'uvx') && isAbsolute(launch.cmd);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(launch.env)) {
    if (key.toLowerCase() === 'path' || !isTerminalLaunchEnvName(key)) continue;
    if (value.includes(NUL)) continue;
    if (processEnv[key] !== value) env[key] = value;
  }
  return {
    executable: launch.cmd,
    args: [...launch.args],
    env,
    pathPrepend: managedRuntime ? [dirname(launch.cmd)] : [],
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function envRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' || entry.includes(NUL)) continue;
    if (!isTerminalLaunchEnvName(key)) continue;
    out[key] = entry;
  }
  return out;
}

type RawAuthMethod = {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  type?: unknown;
  args?: unknown;
  env?: unknown;
};

function rawMethod(value: unknown): RawAuthMethod | null {
  return typeof value === 'object' && value !== null ? (value as RawAuthMethod) : null;
}

function terminalLaunchFor(
  method: RawAuthMethod,
  base: TerminalAuthBase,
): ThreadAuthTerminalLaunch {
  return {
    executable: base.executable,
    args: [...base.args, ...stringList(method.args)],
    env: { ...base.env, ...envRecord(method.env) },
    pathPrepend: [...base.pathPrepend],
  };
}

export function threadAuthMethods(
  methods: InitializeResponse['authMethods'],
  base: TerminalAuthBase | null,
): ThreadAuthMethod[] {
  return (methods ?? []).flatMap((m) => {
    const method = rawMethod(m);
    if (method === null) return [];
    const { id, name, description, type } = method;
    if (typeof id !== 'string' || typeof name !== 'string') return [];
    const terminalLaunchAvailable = type === 'terminal' && base !== null;
    return [
      {
        id,
        name,
        ...(typeof description === 'string' ? { description } : {}),
        ...(typeof type === 'string' ? { kind: type } : {}),
        ...(terminalLaunchAvailable ? { terminalLaunchAvailable: true as const } : {}),
      },
    ];
  });
}

export function terminalAuthLaunch(
  methods: InitializeResponse['authMethods'],
  base: TerminalAuthBase | null,
  methodId: string,
): ThreadAuthTerminalLaunch | null {
  if (base === null) return null;
  for (const m of methods ?? []) {
    const method = rawMethod(m);
    if (method === null || method.id !== methodId || method.type !== 'terminal') continue;
    return terminalLaunchFor(method, base);
  }
  return null;
}
