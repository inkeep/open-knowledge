/**
 * Effective lint-config resolution. OK config persists only the plugin
 * toggles; markdownlint `rules` come from the project's native
 * `.markdownlint.*` files, resolved per document with markdownlint-cli2
 * cascade semantics (nearest file on the doc→root walk governs wholesale,
 * `extends` flattened). When a native file governs, it is honored exactly as
 * cli2 would — no OK underlay; OK's tuned defaults (the base rules) apply
 * only when no file governs the doc. Resolution problems (malformed file,
 * bad `extends`) are surfaced through `onProblem`, never swallowed.
 */

import { dirname, join } from 'node:path';
import type { LinterConfig, MarkdownlintRuleSetting } from '@inkeep/open-knowledge-core';
import { resolveFrontmatterSchemas } from './frontmatter-schemas.ts';
import {
  type DiscoveredMarkdownlintConfig,
  resolveNativeMarkdownlintConfig,
} from './markdownlint-discovery.ts';

export interface ResolveLinterConfigOptions {
  /**
   * The document the config is being resolved FOR, as a content-relative
   * path (`folder/doc.md` — only its directory matters, so an extension-less
   * docName works too). Omitted → root-level resolution.
   */
  docName?: string;
  /**
   * The project root (the folder containing `.ok/`) — frontmatter schema
   * `file` paths resolve against it, NOT `contentDir`, so mappings keep
   * working when `content.dir` scopes docs to a subfolder. Omitted →
   * `contentDir` (the two coincide unless `content.dir` is set).
   */
  projectDir?: string;
  /** Receives each resolution problem, tagged with the governing file. */
  onProblem?: (problem: string) => void;
}

/**
 * The cascade resolution behind `resolveEffectiveLinterConfig`, exposed for
 * callers that need the governing file + problems themselves (lint-config API).
 */
export function resolveNativeConfigForDoc(
  contentDir: string,
  docName: string | undefined,
  onProblem?: (problem: string) => void,
): DiscoveredMarkdownlintConfig | null {
  const docDir = docName ? join(contentDir, dirname(docName)) : contentDir;
  const native = resolveNativeMarkdownlintConfig(docDir, contentDir);
  if (native && onProblem) for (const p of native.problems) onProblem(`[${native.file}] ${p}`);
  return native;
}

/**
 * Compose the effective config from a base + a (possibly absent) discovered
 * native config. A governing file wins wholesale; an unusable governing file
 * (rules null) or no file at all keeps the base rules (OK's tuned defaults).
 */
export function composeEffectiveLinterConfig(
  base: LinterConfig,
  native: DiscoveredMarkdownlintConfig | null,
): LinterConfig {
  const rules: Record<string, MarkdownlintRuleSetting> =
    native?.rules ?? base.plugins.markdownlint.rules;
  return {
    ...base,
    plugins: {
      ...base.plugins,
      markdownlint: { ...base.plugins.markdownlint, rules },
    },
  };
}

/**
 * Inject loaded frontmatter schemas into the effective config. Doc-independent
 * (the mapping is project-wide; per-doc `appliesTo` filtering happens in the
 * plugin), so callers that lint many docs — the audit — pre-compose ONCE and
 * the per-doc pass skips the disk reads: entries that already carry a `key`
 * are treated as resolved.
 */
export function composeFrontmatterSchemasConfig(
  projectDir: string,
  config: LinterConfig,
  onProblem?: (problem: string) => void,
): LinterConfig {
  const slice = config.plugins.frontmatter;
  if (!slice.enabled || slice.schemas.length === 0) return config;
  const alreadyResolved = slice.schemas.every((entry) => entry.key !== undefined);
  if (alreadyResolved) return config;
  const { entries, problems } = resolveFrontmatterSchemas(projectDir, slice.schemas);
  if (onProblem) for (const problem of problems) onProblem(problem);
  return {
    ...config,
    plugins: {
      ...config.plugins,
      frontmatter: { ...slice, schemas: entries },
    },
  };
}

export function resolveEffectiveLinterConfig(
  contentDir: string,
  base: LinterConfig,
  opts: ResolveLinterConfigOptions = {},
): LinterConfig {
  const withNative = composeEffectiveLinterConfig(
    base,
    resolveNativeConfigForDoc(contentDir, opts.docName, opts.onProblem),
  );
  return composeFrontmatterSchemasConfig(opts.projectDir ?? contentDir, withNative, opts.onProblem);
}
