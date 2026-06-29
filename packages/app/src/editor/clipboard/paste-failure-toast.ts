
import { toast } from 'sonner';

const THROTTLE_MS = 3000;

const lastShownAt: Map<string, number> = new Map();

export function notifyPasteDegraded(
  scope: string,
  message = 'Pasted as plain text — some formatting could not be converted.',
): boolean {
  const now = Date.now();
  const last = lastShownAt.get(scope) ?? 0;
  if (now - last < THROTTLE_MS) return false;
  lastShownAt.set(scope, now);
  toast.error(message);
  return true;
}

export function resetPasteFailureThrottle(): void {
  lastShownAt.clear();
}
