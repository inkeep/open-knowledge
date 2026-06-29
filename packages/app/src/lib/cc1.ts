
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

export function parseCC1DiskAck(payload: string): CC1DiskAckParsed | null {
  const validated = safeParseJson(payload, CC1DiskAckPayloadSchema);
  if (!validated) return null;
  try {
    return { docName: validated.docName, sv: decodeStateVector(validated.sv) };
  } catch {
    return null;
  }
}

function decodeStateVector(svBase64: string): Uint8Array {
  const binary = atob(svBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

interface CC1StatelessHandlers {
  onServerInfo?: (payload: CC1ServerInfoPayload) => void;
  onBranchSwitched?: (payload: CC1BranchSwitchedPayload) => void;
  onDiskAck?: (parsed: CC1DiskAckParsed) => void;
  onDerivedView?: (payload: CC1DerivedViewPayload) => void;
  onConfigValidationRejected?: (payload: CC1ConfigValidationRejectedPayload) => void;
  onConfigIgnoreNestedError?: (payload: CC1ConfigIgnoreNestedErrorPayload) => void;
  onUnknown?: (rawPayload: string) => void;
}

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
