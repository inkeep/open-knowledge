import type { ThemeSourceRecord } from '../../src/main/theme-handler.ts';

export const APPLIED_RECORD = {
  event: 'theme-source-set',
  source: 'dark',
  prevSource: 'light',
  trigger: 'ipc',
  senderWindowId: 7,
} as const satisfies ThemeSourceRecord;

export const REJECTED_RECORD_WITH_UNSERIALIZABLE_PAYLOAD = {
  event: 'theme-source-set-rejected',
  received: 10n,
  reason: 'invalid-source',
  senderWindowId: 4,
} as const satisfies ThemeSourceRecord;
