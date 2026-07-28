import type { ApiExtensionOptions } from './api-extension.ts';
import { createApiExtension as createApiExtensionBase } from './api-extension.ts';
import { DocumentDurabilityState } from './document-durability-state.ts';

export * from './api-extension.ts';

export function createApiExtension(
  options: Omit<ApiExtensionOptions, 'durabilityState'>,
): ReturnType<typeof createApiExtensionBase> {
  return createApiExtensionBase({
    ...options,
    durabilityState: new DocumentDurabilityState(),
  });
}
