/**
 * The theme "plugin" panel — the color-palette picker + custom-theme editor,
 * rendered in the Plugins menu (Settings → Plugins → Themes) as a peer of the
 * lint plugins. Reuses the same user-scope config-form machinery the Preferences
 * pane uses.
 */

import type { ConfigBinding } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { CustomThemeEditor } from './CustomThemeEditor';
import { BoundSchemaSection } from './schema-section';
import { FIELDS_THEME_PLUGIN } from './settings-fields';

export function ThemePluginSection({ userBinding }: { userBinding: ConfigBinding }) {
  const { t } = useLingui();
  return (
    <div className="space-y-6">
      <BoundSchemaSection
        title={t`Themes`}
        description={t`Pick a built-in IDE color palette, or define your own.`}
        scope="user"
        scopeBadge="user"
        binding={userBinding}
        fields={FIELDS_THEME_PLUGIN}
      />
      <CustomThemeEditor userBinding={userBinding} />
    </div>
  );
}
