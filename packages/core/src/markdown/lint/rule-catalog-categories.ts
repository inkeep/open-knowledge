import type { RuleCatalogEntry } from './types.ts';

export const RULE_DISPLAY_CATEGORIES = [
  'Headings',
  'Lists',
  'Whitespace',
  'Code',
  'Links & images',
  'Style',
] as const;

export type RuleDisplayCategory = (typeof RULE_DISPLAY_CATEGORIES)[number];

const TAG_DISPLAY_CATEGORY_PRECEDENCE: readonly (readonly [string, RuleDisplayCategory])[] = [
  ['headings', 'Headings'],
  ['bullet', 'Lists'],
  ['ul', 'Lists'],
  ['ol', 'Lists'],
  ['links', 'Links & images'],
  ['images', 'Links & images'],
  ['accessibility', 'Links & images'],
  ['code', 'Code'],
  ['language', 'Code'],
  ['emphasis', 'Style'],
  ['html', 'Style'],
  ['line_length', 'Whitespace'],
  ['whitespace', 'Whitespace'],
  ['hard_tab', 'Whitespace'],
  ['blank_lines', 'Whitespace'],
  ['indentation', 'Whitespace'],
];

export function displayCategoryForRule(rule: Pick<RuleCatalogEntry, 'tags'>): RuleDisplayCategory {
  for (const [tag, category] of TAG_DISPLAY_CATEGORY_PRECEDENCE) {
    if (rule.tags.includes(tag)) return category;
  }
  return 'Style';
}
