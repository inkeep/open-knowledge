export interface ClaudeModelVariant {
  readonly raw: string;
  readonly baseId: string;
  readonly contextTag: string | null;
  readonly nominalTokens: number | null;
}

export interface ClaudeModelFamily {
  readonly baseId: string;
  readonly variants: readonly ClaudeModelVariant[];
}

const VARIANT_SUFFIX = /^(?<base>.+?)\[(?<tag>[^\]]+)\]$/;
const TAGGED_SIZE = /^(?<amount>\d+(?:\.\d+)?)(?<unit>[km])$/i;

const UNIT_MULTIPLIER: Readonly<Record<string, number>> = { k: 1_000, m: 1_000_000 };

export function nominalTokensForTag(tag: string): number | null {
  const parsed = TAGGED_SIZE.exec(tag.trim());
  const amount = parsed?.groups?.amount;
  const unit = parsed?.groups?.unit;
  if (amount === undefined || unit === undefined) return null;
  const multiplier = UNIT_MULTIPLIER[unit.toLowerCase()];
  if (multiplier === undefined) return null;
  return Math.round(Number(amount) * multiplier);
}

export function parseClaudeModelVariant(value: string): ClaudeModelVariant {
  const matched = VARIANT_SUFFIX.exec(value);
  const base = matched?.groups?.base;
  const tag = matched?.groups?.tag;
  if (base === undefined || tag === undefined) {
    return { raw: value, baseId: value, contextTag: null, nominalTokens: null };
  }
  return { raw: value, baseId: base, contextTag: tag, nominalTokens: nominalTokensForTag(tag) };
}

export function groupClaudeModelFamilies(values: readonly string[]): readonly ClaudeModelFamily[] {
  const families = new Map<string, ClaudeModelVariant[]>();
  for (const value of values) {
    const variant = parseClaudeModelVariant(value);
    const existing = families.get(variant.baseId);
    if (existing === undefined) families.set(variant.baseId, [variant]);
    else existing.push(variant);
  }
  return [...families].map(([baseId, variants]) => ({ baseId, variants }));
}

export function hasContextChoice(family: ClaudeModelFamily): boolean {
  return family.variants.length > 1;
}
