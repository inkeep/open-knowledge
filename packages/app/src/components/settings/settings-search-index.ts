/**
 * Pure builder for the Settings dialog search index. The index is derived from
 * the SAME `groups` array the sidebar renders, so every enablement gate (a
 * disabled THIS-PROJECT group, an absent/disabled plugin, desktop-only items)
 * is inherited for free — a section (and its fields/rules) is indexed only when
 * it is actually reachable. In particular, markdownlint rules are indexed only
 * when the markdownlint panel is a visible sidebar item, which is exactly the
 * "plugin enabled + project open" predicate. No gating logic is duplicated here.
 *
 * Filtering at render time reuses `matchesCommandQuery` (the same substring
 * matcher the ⌘K command palette uses), so this module only shapes the corpus.
 */
import { MARKDOWNLINT_RULE_CATALOG } from '@inkeep/open-knowledge-core';
import type { MessageDescriptor } from '@lingui/core';
import { INDEXED_FIELD_GROUPS } from './settings-fields';
import type { SidebarGroup } from './settings-sidebar-types';

type SettingsSearchKind = 'section' | 'field' | 'rule';

export interface SettingsSearchEntry {
  /** Stable, unique key — also the cmdk CommandItem `value`. */
  id: string;
  kind: SettingsSearchKind;
  /** `activeId` this result navigates to. */
  sectionId: string;
  /** Primary display + search text. */
  label: string;
  /** Extra search terms (group label, description, rule id/aliases). */
  keywords: string[];
  /** Dotted config path — field entries only. Drives the scroll-to-flash. */
  targetField?: string;
  /** markdownlint rule id — rule entries only. Seeds the rule browser's search. */
  ruleId?: string;
}

/**
 * Build the flat, navigable search corpus for the current dialog state.
 * `translate` resolves a Lingui `MessageDescriptor` (the FieldDef labels) to a
 * string — pass `useLingui().t`, the same call the body uses to render them.
 */
export function buildSettingsSearchIndex(input: {
  groups: readonly SidebarGroup[];
  translate: (message: MessageDescriptor) => string;
}): SettingsSearchEntry[] {
  const { groups, translate } = input;
  const entries: SettingsSearchEntry[] = [];

  // Visible, navigable sections = items of ENABLED groups only.
  const visibleSectionIds = new Set<string>();
  for (const group of groups) {
    if (!group.enabled) continue;
    for (const item of group.items) {
      visibleSectionIds.add(item.id);
      entries.push({
        id: `section:${item.id}`,
        kind: 'section',
        sectionId: item.id,
        label: item.label,
        keywords: [group.label],
      });
    }
  }

  // Schema fields — only for a section that is actually reachable (auto-drops
  // the theme field when the theme plugin is off, since `plugin:theme` won't be
  // a visible item).
  for (const fieldGroup of INDEXED_FIELD_GROUPS) {
    if (!visibleSectionIds.has(fieldGroup.sectionId)) continue;
    for (const field of fieldGroup.fields) {
      const path = field.path.join('.');
      entries.push({
        id: `field:${fieldGroup.sectionId}:${path}`,
        kind: 'field',
        sectionId: fieldGroup.sectionId,
        label: translate(field.label),
        keywords: field.description ? [translate(field.description)] : [],
        targetField: path,
      });
    }
  }

  // markdownlint rules — only when the panel is a visible section (inherits the
  // enabled + project-open gate). This satisfies "disabled plugins excluded".
  if (visibleSectionIds.has('plugin:markdownlint')) {
    for (const rule of MARKDOWNLINT_RULE_CATALOG) {
      entries.push({
        id: `rule:${rule.id}`,
        kind: 'rule',
        sectionId: 'plugin:markdownlint',
        label: rule.name,
        keywords: [rule.id, rule.alias, ...rule.aliases],
        ruleId: rule.id,
      });
    }
  }

  return entries;
}
