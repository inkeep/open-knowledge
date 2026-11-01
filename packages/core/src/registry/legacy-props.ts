import type { PropDef } from './types.ts';

export function propDescription(
  prop: Pick<PropDef, 'name' | 'description' | 'legacyNames'>,
): string | undefined {
  const legacyNames = prop.legacyNames ?? [];
  if (legacyNames.length === 0) return prop.description;
  const spellings = legacyNames.map((legacyName) => `\`${legacyName}\``).join(' or ');
  const note = `Also read as ${spellings}; write \`${prop.name}\` instead.`;
  return prop.description === undefined ? note : `${prop.description} ${note}`;
}

export function resolveLegacyProps(
  props: readonly PropDef[],
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...values };
  for (const prop of props) {
    for (const legacyName of prop.legacyNames ?? []) {
      if (resolved[prop.name] === undefined && resolved[legacyName] !== undefined) {
        resolved[prop.name] = resolved[legacyName];
      }
      delete resolved[legacyName];
    }
  }
  return resolved;
}
