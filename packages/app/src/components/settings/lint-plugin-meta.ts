/**
 * Lightweight lint-plugin metadata (id + label), the single source of truth for
 * the plugin list. Kept free of React + section-component imports so the
 * settings SHELL can build its sidebar from it without eagerly pulling the heavy
 * per-plugin panels (and their core/editor deps) into its module graph — the
 * full id→Section registry lives in `lint-plugins.tsx`, imported by the body.
 */
import type { LintPluginId } from '@inkeep/open-knowledge-core';

export interface LintPluginMeta {
  id: LintPluginId;
  /** Sidebar + panel-header label (brand names — intentionally not translated). */
  label: string;
  /** Docs page for the plugin, linked from its settings panel. */
  docUrl: string;
  /**
   * Feature-maturity tag. A property of the plugin rather than a check against
   * its id at each render site, so every surface that shows a plugin agrees on
   * whether it is beta and a graduation is one edit here.
   */
  beta?: boolean;
  /** Companion skills the plugin recommends as a separate, explicit install. */
  recommendedSkills?: readonly { packId: string; name: string }[];
}

const DOCS_BASE = 'https://openknowledge.ai/docs/advanced/content-rules';

export const LINT_PLUGIN_META: LintPluginMeta[] = [
  { id: 'markdownlint', label: 'markdownlint', docUrl: `${DOCS_BASE}/markdownlint` },
  {
    id: 'frontmatter',
    // biome-ignore lint/plugin/no-unwrapped-user-facing-string: names the frontmatter plugin, and `frontmatter` is a GLOSSARY never-translate term — this label is the plugin's name beside `markdownlint`, not copy.
    label: 'Frontmatter schemas',
    docUrl: `${DOCS_BASE}/frontmatter`,
  },
  {
    id: 'okf',
    label: 'OKF',
    docUrl: 'https://openknowledge.ai/docs/plugins/okf',
    beta: true,
    recommendedSkills: [{ packId: 'okf', name: 'okf-knowledge-base' }],
  },
];
