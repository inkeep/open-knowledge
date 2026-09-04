import { HocuspocusProvider } from '@hocuspocus/provider';
import {
  bindConfigDoc,
  bindOkignoreDoc,
  CONFIG_DOC_NAME_OKIGNORE,
  CONFIG_DOC_NAME_PROJECT,
  CONFIG_DOC_NAME_PROJECT_LOCAL,
  CONFIG_DOC_NAME_USER,
  type Config,
  type ConfigBinding,
  mergeLayered,
  type OkignoreBinding,
  type WriteScope,
} from '@inkeep/open-knowledge-core';
import { useTheme } from 'next-themes';
import { type ReactNode, useEffect, useState } from 'react';
import * as Y from 'yjs';
import { useLanguageBridge } from '@/hooks/use-language-bridge';
import { useThemeBridge } from '@/hooks/use-theme-bridge';
import { buildAuthToken } from './auth-token';
import {
  colorThemeMode,
  customThemeKind,
  resolveColorThemeSelection,
  resolveCustomScheme,
  resolveModePreference,
} from './color-themes';
import { ConfigContext, type ConfigContextValue } from './config-context';
import { SavedThemesProvider, useSavedThemes } from './saved-themes-client';
import { useServerInstanceId } from './server-instance-store';
import { useApplyConfigColorTheme } from './use-apply-config-color-theme';
import { useApplyConfigLanguage } from './use-apply-config-language';
import { useApplyConfigTheme } from './use-apply-config-theme';

export { useConfigContext } from './config-context';

interface ScopedBinding {
  binding: ConfigBinding;
  config: Config;
  cleanup: () => void;
}

type CloseEventLike = { code: number; reason: string };

function logProviderEvent(
  role: string,
  docName: string,
  event: 'disconnect' | 'close',
  closeEvent: CloseEventLike | undefined,
) {
  console.warn(
    JSON.stringify({
      event: `ok-${role}-${event}`,
      docName,
      code: closeEvent?.code,
      reason: closeEvent?.reason ?? undefined,
    }),
  );
}

function makeBinding(
  collabUrl: string,
  docName: string,
  scope: WriteScope,
  serverInstanceId: string | null,
): ScopedBinding {
  const ydoc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: collabUrl,
    name: docName,
    document: ydoc,
    token: buildAuthToken(null, serverInstanceId, null),
    onDisconnect: ({ event }) => logProviderEvent('config-provider', docName, 'disconnect', event),
    onClose: ({ event }) => logProviderEvent('config-provider', docName, 'close', event),
  });
  const binding = bindConfigDoc(provider, scope);
  const cleanup = () => {
    binding.dispose();
    provider.destroy();
    ydoc.destroy();
  };
  return { binding, config: binding.current(), cleanup };
}

interface OkignoreScoped {
  binding: OkignoreBinding;
  provider: HocuspocusProvider;
  cleanup: () => void;
}

function makeOkignoreBinding(collabUrl: string, serverInstanceId: string | null): OkignoreScoped {
  const ydoc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: collabUrl,
    name: CONFIG_DOC_NAME_OKIGNORE,
    document: ydoc,
    token: buildAuthToken(null, serverInstanceId, null),
    onDisconnect: ({ event }) =>
      logProviderEvent('okignore-provider', CONFIG_DOC_NAME_OKIGNORE, 'disconnect', event),
    onClose: ({ event }) =>
      logProviderEvent('okignore-provider', CONFIG_DOC_NAME_OKIGNORE, 'close', event),
  });
  const binding = bindOkignoreDoc(provider);
  const cleanup = () => {
    binding.dispose();
    provider.destroy();
    ydoc.destroy();
  };
  return { binding, provider, cleanup };
}

