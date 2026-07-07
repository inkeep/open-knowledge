/**
 * Client-side parsers for CC1 (push-over-awareness) stateless payloads
 * received from the `__system__` Hocuspocus document.
 *
 * Schemas live in `packages/core/src/schemas/cc1.ts` — browser-safe,
 * shared with server's `cc1-broadcast.ts` which validates on every
 * emit via `.parse()`. Single source of truth across the process
 * boundary; drift between emit and parse is structurally impossible.
 *
 * Each schema pins `ch` to a specific literal (or derived-view enum),
 * so the parsers are mutually exclusive; `SystemDocSubscriber` tries
 * them in order and short-circuits on the first match.
 *
 * `null` on parse failure, never throws — the stateless listener sees
 * a steady stream of payloads and must skip ones it doesn't recognize
 * without surfacing exceptions to React.
 */

import {
  CC1_CHANNEL_BRANCH_SWITCHED,
  CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR,
  CC1_CHANNEL_CONFIG_VALIDATION_REJECTED,
  CC1_CHANNEL_DISK_ACK,
  CC1_CONTRACT_VERSION,
  type CC1BranchSwitchedPayload,
  CC1BranchSwitchedPayloadSchema,
  type CC1ConfigIgnoreNestedErrorPayload,
  CC1ConfigIgnoreNestedErrorPayloadSchema,
  type CC1ConfigValidationRejectedPayload,
  CC1ConfigValidationRejectedPayloadSchema,
  type CC1DerivedViewPayload,
  CC1DerivedViewPayloadSchema,
  CC1DiskAckPayloadSchema,
  type CC1ServerInfoPayload,
  CC1ServerInfoPayloadSchema,
  type DerivedViewChannel,
  SYSTEM_DOC_NAME,
} from '@inkeep/open-knowledge-core';
import type { z } from 'zod';

export {
  CC1_CHANNEL_BRANCH_SWITCHED,
  CC1_CHANNEL_CONFIG_IGNORE_NESTED_ERROR,
  CC1_CHANNEL_CONFIG_VALIDATION_REJECTED,
  CC1_CHANNEL_DISK_ACK,
  CC1_CONTRACT_VERSION,
  type DerivedViewChannel,
  SYSTEM_DOC_NAME,
};

/**
 * Client-side projection of a `disk-ack` frame. The wire format carries
 * the state vector as a base64 string (so JSON serialization is safe);
 * the parser decodes it into a `Uint8Array` so consumers
 * (`pool.observeDiskAck`, `Y.encodeStateAsUpdate`) get the raw bytes
 * directly. Input/output types diverge deliberately — the decode happens
 * once at the trust boundary, downstream code never re-decodes.
 */
interface CC1DiskAckParsed {
  readonly docName: string;
  readonly sv: Uint8Array;
}

export function parseCC1DerivedView(payload: string): CC1DerivedViewPayload | null {
  return safeParseJson(payload, CC1DerivedViewPayloadSchema);
}

function parseCC1ServerInfo(payload: string): CC1ServerInfoPayload | null {
  return safeParseJson(payload, CC1ServerInfoPayloadSchema);
}

export function parseCC1BranchSwitched(payload: string): CC1BranchSwitchedPayload | null {
  return safeParseJson(payload, CC1BranchSwitchedPayloadSchema);
}

export function parseCC1ConfigValidationRejected(
  payload: string,
): CC1ConfigValidationRejectedPayload | null {
  return safeParseJson(payload, CC1ConfigValidationRejectedPayloadSchema);
}

export function parseCC1ConfigIgnoreNestedError(
  payload: string,
): CC1ConfigIgnoreNestedErrorPayload | null {
  return safeParseJson(payload, CC1ConfigIgnoreNestedErrorPayloadSchema);
}

/**
 * Parse a CC1 `disk-ack` payload AND decode its base64 state-vector in
 * one pass. Returns `null` on either schema-mismatch or invalid base64
 * — the contract is "never throws" per the module docstring, so the
 * dispatcher in `SystemDocSubscriber` can call this without `try`/
 * `catch` (a misbehaving emitter or a downgraded WS frame can't escape
 * as an unhandled rejection inside React).
 */
