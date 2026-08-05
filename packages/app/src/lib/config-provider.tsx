/**
 * Top-level ConfigProvider.
 *
 * Holds the user-global + project + project-local `bindConfigDoc` instances
 * for the entire app session. Exposes the three bindings + a merged-config
 * view (project-local > project > user, modulated by the per-field
 * `defaultScope` ladder defined in core schema metadata) via React context.
 * Receives `collabUrl` as a prop from its App-tier host (see App.tsx); mounted
 * above everything that consumes config so chrome controls + Settings pane share
 * state.
 *
 * `projectLocalSynced` is the gate signal for "we have observed the
 * project-local Y.Text content at least once" — distinct from "we have
 * data" because empty content is also a valid synced state. Used by the
 * auto-sync onboarding modal so the dialog doesn't flash during hydration.
 *
 * Drives the next-themes bridge in one place: it watches
 * `mergedConfig.appearance.theme` (the Settings pane, an external file edit
 * picked up by the chokidar watcher, or another window) and delegates to
 * `useApplyConfigTheme`, which flips next-themes — see that hook for the
 * cross-window flicker guard.
 *
 * `appearance.theme` is dual-track: localStorage 'ok-theme-v1' stays as
 * the FOUC cache; config.yml is authoritative once set. Settings-pane
 * writes flow through `userBinding.patch()` so the two stay coherent.
 *
 * Drives the interface language the same way, via `useApplyConfigLanguage`.
 * That one is applied imperatively onto the Lingui singleton rather than
 * handed down as a prop, because `I18nProvider` is mounted above this
 * provider — see the hook.
 */
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

// Structured JSON logs make connection failures queryable by the existing
// `ok-provider-*` log stream that `provider-pool.ts` already emits — without
// these callbacks the bare config providers had zero operational signal on
// disconnect, leaving any future Hocuspocus rejection path invisible until
// it reached the global `unhandledrejection` handler (see
// `rejection-loop-guard-plugin.ts`). The structural CloseEvent type below
// matches both the DOM `CloseEvent` and the narrower one Hocuspocus's
// `onDisconnectParameters` / `onCloseParameters` re-export from
// `@hocuspocus/common`.
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
    // Claim the server epoch so a stale reconnect after a respawn is rejected
    // at `onAuthenticate` BEFORE any Yjs sync — preventing the ghost-item
    // union-merge that otherwise duplicates config content. Recovery
    // is the epoch-keyed rebuild in `ConfigProvider`'s effect, not a client
    // `onAuthenticationFailed` (these docs have no IDB to clear).
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
    // See makeBinding: epoch claim → pre-sync reject on respawn → no union-merge.
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

