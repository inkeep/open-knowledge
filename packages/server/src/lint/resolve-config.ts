import { dirname, join } from 'node:path';
import type { LinterConfig, MarkdownlintRuleSetting } from '@inkeep/open-knowledge-core';
import { resolveFrontmatterSchemas } from './frontmatter-schemas.ts';
import {
  type DiscoveredMarkdownlintConfig,
  resolveNativeMarkdownlintConfig,
} from './markdownlint-discovery.ts';

export interface ResolveLinterConfigOptions {
  docName?: string;
  projectDir?: string;
  onProblem?: (problem: string) => void;
}

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
