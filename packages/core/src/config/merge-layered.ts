import type { Config } from './schema.ts';
import { ConfigSchema } from './schema.ts';
import { getLeafFieldMeta } from './schema-leaf.ts';

export function mergeLayered(user: Config, project: Config, projectLocal?: Config): Config {
  return mergeDeep([user, project, projectLocal], []) as Config;
}

function mergeDeep(layers: readonly unknown[], path: (string | number)[]): unknown {
  if (path.length > 0) {
    const meta = getLeafFieldMeta(ConfigSchema, path);
    if (meta?.scope === 'user') return layers[0];
    if (meta?.scope === 'project') return layers[1] ?? layers[0];
    if (meta?.scope === 'project-local') return layers[2] ?? layers[1] ?? layers[0];
  }

  const top = topDefined(layers);
  if (top === undefined) return undefined;
  if (top === null) return null;
  if (Array.isArray(top)) return top;
  if (typeof top !== 'object') return top;

  const objectLayers = layers.map((layer) => (isPlainRecord(layer) ? layer : undefined));
  const allKeys = new Set<string>();
  for (const obj of objectLayers) {
    if (obj !== undefined) for (const key of Object.keys(obj)) allKeys.add(key);
  }
  const out: Record<string, unknown> = {};
  for (const key of allKeys) {
    const childLayers = objectLayers.map((obj) => (obj === undefined ? undefined : obj[key]));
    out[key] = mergeDeep(childLayers, [...path, key]);
  }
  return out;
}

function topDefined(layers: readonly unknown[]): unknown {
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i] !== undefined) return layers[i];
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
