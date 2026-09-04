import type { LintPluginId } from '@inkeep/open-knowledge-core';

export interface LintPluginMeta {
  id: LintPluginId;
  label: string;
  docUrl: string;
  beta?: boolean;
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
