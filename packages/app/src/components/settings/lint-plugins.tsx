/**
 * App-side lint-plugin registry: id → display label → settings panel. The body
 * dispatches `plugin:<id>` to the right panel via this. The id+label come from
 * the lightweight `LINT_PLUGIN_META` (shared with the sidebar); this module adds
 * the Section components, so importing it eagerly pulls the panels in. Adding a
 * future plugin's GUI = one `LINT_PLUGIN_META` entry + its Section in the map.
 */
import type { ReactNode } from 'react';
import { MarkdownlintPluginSection } from './LintingSection';
import { LINT_PLUGIN_META, type LintPluginMeta } from './lint-plugin-meta';

type PluginSection = () => ReactNode;

const SECTIONS: Record<LintPluginMeta['id'], PluginSection> = {
  markdownlint: MarkdownlintPluginSection,
};

export interface LintPluginUi extends LintPluginMeta {
  Section: PluginSection;
}

export const LINT_PLUGIN_UI: LintPluginUi[] = LINT_PLUGIN_META.map((meta) => ({
  ...meta,
  Section: SECTIONS[meta.id],
}));
