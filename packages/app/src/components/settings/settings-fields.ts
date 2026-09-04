import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';

export interface FieldDef {
  path: string[];
  label: MessageDescriptor;
  description?: MessageDescriptor;
  control?: 'enum-toggle' | 'theme-cards' | 'theme-tiles' | 'language-select';
}

export const FIELDS_USER_PREFERENCES: FieldDef[] = [
  {
    path: ['appearance', 'theme'],
    label: msg`Theme`,
    description: msg`Light, dark, or follow the OS.`,
    control: 'theme-cards',
  },
  {
    path: ['appearance', 'language'],
    label: msg`Language`,
    description: msg`The language OpenKnowledge speaks; System follows your operating system. Your own notes stay in the language you wrote them in.`,
    control: 'language-select',
  },
  {
    path: ['editor', 'wordWrap'],
    label: msg`Word wrap`,
    description: msg`Wrap long lines in the markdown source editor.`,
  },
  {
    path: ['editor', 'previewTabs'],
    label: msg`Preview tabs`,
    description: msg`Reuse one tab when clicking through the sidebars. Off opens every click in its own tab.`,
  },
  {
    path: ['appearance', 'preview', 'autoOpen'],
    label: msg`Open preview when agent edits`,
    description: msg`When enabled, the agent opens or refreshes the preview after each edit. Disable if you manage your own preview window (OK Desktop, a browser tab on another display, etc.).`,
  },
  {
    path: ['telemetry', 'skillInstallReports', 'enabled'],
    label: msg`Count skill installs publicly`,
    description: msg`When you install a published skill, tell the skill directory (skills.sh) so its install count is accurate. Sends the skill name, its source repository, and which agent tools it went to — never file contents, and never for a skill from a private, local, or hand-typed source. Once per skill per machine.`,
  },
];

export const FIELDS_THEME_PLUGIN: FieldDef[] = [
  {
    path: ['appearance', 'colorThemeLight'],
    label: msg`Color theme`,
    description: msg`Pick a palette for light mode and one for dark mode. The theme setting in Preferences chooses between them — on “System”, so does your OS.`,
    control: 'theme-tiles',
  },
];

export interface IndexedFieldGroup {
  sectionId: string;
  fields: FieldDef[];
}

export const INDEXED_FIELD_GROUPS: IndexedFieldGroup[] = [
  { sectionId: 'preferences', fields: FIELDS_USER_PREFERENCES },
  { sectionId: 'plugin:theme', fields: FIELDS_THEME_PLUGIN },
];