export function parseCC1DiskAck(payload: string): CC1DiskAckParsed | null {
  const validated = safeParseJson(payload, CC1DiskAckPayloadSchema);
  if (!validated) return null;
  try {
    return { docName: validated.docName, sv: decodeStateVector(validated.sv) };
  } catch {
    return null;
  }
}

/**
 * Decode a base64-encoded state vector to `Uint8Array`. `atob` throws
 * `DOMException("invalid characters")` on malformed base64 — this
 * helper preserves that behavior. Module-internal: `parseCC1DiskAck`
 * is the only sanctioned caller and wraps the throw in a try/catch
 * to honor the parser's "never throws" contract.
 */
function decodeStateVector(svBase64: string): Uint8Array {
  const binary = atob(svBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Per-channel handler set for the CC1 stateless multiplex. All
 * handlers are optional — consumers wire only the channels they
 * care about. `onUnknown` fires when no parser matches (dropped
 * frame, observability hook).
 */
interface CC1StatelessHandlers {
  onServerInfo?: (payload: CC1ServerInfoPayload) => void;
  onBranchSwitched?: (payload: CC1BranchSwitchedPayload) => void;
  onDiskAck?: (parsed: CC1DiskAckParsed) => void;
  onDerivedView?: (payload: CC1DerivedViewPayload) => void;
  onConfigValidationRejected?: (payload: CC1ConfigValidationRejectedPayload) => void;
  onConfigIgnoreNestedError?: (payload: CC1ConfigIgnoreNestedErrorPayload) => void;
  onUnknown?: (rawPayload: string) => void;
}

/**
 * Parse a CC1 stateless payload and dispatch to the matching handler.
 * Single source of truth for the parser-cascade ordering — both
 * `SystemDocSubscriber` (production) and `attachSystemDocSubscriber`
 * (integration harness) call through here, so adding a new CC1 channel
 * is a one-place edit instead of two parallel updates that could
 * silently drift.
 *
 * Schemas pin `ch` to a specific literal so the parsers are mutually
 * exclusive; the cascade short-circuits on the first match. Order
 * matches the `__system__` traffic profile (most frequent first), but
 * functionally any order yields the same dispatch because the parsers
 * are mutually exclusive on `ch`.
 */
export function dispatchCC1Stateless(payload: string, handlers: CC1StatelessHandlers): void {
  const serverInfo = parseCC1ServerInfo(payload);
  if (serverInfo) {
    handlers.onServerInfo?.(serverInfo);
    return;
  }
  const branchSwitched = parseCC1BranchSwitched(payload);
  if (branchSwitched) {
    handlers.onBranchSwitched?.(branchSwitched);
    return;
  }
  const diskAck = parseCC1DiskAck(payload);
  if (diskAck) {
    handlers.onDiskAck?.(diskAck);
    return;
  }
  const derivedView = parseCC1DerivedView(payload);
  if (derivedView) {
    handlers.onDerivedView?.(derivedView);
    return;
  }
  const configRejected = parseCC1ConfigValidationRejected(payload);
  if (configRejected) {
    handlers.onConfigValidationRejected?.(configRejected);
    return;
  }
  const configIgnoreNestedError = parseCC1ConfigIgnoreNestedError(payload);
  if (configIgnoreNestedError) {
    handlers.onConfigIgnoreNestedError?.(configIgnoreNestedError);
    return;
  }
  handlers.onUnknown?.(payload);
}

/**
 * Shared safe-parse for stateless CC1 payloads. JSON parse error or Zod
 * schema mismatch yields `null` so the stateless listener can skip the
 * frame without surfacing an exception. Uses `safeParse` (never throws)
 * because the dispatch path must never propagate a wire-format error
 * up into Hocuspocus's event emitter.
 */
function safeParseJson<T extends z.ZodType>(payload: string, schema: T): z.infer<T> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function defaultCollabWsUrl(): string {
  if (typeof location === 'undefined') {
    return 'ws://localhost/collab';
  }
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/collab`;
}
