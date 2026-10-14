import { ConfigSchema } from '@inkeep/open-knowledge-core/config/schema';
import type { ConfigContextValue } from '@/lib/config-context';

export interface ProjectTerminalSetting {
  readonly synced: boolean;
  readonly enabled: boolean | null;
}

export const TERMINAL_SETTING_UNSET: ProjectTerminalSetting = { synced: true, enabled: null };

export function configContextWithTerminal({
  synced,
  enabled,
}: ProjectTerminalSetting): ConfigContextValue {
  return {
    userBinding: null,
    userSynced: synced,
    projectBinding: null,
    projectLocalBinding: null,
    okignoreBinding: null,
    okignoreSynced: synced,
    userConfig: null,
    projectConfig: null,
    projectSynced: synced,
    projectLocalConfig: ConfigSchema.parse({ terminal: { enabled } }),
    projectLocalSynced: synced,
    merged: null,
  };
}
