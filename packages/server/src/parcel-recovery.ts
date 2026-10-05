import type { Event } from '@parcel/watcher';

const RESCAN_NOTICES = new Set([
  'Events were dropped by the FSEvents client. File system must be re-scanned.',
  'Too many events. File system must be re-scanned.',
  'Events were dropped by the kernel. File system must be re-scanned.',
]);

export type ParcelNotification =
  | { kind: 'batch'; events: Event[] }
  | { kind: 'rescan'; events: Event[]; error: Error }
  | { kind: 'error'; error: Error };

export function classifyParcelNotification(err: Error | null, events: Event[]): ParcelNotification {
  if (err === null) return { kind: 'batch', events };
  if (RESCAN_NOTICES.has(err.message)) return { kind: 'rescan', events, error: err };
  return { kind: 'error', error: err };
}
