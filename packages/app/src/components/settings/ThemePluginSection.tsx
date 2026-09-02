import type { ConfigBinding } from '@inkeep/open-knowledge-core';
import { useLingui } from '@lingui/react/macro';
import { useEffect } from 'react';
import { useSavedThemes } from '@/lib/saved-themes-client';
import { CustomThemeEditor } from './CustomThemeEditor';
import { BoundSchemaSection } from './schema-section';
import { FIELDS_THEME_PLUGIN } from './settings-fields';

export function ThemePluginSection({ userBinding }: { userBinding: ConfigBinding }) {
  const { t } = useLingui();
  const { themes, editingThemeId, themeEditorOpen, selectThemeToEdit } = useSavedThemes();
  const editableTheme = themes.find(
    (theme) => theme.id === editingThemeId && theme.id.startsWith('saved-') && theme.scheme,
  );
  useEffect(() => {
    if (themeEditorOpen && !editableTheme) selectThemeToEdit(null);
  }, [editableTheme, selectThemeToEdit, themeEditorOpen]);
  return (
    <div className="space-y-6">
      <BoundSchemaSection
        title={t`Themes`}
        description={t`Pick a theme or create your own.`}
        scope="user"
        scopeBadge="user"
        binding={userBinding}
        fields={FIELDS_THEME_PLUGIN}
      />
      {themeEditorOpen && editableTheme ? <CustomThemeEditor userBinding={userBinding} /> : null}
    </div>
  );
}
