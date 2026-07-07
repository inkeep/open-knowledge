/**
 * Layered config merge: combine user / project / project-local layers into
 * the single `Config` consumed by the editor + Settings pane.
 *
 * Default precedence (highest wins): project-local > project > user. Each
 * leaf's registered `scope` short-circuits the merge — a stale value in a
 * layer that does not own the field never reaches the merged view.
 *
 * Scope rules (applied at every leaf):
 *   - `'user'`         → user wins (project + project-local ignored)
 *   - `'project'`      → project wins, falling back to user if project is
 *                        undefined (project-local ignored unless the field
 *                        is also a `'project-local'` leaf — which can't
 *                        happen, scopes are exclusive)
 *   - `'project-local'`→ project-local wins, falling back to project then
 *                        user when undefined
 *   - `'either'` / no  → default deep-merge precedence (project-local >
 *                        project > user)
 *
 * Object branches deep-merge. Arrays replace wholesale (matches
 * `applyPatchToDocument` semantics + RFC 7396 §1).
 */

import type { Config } from './schema.ts';
import { ConfigSchema } from './schema.ts';
import { getLeafFieldMeta } from './schema-leaf.ts';

/**
 * Merge user / project / project-local layers into a single Config.
 *
 * `projectLocal` is optional so existing call sites that pre-date the
 * project-local layer continue to compile. When omitted, the merge
 * behaves like the prior two-layer version.
 */
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

  // Default precedence: highest non-undefined layer wins for non-objects;
  // object layers deep-merge with project-local highest.
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
