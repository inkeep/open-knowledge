/**
 * Schema-driven settings field definitions, extracted from the heavy lazy
 * `SettingsDialogBody` so the main-chunk settings SEARCH index can read field
 * labels without pulling the form harness (RHF, ConfigSchema, schema-walker)
 * into the main bundle. Deps here are intentionally light: the `MessageDescriptor`
 * type + the `msg` macro only.
 *
 * The body imports these back for rendering; `INDEXED_FIELD_GROUPS` maps each
 * FieldDef array to the `activeId` section it renders under, so the search index
 * can attribute a field hit to a navigable section.
 */
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

export interface FieldDef {
  path: string[];
  label: MessageDescriptor;
  description?: MessageDescriptor;
  /**
   * Optional override: 'enum-toggle' renders enum as a ToggleGroup;
   * 'theme-tiles' renders the IDE color-palette tile picker; default is a
   * select-style toggle.
   */
  control?: 'enum-toggle' | 'theme-tiles';
}

export const FIELDS_USER_PREFERENCES: FieldDef[] = [
  {
    path: ['appearance', 'theme'],
    label: msg`Theme`,
    description: msg`Light, dark, or follow the OS.`,
    control: 'enum-toggle',
  },
  {
    path: ['editor', 'wordWrap'],
    label: msg`Word wrap`,
    description: msg`Wrap long lines in the markdown source editor.`,
  },
  {
    path: ['appearance', 'preview', 'autoOpen'],
    label: msg`Open preview when agent edits`,
    description: msg`When enabled, the agent opens or refreshes the preview after each edit. Disable if you manage your own preview window (OK Desktop, a browser tab on another display, etc.).`,
  },
];

// The color-theme picker is a theme "plugin": it lives in the Plugins menu
// (Settings → Plugins → Themes) as a peer of the lint plugins, not in
// Preferences. `appearance.theme` (light/dark/system) stays in Preferences.
export const FIELDS_THEME_PLUGIN: FieldDef[] = [
  {
    path: ['appearance', 'colorTheme'],
    label: msg`Color theme`,
    description: msg`Pick a built-in IDE palette. The dark IDE themes override the light/dark setting in Preferences.`,
    control: 'theme-tiles',
  },
];

/** A settings section's `activeId` paired with the schema fields it renders. */
export interface IndexedFieldGroup {
  sectionId: string;
  fields: FieldDef[];
}

/**
 * The schema-field groups the settings search indexes, keyed to the section id
 * a field hit navigates to. Only the two declarative `FieldDef` arrays are
 * indexed at field granularity; bespoke non-schema sections are reachable via
 * their section-level entry.
 */
export const INDEXED_FIELD_GROUPS: IndexedFieldGroup[] = [
  { sectionId: 'preferences', fields: FIELDS_USER_PREFERENCES },
  { sectionId: 'plugin:theme', fields: FIELDS_THEME_PLUGIN },
];