export function ConfigProvider({
  collabUrl,
  children,
}: {
  collabUrl: string | null;
  children: ReactNode;
}) {
  // Re-keying the provider effect on the server epoch is the config-doc recovery
  // from a server respawn: an epoch change disposes + recreates the bindings
  // (fresh Y.Doc) so they re-sync clean instead of union-merging the retained
  // doc with the freshly-disk-seeded server doc. The epoch is fed by
  // `refreshServerInfo` on every `__system__` reconnect; `SystemDocSubscriber`
  // (which owns `__system__`) co-mounts with this provider at the App level, so
  // the epoch-delivery channel stays alive as long as these providers do.
  const serverInstanceId = useServerInstanceId();
  // The OS appearance, tracked live and independently of the active theme —
  // next-themes keeps `systemTheme` current from its own media-query listener
  // even while `theme` is forced to a palette's variant, which is exactly the
  // signal `appearance.theme: 'system'` needs to choose a palette slot.
  // Provider-less harnesses get `undefined`, i.e. light.
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
        prev?.binding === userScoped.binding ? { ...prev, synced: true } : prev,
      );
    });
    const unsubProject = projectScoped.binding.subscribe((next) => {
      setProjectState((prev) =>
        prev?.binding === projectScoped.binding ? { ...prev, config: next } : prev,
      );
    });
    const unsubProjectSynced = projectScoped.binding.subscribeSynced(() => {
      setProjectState((prev) =>
        prev?.binding === projectScoped.binding ? { ...prev, synced: true } : prev,
      );
    });
    const unsubProjectLocal = projectLocalScoped.binding.subscribe((next) => {
      setProjectLocalState((prev) =>
        prev?.binding === projectLocalScoped.binding ? { ...prev, config: next } : prev,
      );
    });
    const unsubProjectLocalSynced = projectLocalScoped.binding.subscribeSynced(() => {
      setProjectLocalState((prev) =>
        prev?.binding === projectLocalScoped.binding ? { ...prev, synced: true } : prev,
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
      // Wrap each cleanup so a throw from one provider's dispose/destroy doesn't
      // leave the others' WebSockets open — mirrors the pool's destroy guard.
      // Runs on every epoch-change rebuild, not just unmount.
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
  // The Themes plugin toggle. Disabled means the effect stops: the default
  // palette applies and the saved pair is ignored (not cleared — it comes back
  // when the plugin is re-enabled). Default on (absent → enabled).
  const colorThemeEnabled = merged?.appearance?.colorThemeEnabled !== false;
  // One palette per mode. `slotMode` picks between them and is derived from the
  // user's OWN preference — `appearance.theme`, with the OS deciding for
  // 'system' — never from next-themes' resolved value. That distinction is
  // load-bearing: a palette still forces its own variant below, so feeding the
  // resolved value back in would let a cross-variant pick (a dark scheme chosen
  // as the light palette) flip the app into the other slot, then back.
  const selection = resolveColorThemeSelection(merged?.appearance);
  const slotMode = resolveModePreference(themeValue, systemPrefersDark);
  const activePalette = colorThemeEnabled ? selection[slotMode] : 'default';
  // The applied palette takes over the appearance: it forces next-themes into
  // its own light/dark mode so Tailwind `dark:` variants resolve against the
  // themed tokens. `custom` derives its mode from its scheme's variant.
  // `default` (and a disabled Themes plugin) carries no palette, so the mode
  // preference passes through untouched — including 'system', which is what
  // keeps the palette following the OS. We never patch `appearance.theme` here.
  const effectiveMode =
    activePalette === 'custom'
      ? customThemeKind(resolveCustomScheme(customSeed))
      : (colorThemeMode(activePalette) ?? themeValue);
  // Bridge the effective mode from the merged config into next-themes app-wide.
  // The hook owns the dependency discipline that prevents a cross-window
  // light/dark flicker storm across open project windows — see
  // `useApplyConfigTheme`.
  useApplyConfigTheme(effectiveMode);
  // Apply the palette overlay (`data-color-theme` attribute + FOUC caches; for
  // `custom`, the runtime `<style>` built from the scheme). Honors the plugin
  // toggle: disabled clears the overlay and its FOUC caches.
  useApplyConfigColorTheme({
    selection,
    modePreference: themeValue,
    slotMode,
    customSeed,
    enabled: colorThemeEnabled,
  });
  // Bridge the interface language into the Lingui singleton. `'system'` and an
  // absent value are resolved against the browser inside the hook, at
  // activation — the config keeps the unresolved intent so the preference goes
  // on following the OS. `userSynced` is what tells an absent preference apart
  // from a user layer that has not loaded yet; see the hook for why that
  // distinction is worth carrying.
  useApplyConfigLanguage({
    preference: merged?.appearance?.language,
    userConfigSynced: userState?.synced ?? false,
  });

  // And push the same unresolved value to Electron main, which rebuilds the
  // native menu bar in it. Separate from the hook above because the two act on
  // different surfaces from one source: the renderer activates a catalog, main
  // re-resolves and re-renders its own menu template.
  useLanguageBridge(
    typeof window !== 'undefined' ? window.okDesktop : undefined,
    merged?.appearance?.language,
    userState?.synced ?? false,
  );

  // Push `appearance.theme` to Electron main's `nativeTheme.themeSource`
  // and signal the cold-launch show-gate via the shared `useThemeBridge`
  // hook. Same hook drives `NavigatorApp` so both window kinds release
  // the gate the same way; theme value comes from the CRDT here, from
  // `next-themes` in the launcher window.
  //
  // Fall back to `'system'` when the merged config has no theme. The Zod
  // `appearance.theme` field is `.optional()` with no `.default()`, so
  // `themeValue` is `undefined` on every fresh install AND during the
  // brief window before `merged` becomes non-null. Without this fallback,
  // `useThemeBridge` would early-return on the invalid value,
  // `signalThemeApplied` would never fire, and the show-gate's 5 s safety
  // timeout would hold the editor window blank for 5 s on every new
  // install. `'system'` matches the main-process bootstrap default
  // (`runBootstrap` sets `nativeTheme.themeSource = 'system'`) and
  // `next-themes`' `defaultTheme="system"`, so chrome reflects the OS
  // appearance from frame 1 and the gate releases promptly.
  //
  // The third argument re-fires the signal on a palette switch (not just a
  // light/dark flip) so the OS-drawn chrome tracks the active color theme. It
  // serializes the custom seed too — editing a custom scheme's `--sidebar`
  // should repaint the titlebar live.
  useThemeBridge(
    typeof window !== 'undefined' ? window.okDesktop : undefined,
    effectiveMode ?? 'system',
    `${activePalette}:${activePalette === 'custom' ? JSON.stringify(customSeed ?? null) : ''}`,
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
