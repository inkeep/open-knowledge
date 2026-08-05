// Side-effect import only — loads the `Window.okDesktop?` global augmentation.
import '@/lib/desktop-bridge-types';

/**
 * True only where the desktop bridge exposes the `slides` namespace.
 *
 * Gating on the namespace rather than merely `okDesktop != null` matters: an
 * older desktop build whose preload predates the slides handler still has a
 * bridge, but no `slides`. Reading such a build as "not a slides host" keeps the
 * affordance absent instead of surfacing a button whose IPC call would reject.
 * Web / CLI hosts have no bridge at all and read false the same way.
 *
 * `windowLike` is injected so the predicate is unit-testable without a real
 * `window`; the default resolves the ambient global (undefined on SSR).
 */
export function isSlidesHost(
  windowLike: { okDesktop?: { slides?: unknown } } | undefined = typeof window === 'undefined'
    ? undefined
    : window,
): boolean {
  return windowLike?.okDesktop?.slides != null;
}
