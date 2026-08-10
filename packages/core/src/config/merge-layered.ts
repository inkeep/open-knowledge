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
 *   - `'project-local'`→ project-local wins, falling back DIRECTLY to user
 *                        (a personal default across projects) — NEVER the
 *                        committed project layer. A project-local key is
 *                        per-machine and gitignored; a value for it in the
 *                        committed `.ok/config.yml` travels via clone/sync/
 *                        share, so inheriting it would let a repo arm consent
 *                        (`server.allowExternal`), a terminal grant, etc. on a
 *                        cloner's machine. Skipping the project layer closes
 *                        that leak structurally — it no longer depends on the
 *                        project-local file being schema-parsed so a defined
 *                        default can win (the loader now merges RAW layers and
 *                        parses once, so unset project-local leaves are
 *                        `undefined` here → the leaf's schema default fills at
 *                        the final parse).
 *   - `'either'` / no  → default deep-merge precedence (project-local >
 *                        project > user)
 *
 * Object branches deep-merge. Arrays replace wholesale (matches
 * `applyPatchToDocument` semantics + RFC 7396 §1).
 *
 * Layers are RAW (un-parsed) partials from the loader — an unset leaf is
 * absent (`undefined`), which is what makes the cross-layer fallback and the
 * project-local skip work. A single `ConfigSchema.parse` on the merged result
 * fills defaults afterward.
 */

import type { Config } from './schema.ts';
import { ConfigSchema } from './schema.ts';
import { getLeafFieldMeta } from './schema-leaf.ts';

/**
 * A config layer accepted by `mergeLayered`. Callers pass either fully-parsed
 * `Config` objects (the app's Settings/editor merge) or raw un-parsed partials
 * (the CLI loader's raw-merge-then-parse-once path — an unset leaf is absent,
 * so cross-layer fallback and the project-local skip work). `Config` is
 * assignable to this via its `[x: string]: unknown` index signature.
 */
type ConfigLayer = Config | Record<string, unknown>;

/**
 * Merge user / project / project-local layers into a single `Config`-shaped
 * object. The result is typed `Config` for callers that pass parsed layers and
 * use it directly (the app); the CLI loader passes raw partials and runs one
 * `ConfigSchema.parse` on the result to validate + fill defaults.
 *
 * `projectLocal` is optional so existing call sites that pre-date the
 * project-local layer continue to compile. When omitted, the merge
 * behaves like the prior two-layer version.
 */
export function mergeLayered(
  user: ConfigLayer,
  project: ConfigLayer,
  projectLocal?: ConfigLayer,
): Config {
  return mergeDeep([user, project, projectLocal], []) as Config;
}

function mergeDeep(layers: readonly unknown[], path: (string | number)[]): unknown {
  if (path.length > 0) {
    const meta = getLeafFieldMeta(ConfigSchema, path);
    if (meta?.scope === 'user') return layers[0];
    if (meta?.scope === 'project') return layers[1] ?? layers[0];
    // project-local: local, else user — the committed project layer (index 1)
    // is deliberately skipped so a committed value never travels to a cloner.
    // DEPENDENCY: the `?? layers[0]` fallback assumes RAW (un-parsed) layers —
    // an undefined project-local layer falls back to user. A caller that passes
    // fully-PARSED Config (schema defaults already filled, e.g. the app) makes
    // layers[2] always defined, so it always wins and never falls back to user.
    // Safe today only because the sole parsed caller doesn't rely on a
    // project-local leaf resolving to a non-default user value (and the
    // security-critical one, allowExternal, defaults false and is never trusted
    // from config-derived consent). A future project-local leaf with a
    // meaningful user fallback would need raw layers or an explicit guard.
    if (meta?.scope === 'project-local') return layers[2] ?? layers[0];
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
