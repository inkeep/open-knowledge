import type { PropDef } from './types.ts';

export type JsxAttributeValueSource = string | null | undefined | { readonly value: string };

export function jsxAttributeValue(
  value: JsxAttributeValueSource,
  propDef?: Pick<PropDef, 'type'>,
): unknown {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') {
    if (propDef?.type === 'number') {
      const num = Number(value);
      return Number.isNaN(num) ? value : num;
    }
    if (propDef?.type === 'boolean') return value === 'true';
    return value;
  }
  try {
    return JSON.parse(value.value);
  } catch {
    return value.value;
  }
}
