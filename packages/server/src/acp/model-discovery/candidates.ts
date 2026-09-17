import { groupClaudeModelFamilies } from './claude-variant.ts';
import {
  type CodexCatalogModel,
  contextChoicesFor,
  effectiveContextTokens,
  isSelectableCatalogModel,
} from './codex-context.ts';
import { type ModelCandidate, type ScopeFingerprint, sameScope } from './types.ts';

export interface AdvertisedModelOption {
  readonly value: string;
  readonly label?: string;
  readonly description?: string;
}

export function claudeCandidates(
  advertised: readonly AdvertisedModelOption[],
  fingerprint: ScopeFingerprint,
): readonly ModelCandidate[] {
  const byValue = new Map(advertised.map((option) => [option.value, option]));
  const families = groupClaudeModelFamilies(advertised.map((option) => option.value));
  return families.flatMap((family) =>
    family.variants.map((variant): ModelCandidate => {
      const option = byValue.get(variant.raw);
      return {
        value: variant.raw,
        label: option?.label ?? variant.raw,
        description: option?.description ?? null,
        group: family.baseId,
        source: 'acp-session',
        fingerprint,
        freshness: { kind: 'live' },
        selectability: 'advertised',
        context:
          variant.nominalTokens === null
            ? null
            : { effectiveTokens: variant.nominalTokens, origin: 'model-variant' },
        contextChoices: variant.nominalTokens === null ? [] : [variant.nominalTokens],
        setPhase: 'acp-post-create',
      };
    }),
  );
}

export function codexCandidates(
  catalog: readonly CodexCatalogModel[],
  fingerprint: ScopeFingerprint,
  discoveredAt: number,
): readonly ModelCandidate[] {
  return catalog.filter(isSelectableCatalogModel).map((model): ModelCandidate => {
    const choices = contextChoicesFor(model);
    const preferred = choices.at(-1) ?? null;
    return {
      value: model.slug,
      label: model.slug,
      description: null,
      group: null,
      source: 'native-cli',
      fingerprint,
      freshness: { kind: 'cached', at: discoveredAt },
      selectability: 'candidate',
      context:
        preferred === null
          ? null
          : { effectiveTokens: effectiveContextTokens(preferred, model), origin: 'native-catalog' },
      contextChoices: choices,
      setPhase: 'launch-only',
    };
  });
}

export function revalidateFreshness(
  candidates: readonly ModelCandidate[],
  current: ScopeFingerprint,
): readonly ModelCandidate[] {
  return candidates.map((candidate) => {
    if (sameScope(candidate.fingerprint, current)) return candidate;
    if (candidate.freshness.kind === 'stale' || candidate.freshness.kind === 'unknown') {
      return candidate;
    }
    const at = candidate.freshness.kind === 'cached' ? candidate.freshness.at : Date.now();
    return { ...candidate, freshness: { kind: 'stale', at }, selectability: 'candidate' };
  });
}
