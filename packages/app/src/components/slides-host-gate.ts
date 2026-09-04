import '@/lib/desktop-bridge-types';

export function isSlidesHost(
  windowLike: { okDesktop?: { slides?: unknown } } | undefined = typeof window === 'undefined'
    ? undefined
    : window,
): boolean {
  return windowLike?.okDesktop?.slides != null;
}
