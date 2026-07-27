/**
 * Shared derivation of the non-portable-render descriptor set, used by the
 * registry-derived completeness guards at BOTH clipboard dispatch sites
 * (`sourceFallbackFormFor` in non-portable-render-source-fallback.test.ts and
 * `PALETTE_DESCRIPTOR_NAMES` in clipboard-walker-fallback-palette.test.ts).
 * The two guards express one logical contract — every descriptor whose RENDER
 * identity is a non-portable canonical must have coverage at both sites — so
 * the canonical set and the filter predicate live here once, not as driftable
 * per-file copies.
 */

import { builtInComponents } from '@inkeep/open-knowledge-core';

/**
 * Canonicals whose live React render is KaTeX / mermaid SVG — the renders the
 * clipboard source fallback canonicalizes because they paste as garbage
 * cross-app. Extend this set when a new non-portable canonical is added to
 * the switch in `sourceFallbackFormFor` — the registry-derived guards depend
 * on this set being complete.
 */
const NON_PORTABLE_CANONICALS: ReadonlySet<string> = new Set(['Math', 'MermaidFence']);

/**
 * Every registry descriptor name whose render identity is a non-portable
 * canonical: the canonicals themselves plus every compat descriptor whose
 * `rendersAs` points at one (e.g. `DollarMath` / `MathFence` render as
 * `<Math>`).
 */
export function nonPortableDescriptorNames(): string[] {
  return builtInComponents
    .filter((meta) => {
      const rendersAs = 'rendersAs' in meta ? meta.rendersAs : undefined;
      return (
        NON_PORTABLE_CANONICALS.has(meta.name) ||
        (typeof rendersAs === 'string' && NON_PORTABLE_CANONICALS.has(rendersAs))
      );
    })
    .map((meta) => meta.name);
}
