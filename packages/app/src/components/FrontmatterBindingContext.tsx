/**
 * Cross-tree binding access for the property-panel surface.
 *
 * The top-level panel ({@link PropertyPanel}) owns the
 * {@link FrontmatterBinding}; nested object/array rows need that same binding
 * to issue path-addressed edits (`patchPath` / `deletePath` / `renamePath` /
 * `reorderPath`) without prop-drilling through every recursive widget.
 *
 * The context tolerates a `null` value so widgets stay renderable in
 * binding-less contexts (storybooks, snapshot tests, the
 * binding-not-yet-attached initial paint in {@link PropertyPanel}). Consumers
 * that need to mutate just degrade to read-only — the existing complex-value
 * preview already covers that posture.
 *
 * Scope: intentionally narrow. Anything beyond the binding handle belongs in
 * a sibling context (see {@link PropertyContext} for the cross-tree signal
 * bus), not here.
 */
import type { FrontmatterBinding } from '@inkeep/open-knowledge-core';
import { createContext, type ReactNode, use } from 'react';

const FrontmatterBindingContext = createContext<FrontmatterBinding | null>(null);

interface ProviderProps {
  binding: FrontmatterBinding | null;
  children: ReactNode;
}

export function FrontmatterBindingProvider({ binding, children }: ProviderProps) {
  return <FrontmatterBindingContext value={binding}>{children}</FrontmatterBindingContext>;
}

/**
 * Read the bound {@link FrontmatterBinding}, or `null` when no provider is
 * mounted (or the panel hasn't attached its binding yet). Consumers MUST
 * handle `null` — typically by rendering read-only chrome.
 */
export function useFrontmatterBinding(): FrontmatterBinding | null {
  return use(FrontmatterBindingContext);
}
