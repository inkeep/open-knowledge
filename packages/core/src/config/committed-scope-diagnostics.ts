/**
 * Detect project-local settings that were committed to the shared project
 * layer (`.ok/config.yml`), where they are silently ignored.
 *
 * `mergeLayered` skips the committed project layer for every project-local leaf
 * (consent, per-machine listener + workflow knobs), so a value written there
 * never reaches the running server — it resolves to the schema default or the
 * user layer instead. That skip is a security + clone-safety feature (a
 * committed `server.allowExternal` or `server.bind` can't arm exposure or break
 * a teammate's local run), but it is also silent: the author believes the
 * committed value took effect. This detector turns that silent no-op into a
 * loud, source-located diagnostic so the value gets moved to where it works.
 *
 * The classic offender is `server.bind`: committing a non-loopback bind so one
 * machine can serve remotely would otherwise refuse to boot for every teammate
 * who clones the repo and runs it locally (the exposure interlock needs
 * per-machine `allowExternal` consent that is never committed). Now a committed
 * bind is inert AND named at start, with the OK_BIND / `.ok/local` fix.
 *
 * Pure introspection — no I/O. Keys off the field registry's `scope` metadata,
 * exactly as `mergeLayered` does, so the two can never disagree about which
 * leaves are project-local.
 */

import type { Document } from 'yaml';
import { mechanicalEnvName, RECOGNIZED_ENV_VARS } from './env-layer.ts';
import type { ConfigIssueSource } from './errors.ts';
import { ConfigSchema } from './schema.ts';
import { getLeafFieldMeta } from './schema-leaf.ts';
import { locateIssue } from './source-locator.ts';

/** A project-local leaf found in the committed project layer, where it is ignored. */
export interface IgnoredCommittedKey {
  /** Dotted-path segments of the ignored leaf, e.g. `['server', 'bind']`. */
  path: string[];
  /**
   * The `OK_*` environment variable that sets this leaf per-machine, when one
   * is ratified (e.g. `OK_BIND`). Absent for project-local leaves with no env
   * surface — those move to `.ok/local/config.yml` only.
   */
  envVar?: string;
  /** Source location in the committed file, when `file`/`source`/`doc` are supplied. */
  source?: ConfigIssueSource;
}

export interface DetectCommittedProjectLocalKeysInput {
  /** Raw committed project-layer value (pre-merge, pre-schema — the YAML projection). */
  value: unknown;
  /** Absolute file path, for source-located findings. Omit for value-only mode. */
  file?: string | null;
  /** Raw file source, for source-located findings. */
  source?: string | null;
  /** yaml@2 Document AST, for source-located findings. */
  doc?: Document | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walk a raw committed project config and return one finding per project-local
 * leaf present in it. A registered leaf stops the descent (even an object /
 * array leaf like `server.bind`); an unregistered container recurses; an
 * unregistered scalar (a loose key the schema does not know) is skipped. Each
 * finding is source-located when `file`, `source`, and `doc` are supplied.
 */
export function detectCommittedProjectLocalKeys(
  input: DetectCommittedProjectLocalKeysInput,
): IgnoredCommittedKey[] {
  const { value, file, source, doc } = input;
  const findings: IgnoredCommittedKey[] = [];

  const walk = (node: unknown, path: string[]): void => {
    if (path.length > 0) {
      const meta = getLeafFieldMeta(ConfigSchema, path);
      if (meta !== undefined) {
        // A registered leaf: this is the scope-bearing node, so stop here.
        if (meta.scope === 'project-local') {
          const envVar = mechanicalEnvName(path);
          let located: ConfigIssueSource | undefined;
          if (doc != null && source != null && file != null) {
            located = locateIssue({ file, source, doc, path });
          }
          findings.push({
            path: [...path],
            ...(RECOGNIZED_ENV_VARS.has(envVar) ? { envVar } : {}),
            ...(located !== undefined ? { source: located } : {}),
          });
        }
        return;
      }
    }
    // Not a registered leaf: recurse into containers, ignore loose scalars.
    if (isPlainObject(node)) {
      for (const [key, child] of Object.entries(node)) walk(child, [...path, key]);
    }
  };

  walk(value, []);
  return findings;
}

/**
 * Render a start-time warning for a project-local key found in committed
 * config. Prefixes the `file:line:column` of the offending value when it was
 * source-located (the IDE/CLI convention, matching `humanFormat(REMOVED_KEY)`),
 * then names the key, states it is ignored, and points at the per-machine fix
 * (`.ok/local/config.yml`, plus the `OK_*` env var when one exists).
 */
export function formatIgnoredCommittedKey(key: IgnoredCommittedKey): string {
  const dotted = key.path.join('.');
  const location =
    key.source !== undefined ? `${key.source.file}:${key.source.line}:${key.source.column}: ` : '';
  const envHint = key.envVar !== undefined ? `, or set ${key.envVar} on this host` : '';
  return `${location}${dotted} is a per-machine (project-local) setting; the value committed in .ok/config.yml is ignored. Set it in .ok/local/config.yml (this machine only)${envHint}.`;
}
