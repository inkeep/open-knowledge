import { LINEAGE_EPOCH_KEY } from '@inkeep/open-knowledge-core';
import { z } from 'zod';

export const HocuspocusAuthTokenSchema = z
  .object({
    principalId: z.string().optional(),
    tabSessionId: z.string().optional(),
    expectedServerInstanceId: z.string().optional(),
    expectedBranch: z.string().optional(),
    expectedDocLineageEpoch: z.string().optional(),
    clientProtocolVersion: z.number().optional(),
    clientRuntimeVersion: z.string().optional(),
    clientKind: z.string().optional(),
  })
  .loose();

export type HocuspocusAuthToken = z.infer<typeof HocuspocusAuthTokenSchema>;

export { LINEAGE_EPOCH_KEY };

export const HOCUSPOCUS_AUTH_REJECTION_REASONS = [
  'server-instance-mismatch',
  'branch-mismatch',
  'rename-redirect',
  'doc-deleted',
  'doc-lineage-mismatch',
] as const;
export type HocuspocusAuthRejectionReason = (typeof HOCUSPOCUS_AUTH_REJECTION_REASONS)[number];

export function isHocuspocusAuthRejectionReason(
  reason: string,
): reason is HocuspocusAuthRejectionReason {
  return (HOCUSPOCUS_AUTH_REJECTION_REASONS as readonly string[]).includes(reason);
}

const WIRE_PAYLOAD_SEPARATOR = ':';

export function formatAuthRejectionWire(
  kind: HocuspocusAuthRejectionReason,
  payload?: string,
): string {
  if (typeof payload !== 'string' || payload.length === 0) return kind;
  return `${kind}${WIRE_PAYLOAD_SEPARATOR}${payload}`;
}

export function parseAuthRejectionWire(wire: string): {
  kind: HocuspocusAuthRejectionReason | null;
  payload: string | undefined;
} {
  if (wire.length === 0) return { kind: null, payload: undefined };
  const colonIdx = wire.indexOf(WIRE_PAYLOAD_SEPARATOR);
  const candidateKind = colonIdx === -1 ? wire : wire.slice(0, colonIdx);
  if (!isHocuspocusAuthRejectionReason(candidateKind)) {
    return { kind: null, payload: undefined };
  }
  if (colonIdx === -1) {
    return { kind: candidateKind, payload: undefined };
  }
  const rawPayload = wire.slice(colonIdx + 1);
  return {
    kind: candidateKind,
    payload: rawPayload.length > 0 ? rawPayload : undefined,
  };
}

export class HocuspocusAuthRejection extends Error {
  readonly kind: HocuspocusAuthRejectionReason;
  readonly payload: string | undefined;
  readonly reason: string;

  constructor(kind: HocuspocusAuthRejectionReason, message: string, payload?: string) {
    super(message);
    this.name = 'HocuspocusAuthRejection';
    this.kind = kind;
    this.payload = typeof payload === 'string' && payload.length > 0 ? payload : undefined;
    this.reason = formatAuthRejectionWire(kind, this.payload);
  }
}

export function parseHocuspocusAuthToken(
  tokenStr: string | undefined | null,
): HocuspocusAuthToken | undefined {
  if (typeof tokenStr !== 'string' || tokenStr.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(tokenStr);
  } catch {
    return undefined;
  }
  const result = HocuspocusAuthTokenSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}
