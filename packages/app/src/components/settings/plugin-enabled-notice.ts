import { t } from '@lingui/core/macro';
import { toast } from 'sonner';
import { openPluginSettings } from '@/lib/use-settings-route';

const NOTICE_DURATION_MS = 8000;

export interface PluginEnabledNotice {
  pluginId: string;
  label: string;
}

export function notifyPluginEnabled({ pluginId, label }: PluginEnabledNotice): void {
  toast.success(t`${label} enabled`, {
    id: `plugin-enabled-${pluginId}`,
    description: t`Set it up on its own page under Plugins.`,
    duration: NOTICE_DURATION_MS,
    action: {
      label: t`Open settings`,
      onClick: () => openPluginSettings(pluginId),
    },
  });
}
