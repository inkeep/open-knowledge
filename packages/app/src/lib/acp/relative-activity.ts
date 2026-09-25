import { t } from '@lingui/core/macro';

export function formatRelativeActivity(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return t`just now`;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return t`${minutes}m ago`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) return t`${hours}h ago`;
  const days = Math.round(diff / 86_400_000);
  return t`${days}d ago`;
}
