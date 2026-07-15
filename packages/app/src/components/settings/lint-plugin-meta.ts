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
}

export const LINT_PLUGIN_META: LintPluginMeta[] = [{ id: 'markdownlint', label: 'markdownlint' }];
