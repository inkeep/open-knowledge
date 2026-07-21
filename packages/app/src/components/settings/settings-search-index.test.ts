import { MARKDOWNLINT_RULE_CATALOG } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { matchesCommandQuery } from '@/components/command-palette-search';
import { buildSettingsSearchIndex } from './settings-search-index';
import type { SidebarGroup } from './settings-sidebar-types';

// A translate stub — the FieldDef labels are Lingui MessageDescriptors; the
// real Shell passes `useLingui().t`. For the index we only need a string.
const translate = (message: { id?: string }) => message.id ?? '';

function groupsFixture(opts: {
  projectEnabled?: boolean;
  markdownlintVisible?: boolean;
  themeVisible?: boolean;
}): SidebarGroup[] {
  const { projectEnabled = true, markdownlintVisible = true, themeVisible = true } = opts;
  const pluginItems = [
    ...(markdownlintVisible ? [{ id: 'plugin:markdownlint', label: 'markdownlint' }] : []),
    ...(themeVisible ? [{ id: 'plugin:theme', label: 'Themes' }] : []),
  ];
  return [
    {
      id: 'user',
      label: 'User',
      enabled: true,
      items: [{ id: 'preferences', label: 'Preferences' }],
    },
    {
      id: 'project',
      label: 'This project',
      enabled: projectEnabled,
      items: [{ id: 'sync', label: 'Sync' }],
    },
    { id: 'plugins', label: 'Plugins', enabled: true, items: pluginItems },
  ];
}

describe('buildSettingsSearchIndex', () => {
  test('emits a section entry per item of an ENABLED group only', () => {
    const enabled = buildSettingsSearchIndex({
      groups: groupsFixture({ projectEnabled: true }),
      translate,
    });
    expect(enabled.some((e) => e.kind === 'section' && e.sectionId === 'sync')).toBe(true);

    const disabled = buildSettingsSearchIndex({
      groups: groupsFixture({ projectEnabled: false }),
      translate,
    });
    // The disabled THIS-PROJECT group contributes no section entries.
    expect(disabled.some((e) => e.sectionId === 'sync')).toBe(false);
    expect(disabled.some((e) => e.sectionId === 'preferences')).toBe(true);
  });

  test('indexes preferences fields (visible section) with description keywords + targetField', () => {
    const entries = buildSettingsSearchIndex({ groups: groupsFixture({}), translate });
    const fieldEntries = entries.filter((e) => e.kind === 'field' && e.sectionId === 'preferences');
    expect(fieldEntries.length).toBeGreaterThan(0);
    const wordWrap = fieldEntries.find((e) => e.targetField === 'editor.wordWrap');
    expect(wordWrap).toBeDefined();
    expect(wordWrap?.kind).toBe('field');
    expect(wordWrap?.sectionId).toBe('preferences');
  });

  test('theme field indexed only when the theme plugin is a visible section', () => {
    const withTheme = buildSettingsSearchIndex({
      groups: groupsFixture({ themeVisible: true }),
      translate,
    });
    expect(withTheme.some((e) => e.targetField === 'appearance.colorTheme')).toBe(true);

    const withoutTheme = buildSettingsSearchIndex({
      groups: groupsFixture({ themeVisible: false }),
      translate,
    });
    expect(withoutTheme.some((e) => e.targetField === 'appearance.colorTheme')).toBe(false);
  });

  test('markdownlint rules indexed only when the panel is visible (disabled plugin excluded)', () => {
    const enabled = buildSettingsSearchIndex({
      groups: groupsFixture({ markdownlintVisible: true }),
      translate,
    });
    const ruleEntries = enabled.filter((e) => e.kind === 'rule');
    expect(ruleEntries.length).toBe(MARKDOWNLINT_RULE_CATALOG.length);
    expect(ruleEntries.every((e) => e.sectionId === 'plugin:markdownlint')).toBe(true);

    const disabled = buildSettingsSearchIndex({
      groups: groupsFixture({ markdownlintVisible: false }),
      translate,
    });
    expect(disabled.some((e) => e.kind === 'rule')).toBe(false);
  });

  test('a rule entry carries id + alias + aliases as keywords', () => {
    const entries = buildSettingsSearchIndex({ groups: groupsFixture({}), translate });
    const sample = MARKDOWNLINT_RULE_CATALOG[0];
    const entry = entries.find((e) => e.kind === 'rule' && e.ruleId === sample.id);
    expect(entry).toBeDefined();
    expect(entry?.keywords).toContain(sample.id);
    expect(entry?.keywords).toContain(sample.alias);
    for (const alias of sample.aliases) {
      expect(entry?.keywords).toContain(alias);
    }
  });
});

// Pins the settings-specific search SEMANTICS: the entries this module produces,
// filtered by the same `matchesCommandQuery` the sidebar uses, resolve the
// queries a user actually types. (Field label matching is covered end-to-end at
// real-locale fidelity by the e2e; here we pin rule + section matching, which is
// deterministic without the Lingui runtime.)
describe('buildSettingsSearchIndex + matchesCommandQuery', () => {
  const entries = buildSettingsSearchIndex({ groups: groupsFixture({}), translate });
  const find = (query: string) =>
    entries.filter((entry) => matchesCommandQuery(entry.label, query, entry.keywords));

  test('a markdownlint rule is found by upstream name, id (case-insensitive), and alias', () => {
    const md013 = MARKDOWNLINT_RULE_CATALOG.find((rule) => rule.id === 'MD013');
    expect(md013).toBeDefined();
    if (!md013) return;
    expect(find(md013.name).some((e) => e.ruleId === 'MD013')).toBe(true);
    expect(find('md013').some((e) => e.ruleId === 'MD013')).toBe(true);
    expect(find(md013.alias).some((e) => e.ruleId === 'MD013')).toBe(true);
  });

  test('a section is found by its label', () => {
    expect(find('Sync').some((e) => e.kind === 'section' && e.sectionId === 'sync')).toBe(true);
  });

  test('a query matching nothing returns no entries', () => {
    expect(find('zzzznomatch')).toHaveLength(0);
  });
});
