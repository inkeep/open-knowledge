/**
 * `lazyWithPreload` — thin wrapper over `React.lazy()` that adds a
 * `.preload()` method so a chunk can be warmed on user intent (hover,
 * focus, route announcement) BEFORE the lazy element first renders.
 *
 * Why this matters
 *   Plain `lazy(factory)` calls `factory()` only when React first
 *   renders the lazy element. For a modal trigger like the header
 *   Settings button, that means the body chunk fetch starts at the
 *   moment the user clicks — so the dialog frame paints quickly (the
 *   shell ships in the main bundle) but the body skeleton flashes
 *   while the network round-trip completes. Warming the chunk on
 *   hover/focus moves the fetch into the "intent" window so the open
 *   click finds the chunk already loaded — flash-free.
 *
 * Idempotency contract
 *   `.preload()` triggers the dynamic import EXACTLY once across the
 *   module's lifetime. Repeated `.preload()` calls (debounce slippage,
 *   second hover) return the same memoized promise — no duplicate
 *   network fetch, no torn state. React.lazy's own subscription path
 *   shares the same `load` closure as `.preload()`, so the factory
 *   runs at most once regardless of which path triggers first.
 *
 * Rejection handling
 *   The synchronous `.preload()` call never throws. If the chunk
 *   fetch itself rejects (offline, network drop), the returned
 *   promise is rejected — but a no-op `.catch` is attached so a
 *   preload-before-render rejection does not surface as an unhandled
 *   promise rejection. React.lazy attaches its own subscription on
 *   first render and routes the rejection through the nearest
 *   ErrorBoundary; that channel is unaffected because the original
 *   promise's rejection state is observable to ALL consumers (the
 *   no-op catch creates a chained-resolved promise that is
 *   intentionally dropped).
 */

import { type ComponentType, type LazyExoticComponent, lazy } from 'react';

// biome-ignore lint/suspicious/noExplicitAny: matches React.lazy's own factory signature; the generic preserves caller-side prop inference on the returned LazyExoticComponent
export function lazyWithPreload<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> & { preload(): Promise<{ default: T }> } {
  let promise: Promise<{ default: T }> | null = null;
  const load = (): Promise<{ default: T }> => {
    if (promise === null) {
      promise = factory();
      // Silence unhandled-rejection noise when preload() fires before
      // React.lazy subscribes via render. The original promise's
      // rejection state is preserved for React.lazy's own subscription.
      promise.catch(() => {});
    }
    return promise;
  };
  const Component = lazy(load) as LazyExoticComponent<T> & {
    preload(): Promise<{ default: T }>;
  };
  Component.preload = load;
  return Component;
}
