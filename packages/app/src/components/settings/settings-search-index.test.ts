import { MARKDOWNLINT_RULE_CATALOG } from '@inkeep/open-knowledge-core';
import type { MessageDescriptor } from '@lingui/core';
import { describe, expect, test, vi } from 'vitest';
import { matchesCommandQuery } from '@/components/command-palette-search';
import { FIELDS_USER_PREFERENCES } from './settings-fields';
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
    const previewField = FIELDS_USER_PREFERENCES.find(
      (field) => field.path.join('.') === 'editor.previewTabs',
    );
    expect(previewField).toBeDefined();
    if (!previewField?.description) throw new Error('expected preview tabs field description');

    const labelSentinel = 'preview-tabs-label-sentinel';
    const descriptionSentinel = 'preview-tabs-description-sentinel';
    const structuralTranslate = vi.fn((message: MessageDescriptor) => {
      if (message === previewField.label) return labelSentinel;
      if (message === previewField.description) return descriptionSentinel;
      return message.id ?? '';
    });
    const entries = buildSettingsSearchIndex({
      groups: groupsFixture({}),
      translate: structuralTranslate,
    });
    const fieldEntries = entries.filter((e) => e.kind === 'field' && e.sectionId === 'preferences');
    expect(fieldEntries.length).toBeGreaterThan(0);
    const wordWrap = fieldEntries.find((e) => e.targetField === 'editor.wordWrap');
    expect(wordWrap).toBeDefined();
    expect(wordWrap?.kind).toBe('field');
    expect(wordWrap?.sectionId).toBe('preferences');

    const previewTabs = fieldEntries.find((e) => e.targetField === 'editor.previewTabs');
    expect(previewTabs).toMatchObject({
      kind: 'field',
      sectionId: 'preferences',
      label: labelSentinel,
      keywords: [descriptionSentinel],
      targetField: 'editor.previewTabs',
    });
    expect(structuralTranslate).toHaveBeenCalledWith(previewField.label);
    expect(structuralTranslate).toHaveBeenCalledWith(previewField.description);
  });

  // Two sidebar rows are both called "Preferences" (User and This project). The
  // result list renders the label, so without a context the two rows are
  // indistinguishable and search stops being a usable way to reach either.
  test('sections carry their group as context, so colliding labels stay tellable apart', () => {
    const groups: SidebarGroup[] = [
      {
        id: 'user',
        label: 'User',
        enabled: true,
        items: [{ id: 'preferences', label: 'Preferences' }],
      },
      {
        id: 'project',
        label: 'This project',
        enabled: true,
        items: [{ id: 'project-preferences', label: 'Preferences' }],
      },
    ];
    const entries = buildSettingsSearchIndex({ groups, translate });
    const preferences = entries.filter((e) => e.label === 'Preferences');

    expect(preferences).toHaveLength(2);
    // The pair is what matters: same label, different context.
    expect(preferences.map((e) => e.context).sort()).toEqual(['This project', 'User']);
  });

  test('subsections emit field-kind entries that navigate to the parent and anchor its block', () => {
    const groups: SidebarGroup[] = [
      {
        id: 'project',
        label: 'This project',
        enabled: true,
        items: [
          {
            id: 'project-preferences',
            label: 'Preferences',
            subsections: [
              { id: 'content-rules', label: 'Content rules', anchor: 'section:content-rules' },
            ],
          },
        ],
      },
    ];
    const entries = buildSettingsSearchIndex({ groups, translate });
    const sub = entries.find((e) => e.id === 'subsection:project-preferences:content-rules');
    expect(sub).toMatchObject({
      kind: 'field',
      sectionId: 'project-preferences',
      label: 'Content rules',
      context: 'This project → Preferences',
      keywords: ['This project', 'Preferences'],
      targetField: 'section:content-rules',
    });

    // Subsections inherit the group's enablement gate like everything else.
    const disabled = buildSettingsSearchIndex({
      groups: [{ ...groups[0], enabled: false }],
      translate,
    });
    expect(disabled.some((e) => e.id.startsWith('subsection:'))).toBe(false);
  });

  test('theme field indexed only when the theme plugin is a visible section', () => {
    const withTheme = buildSettingsSearchIndex({
      groups: groupsFixture({ themeVisible: true }),
      translate,
    });
    expect(withTheme.some((e) => e.targetField === 'appearance.colorThemeLight')).toBe(true);

    const withoutTheme = buildSettingsSearchIndex({
      groups: groupsFixture({ themeVisible: false }),
      translate,
    });
    expect(withoutTheme.some((e) => e.targetField === 'appearance.colorThemeLight')).toBe(false);
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

  test('a section is found by a multi-word query spanning its label and its group', () => {
    // "Sync" is the item label and "This project" its group heading, so the two
    // words a user types are both in the searchable text but never adjacent in
    // the order typed.
    expect(find('project sync').some((e) => e.kind === 'section' && e.sectionId === 'sync')).toBe(
      true,
    );
  });

  test('a query whose terms are not ALL present returns no entries', () => {
    // The counterweight: matching on any one term would surface the Sync
    // section here.
    expect(find('sync zzzznomatch')).toHaveLength(0);
  });
});
