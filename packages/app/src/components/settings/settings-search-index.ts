import { MARKDOWNLINT_RULE_CATALOG } from '@inkeep/open-knowledge-core';
import type { MessageDescriptor } from '@lingui/core';
import { INDEXED_FIELD_GROUPS } from './settings-fields';
import type { SidebarGroup } from './settings-sidebar-types';

type SettingsSearchKind = 'section' | 'field' | 'rule';

export interface SettingsSearchEntry {
  id: string;
  kind: SettingsSearchKind;
  sectionId: string;
  label: string;
  context?: string;
  keywords: string[];
  targetField?: string;
  ruleId?: string;
}

export function buildSettingsSearchIndex(input: {
  groups: readonly SidebarGroup[];
  translate: (message: MessageDescriptor) => string;
}): SettingsSearchEntry[] {
  const { groups, translate } = input;
  const entries: SettingsSearchEntry[] = [];

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
        context: group.label,
        keywords: [group.label],
      });
      for (const sub of item.subsections ?? []) {
        entries.push({
          id: `subsection:${item.id}:${sub.id}`,
          kind: 'field',
          sectionId: item.id,
          label: sub.label,
          context: `${group.label} → ${item.label}`,
          keywords: [group.label, item.label],
          targetField: sub.anchor,
        });
      }
    }
  }

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
