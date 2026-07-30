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
}

const DOCS_BASE = 'https://openknowledge.ai/docs/advanced/content-rules';

export const LINT_PLUGIN_META: LintPluginMeta[] = [
  { id: 'markdownlint', label: 'markdownlint', docUrl: `${DOCS_BASE}/markdownlint` },
  { id: 'frontmatter', label: 'Frontmatter schemas', docUrl: `${DOCS_BASE}/frontmatter` },
];
