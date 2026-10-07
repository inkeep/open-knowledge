import type { ConfigBinding } from '@inkeep/open-knowledge-core/config/bind-config-doc';
import type { Config } from '@inkeep/open-knowledge-core/config/schema';
import {
  CC1_CONTRACT_VERSION,
  CONFIG_DOC_NAME_USER,
} from '@inkeep/open-knowledge-core/constants/cc1';
import { CC1_CHANNEL_CONFIG_VALIDATION_REJECTED } from '@inkeep/open-knowledge-core/schemas/cc1';
import { useEffect, useState } from 'react';
import type { ConfigContextValue } from './config-context';
import { emitConfigValidationRejected } from './config-validation-events';
import type { OkDesktopBridge } from './desktop-bridge-types';
import { createIpcUserConfigBinding } from './ipc-user-config-binding';

interface NavigatorUserConfigState {
  binding: ConfigBinding;
  config: Config;
  synced: boolean;
  loadFailed: boolean;
}

export interface NavigatorUserConfig {
  binding: ConfigBinding | null;
  config: Config | null;
  synced: boolean;
  loadFailed: boolean;
}

export function useNavigatorUserConfig(bridge: OkDesktopBridge): NavigatorUserConfig {
  const [state, setState] = useState<NavigatorUserConfigState | null>(null);

  useEffect(() => {
    const transport = bridge.userConfig;
    if (!transport) return;
    let rejectionSeq = 0;
    const binding: ConfigBinding = createIpcUserConfigBinding(transport, {
      onLoadFailedChange: (loadFailed) => {
        setState((prev) => (prev?.binding === binding ? { ...prev, loadFailed } : prev));
      },
      onRemoteRejected: (error) => {
        rejectionSeq += 1;
        emitConfigValidationRejected({
          v: CC1_CONTRACT_VERSION,
          ch: CC1_CHANNEL_CONFIG_VALIDATION_REJECTED,
          seq: rejectionSeq,
          docName: CONFIG_DOC_NAME_USER,
          error,
        });
      },
    });
    setState({
      binding,
      config: binding.current(),
      synced: binding.hasSynced(),
      loadFailed: false,
    });
    const unsubscribe = binding.subscribe((config) => {
      setState((prev) => (prev?.binding === binding ? { ...prev, config } : prev));
    });
    const unsubscribeSynced = binding.subscribeSynced(() => {
      setState((prev) =>
        prev?.binding === binding ? { ...prev, config: binding.current(), synced: true } : prev,
      );
    });
    return () => {
      unsubscribe();
      unsubscribeSynced();
      binding.dispose();
      setState((prev) => (prev?.binding === binding ? null : prev));
    };
  }, [bridge]);

  return {
    binding: state?.binding ?? null,
    config: state?.config ?? null,
    synced: state?.synced ?? false,
    loadFailed: state?.loadFailed ?? false,
  };
}

export function navigatorConfigContextValue(userConfig: NavigatorUserConfig): ConfigContextValue {
  return {
    userBinding: userConfig.binding,
    userSynced: userConfig.synced,
    userLoadFailed: userConfig.loadFailed,
    projectBinding: null,
    projectLocalBinding: null,
    okignoreBinding: null,
    okignoreSynced: false,
    userConfig: userConfig.config,
    projectConfig: null,
    projectSynced: false,
    projectLocalConfig: null,
    projectLocalSynced: false,
    merged: userConfig.synced ? userConfig.config : null,
  };
}