function ConfigProviderBody({
  collabUrl,
  children,
}: {
  collabUrl: string | null;
  children: ReactNode;
}) {
  const { themes, loaded: savedThemesLoaded, loadError: savedThemesLoadError } = useSavedThemes();
  const serverInstanceId = useServerInstanceId();
  const { systemTheme } = useTheme();
  const systemPrefersDark = systemTheme === 'dark';
  const [userState, setUserState] = useState<{
    binding: ConfigBinding;
    config: Config;
    synced: boolean;
  } | null>(null);
  const [projectState, setProjectState] = useState<{
    binding: ConfigBinding;
    config: Config;
    synced: boolean;
  } | null>(null);
  const [projectLocalState, setProjectLocalState] = useState<{
    binding: ConfigBinding;
    config: Config;
    synced: boolean;
  } | null>(null);
  const [okignoreState, setOkignoreState] = useState<{
    binding: OkignoreBinding;
    synced: boolean;
  } | null>(null);

  useEffect(() => {
    if (collabUrl === null) return;
    const userScoped = makeBinding(collabUrl, CONFIG_DOC_NAME_USER, 'user', serverInstanceId);
    const projectScoped = makeBinding(
      collabUrl,
      CONFIG_DOC_NAME_PROJECT,
      'project',
      serverInstanceId,
    );
    const projectLocalScoped = makeBinding(
      collabUrl,
      CONFIG_DOC_NAME_PROJECT_LOCAL,
      'project-local',
      serverInstanceId,
    );
    const okignoreScoped = makeOkignoreBinding(collabUrl, serverInstanceId);
    setUserState({
      binding: userScoped.binding,
      config: userScoped.config,
      synced: userScoped.binding.hasSynced(),
    });
    setProjectState({
      binding: projectScoped.binding,
      config: projectScoped.config,
      synced: projectScoped.binding.hasSynced(),
    });
    setProjectLocalState({
      binding: projectLocalScoped.binding,
      config: projectLocalScoped.config,
      synced: projectLocalScoped.binding.hasSynced(),
    });
    setOkignoreState({ binding: okignoreScoped.binding, synced: false });

    const unsubUser = userScoped.binding.subscribe((next) => {
      setUserState((prev) =>
        prev?.binding === userScoped.binding ? { ...prev, config: next } : prev,
      );
    });
    const unsubUserSynced = userScoped.binding.subscribeSynced(() => {
      setUserState((prev) =>
        prev?.binding === userScoped.binding
          ? { ...prev, config: userScoped.binding.current(), synced: true }
          : prev,
      );
    });
    const unsubProject = projectScoped.binding.subscribe((next) => {
      setProjectState((prev) =>
        prev?.binding === projectScoped.binding ? { ...prev, config: next } : prev,
      );
    });
    const unsubProjectSynced = projectScoped.binding.subscribeSynced(() => {
      setProjectState((prev) =>
        prev?.binding === projectScoped.binding
          ? { ...prev, config: projectScoped.binding.current(), synced: true }
          : prev,
      );
    });
    const unsubProjectLocal = projectLocalScoped.binding.subscribe((next) => {
      setProjectLocalState((prev) =>
        prev?.binding === projectLocalScoped.binding ? { ...prev, config: next } : prev,
      );
    });
    const unsubProjectLocalSynced = projectLocalScoped.binding.subscribeSynced(() => {
      setProjectLocalState((prev) =>
        prev?.binding === projectLocalScoped.binding
          ? { ...prev, config: projectLocalScoped.binding.current(), synced: true }
          : prev,
      );
    });
    const handleOkignoreSynced = () => {
      setOkignoreState((prev) =>
        prev?.binding === okignoreScoped.binding ? { ...prev, synced: true } : prev,
      );
    };
    okignoreScoped.provider.on('synced', handleOkignoreSynced);

    return () => {
      unsubUser();
      unsubUserSynced();
      unsubProject();
      unsubProjectSynced();
      unsubProjectLocal();
      unsubProjectLocalSynced();
      okignoreScoped.provider.off('synced', handleOkignoreSynced);
      for (const scoped of [userScoped, projectScoped, projectLocalScoped, okignoreScoped]) {
        try {
          scoped.cleanup();
        } catch (e) {
          console.warn(
            JSON.stringify({ event: 'ok-config-provider-cleanup-error', error: String(e) }),
          );
        }
      }
      setUserState((prev) => (prev?.binding === userScoped.binding ? null : prev));
      setProjectState((prev) => (prev?.binding === projectScoped.binding ? null : prev));
      setProjectLocalState((prev) => (prev?.binding === projectLocalScoped.binding ? null : prev));
      setOkignoreState((prev) => (prev?.binding === okignoreScoped.binding ? null : prev));
    };
  }, [collabUrl, serverInstanceId]);

  const merged: Config | null =
    userState && projectState
      ? mergeLayered(userState.config, projectState.config, projectLocalState?.config)
      : null;

  const themeValue = merged?.appearance?.theme;
  const customSeed = merged?.appearance?.customTheme;
  const colorThemeEnabled = merged?.appearance?.colorThemeEnabled !== false;
  const configLayersReady =
    collabUrl === null ||
    (userState?.synced === true &&
      projectState?.synced === true &&
      projectLocalState?.synced === true);
  const authoredThemeIds = [
    merged?.appearance?.colorThemeLight,
    merged?.appearance?.colorThemeDark,
    merged?.appearance?.colorTheme,
  ];
  const needsSavedThemeRegistry =
    colorThemeEnabled &&
    authoredThemeIds.some((id) => typeof id === 'string' && id.startsWith('saved-'));
  const colorThemeReady = configLayersReady && (!needsSavedThemeRegistry || savedThemesLoaded);
  const colorThemeBridgeReady =
    configLayersReady && (!needsSavedThemeRegistry || savedThemesLoaded || savedThemesLoadError);
  const selection = resolveColorThemeSelection(merged?.appearance, themes);
  const slotMode = resolveModePreference(themeValue, systemPrefersDark);
  const activePalette = colorThemeEnabled ? selection[slotMode] : 'default';
  const effectiveMode =
    activePalette === 'custom'
      ? customThemeKind(resolveCustomScheme(customSeed))
      : (colorThemeMode(activePalette, themes) ?? themeValue);
  useApplyConfigTheme(colorThemeReady ? effectiveMode : undefined);
  useApplyConfigColorTheme({
    selection,
    modePreference: themeValue,
    slotMode,
    customSeed,
    themes,
    enabled: colorThemeEnabled,
    ready: colorThemeReady,
  });
  useApplyConfigLanguage({
    preference: merged?.appearance?.language,
    userConfigSynced: userState?.synced ?? false,
  });

  useLanguageBridge(
    typeof window !== 'undefined' ? window.okDesktop : undefined,
    merged?.appearance?.language,
    userState?.synced ?? false,
  );

  const activeRuntimeScheme = activePalette.startsWith('saved-')
    ? themes.find((theme) => theme.id === activePalette)?.scheme
    : undefined;
  const runtimeSchemeKey =
    activePalette === 'custom'
      ? JSON.stringify(customSeed ?? null)
      : activeRuntimeScheme
        ? JSON.stringify(activeRuntimeScheme)
        : '';
  const themeBridgeMode =
    colorThemeBridgeReady && !colorThemeReady && typeof document !== 'undefined'
      ? document.documentElement.classList.contains('dark')
        ? 'dark'
        : 'light'
      : (effectiveMode ?? 'system');
  useThemeBridge(
    colorThemeBridgeReady && typeof window !== 'undefined' ? window.okDesktop : undefined,
    colorThemeBridgeReady ? themeBridgeMode : undefined,
    `${activePalette}:${runtimeSchemeKey}`,
  );

  const value: ConfigContextValue = {
    userBinding: userState?.binding ?? null,
    userSynced: userState?.synced ?? false,
    projectBinding: projectState?.binding ?? null,
    projectLocalBinding: projectLocalState?.binding ?? null,
    okignoreBinding: okignoreState?.binding ?? null,
    okignoreSynced: okignoreState?.synced ?? false,
    userConfig: userState?.config ?? null,
    projectConfig: projectState?.config ?? null,
    projectSynced: projectState?.synced ?? false,
    projectLocalConfig: projectLocalState?.config ?? null,
    projectLocalSynced: projectLocalState?.synced ?? false,
    merged,
  };

  return <ConfigContext value={value}>{children}</ConfigContext>;
}

export function ConfigProvider(props: { collabUrl: string | null; children: ReactNode }) {
  return (
    <SavedThemesProvider>
      <ConfigProviderBody {...props} />
    </SavedThemesProvider>
  );
}
