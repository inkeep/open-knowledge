
import {
  addSchemaIncompatibilityNotice,
  attachUpdateSubscribers,
  type UpdateNotice,
} from '@/components/UpdateNotices.shared';

let notices: UpdateNotice[] = [];
const listeners = new Set<() => void>();
let attached = false;

function notify(): void {
  for (const l of listeners) l();
}

function addNotice(notice: UpdateNotice): void {
  const idx = notices.findIndex((n) => n.id === notice.id);
  if (idx === -1) {
    notices = [...notices, notice];
  } else {
    const next = notices.slice();
    next[idx] = notice;
    notices = next;
  }
  notify();
}

export function dismissNotice(id: string): void {
  const next = notices.filter((n) => n.id !== id);
  if (next.length === notices.length) return;
  notices = next;
  notify();
}

export function getNoticesSnapshot(): UpdateNotice[] {
  return notices;
}

export function subscribeToNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function installUpdateNoticesBridge(): void {
  if (attached) return;
  if (typeof window === 'undefined') return;
  const bridge = window.okDesktop;
  if (!bridge) return;
  attached = true;
  attachUpdateSubscribers(bridge, addNotice, dismissNotice);
  bridge.state.query().then(
    (snapshot) => {
      if (snapshot.schemaIncompatibility) {
        addSchemaIncompatibilityNotice(
          bridge,
          snapshot.schemaIncompatibility,
          addNotice,
          dismissNotice,
        );
      }
    },
    (err: unknown) => {
      console.warn('[update-notices-store] bridge.state.query() failed', err);
    },
  );
}
