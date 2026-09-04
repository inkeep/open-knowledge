import { type ComponentType, type LazyExoticComponent, lazy } from 'react';

// biome-ignore lint/suspicious/noExplicitAny: matches React.lazy's own factory signature; the generic preserves caller-side prop inference on the returned LazyExoticComponent
export function lazyWithPreload<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> & { preload(): Promise<{ default: T }> } {
  let promise: Promise<{ default: T }> | null = null;
  const load = (): Promise<{ default: T }> => {
    if (promise === null) {
      promise = factory();
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
