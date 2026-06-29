import type { ProblemType } from '../schemas/api/_envelope.ts';
import { ProblemTypeSchema } from '../schemas/api/_envelope.ts';

type RegistryDataShape = Readonly<Record<string, Readonly<Record<string, string>>>>;

const RAW_REGISTRY = {
  'ok:shell:spawn-cursor': {
    'urn:ok:error:cursor-not-installed': 'not-installed',
    'urn:ok:error:cursor-spawn-timeout': 'timeout',
    'urn:ok:error:cursor-spawn-failed': 'spawn-error',
    'urn:ok:error:invalid-request': 'invalid-path',
    'urn:ok:error:path-escape': 'invalid-path',
  },
} as const satisfies RegistryDataShape;

type RawRegistry = typeof RAW_REGISTRY;

export type IpcChannelWithUrn = keyof RawRegistry;

export type IpcChannelReason<C extends IpcChannelWithUrn> = RawRegistry[C][keyof RawRegistry[C]];

type Registry = {
  readonly [C in IpcChannelWithUrn]: Readonly<Partial<Record<ProblemType, IpcChannelReason<C>>>>;
};

export const URN_IPC_REGISTRY: Registry = RAW_REGISTRY;

export const URN_HTTP_ONLY: ReadonlySet<ProblemType> = new Set<ProblemType>([
  'urn:ok:error:malformed-upload',
  'urn:ok:error:collision-exhaustion',
  'urn:ok:error:storage-full',
  'urn:ok:error:storage-readonly',
  'urn:ok:error:storage-error',
  'urn:ok:error:no-file-received',
  'urn:ok:error:method-not-allowed',
  'urn:ok:error:payload-too-large',
  'urn:ok:error:request-timeout',
  'urn:ok:error:internal-server-error',
  'urn:ok:error:loopback-required',
  'urn:ok:error:invalid-origin',
  'urn:ok:error:url-not-allowed',
  'urn:ok:error:dir-outside-home',
  'urn:ok:error:concurrent-operation',
  'urn:ok:error:clone-failed',
  'urn:ok:error:clone-timeout',
  'urn:ok:error:server-start-failed',
  'urn:ok:error:reserved-doc-name',
  'urn:ok:error:target-not-found',
  'urn:ok:error:stale-target',
  'urn:ok:error:frontmatter-edit-not-supported',
  'urn:ok:error:invalid-frontmatter-patch',
  'urn:ok:error:frontmatter-malformed',
  'urn:ok:error:no-active-session',
  'urn:ok:error:too-many-agent-sessions',
  'urn:ok:error:disk-divergence',
  'urn:ok:error:doc-in-conflict',
  'urn:ok:error:no-conflict-tracked',
  'urn:ok:error:doc-not-found',
  'urn:ok:error:doc-already-exists',
  'urn:ok:error:doc-not-open',
  'urn:ok:error:rollback-not-configured',
  'urn:ok:error:doc-not-available',
  'urn:ok:error:backlink-index-not-configured',
  'urn:ok:error:file-rescan-not-configured',
  'urn:ok:error:shadow-not-configured',
  'urn:ok:error:host-not-allowed',
  'urn:ok:error:principal-not-available',
  'urn:ok:error:not-found',
  'urn:ok:error:auth-failed',
  'urn:ok:error:no-project-dir',
  'urn:ok:error:server-open-failed',
  'urn:ok:error:sync-not-active',
  'urn:ok:error:project-repo-not-configured',
  'urn:ok:error:seed-prerequisite-missing',
  'urn:ok:error:seed-invalid-root',
  'urn:ok:error:tag-index-not-configured',
  'urn:ok:error:template-not-found',
  'urn:ok:error:unsupported-asset-type',
  'urn:ok:error:asset-not-found',
  'urn:ok:error:single-file-mode',
  'urn:ok:error:collab-server-not-running',
  'urn:ok:error:gateway-timeout',
  'urn:ok:error:handoff-target-not-installed',
  'urn:ok:error:handoff-spawn-timeout',
  'urn:ok:error:handoff-spawn-failed',
]);

export type UrnIpcLookup<C extends IpcChannelWithUrn> =
  | { kind: 'mapped'; channel: C; reason: IpcChannelReason<C> }
  | { kind: 'http-only' }
  | { kind: 'unknown'; problemType: string };

export function lookupUrnInRegistry<C extends IpcChannelWithUrn>(
  problemType: string,
  channel: C,
): UrnIpcLookup<C> {
  const parsed = ProblemTypeSchema.safeParse(problemType);
  if (!parsed.success) {
    return { kind: 'unknown', problemType };
  }
  const known: ProblemType = parsed.data;
  const channelMap = URN_IPC_REGISTRY[channel];
  const reason = channelMap[known];
  if (reason !== undefined) {
    return { kind: 'mapped', channel, reason };
  }
  if (URN_HTTP_ONLY.has(known)) {
    return { kind: 'http-only' };
  }
  return { kind: 'unknown', problemType };
}

export function assertNeverUrnIpcLookup(value: never): never {
  throw new Error(`Unhandled UrnIpcLookup: ${JSON.stringify(value)}`);
}
