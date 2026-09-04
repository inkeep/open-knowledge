import { startTransition, useEffect, useState } from 'react';
import {
  isEditableShortcutTarget,
  matchesKeyboardShortcut,
  type ShortcutEventLike,
} from '@/lib/keyboard-shortcuts';

export const SETTINGS_OPEN_HASH = '#settings';

function settingsSectionHash(sectionId: string): string {
  return `#settings/${sectionId}`;
}

const SECTION_INTENT_EVENT = 'open-knowledge:settings-section-intent';

export function subscribeToSettingsSection(onSection: (sectionId: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (event: Event) => {
    const { detail } = event as CustomEvent<string>;
    if (typeof detail === 'string' && detail.length > 0) onSection(detail);
  };
  window.addEventListener(SECTION_INTENT_EVENT, handler);
  return () => window.removeEventListener(SECTION_INTENT_EVENT, handler);
}

function openSettingsSection(sectionId: string): void {
  if (typeof window === 'undefined') return;
  const target = settingsSectionHash(sectionId);
  if (isSettingsHashOpen(window.location.hash)) {
    window.history.replaceState(null, '', target);
    window.dispatchEvent(new CustomEvent(SECTION_INTENT_EVENT, { detail: sectionId }));
    return;
  }
  if (window.location.hash !== target) window.location.hash = target;
}

const CONFIGURE_AGENTS_SECTION = 'configure-agents';

export function openAgentSettings(): void {
  openSettingsSection(CONFIGURE_AGENTS_SECTION);
}

const PROJECT_SYNC_SECTION = 'sync';

let pendingSyncAdvanced = false;

export function consumeSyncAdvancedIntent(): boolean {
  const pending = pendingSyncAdvanced;
  pendingSyncAdvanced = false;
  return pending;
}

export function openSyncSettings(opts?: { advanced?: boolean }): void {
  if (opts?.advanced === true) pendingSyncAdvanced = true;
  openSettingsSection(PROJECT_SYNC_SECTION);
}

const PROJECT_PLUGINS_SECTION = 'plugins-manage';

export function openProjectPluginsSettings(): void {
  openSettingsSection(PROJECT_PLUGINS_SECTION);
}

export function pluginSettingsSectionId(pluginId: string): string {
  return `plugin:${pluginId}`;
}

export function openPluginSettings(pluginId: string): void {
  openSettingsSection(pluginSettingsSectionId(pluginId));
}

interface SettingsRouteState {
  open: boolean;
  section: string | null;
  close: () => void;
}

export function isSettingsShortcut(e: ShortcutEventLike): boolean {
  if (isEditableShortcutTarget(e.target)) return false;
  return matchesKeyboardShortcut(e, 'settings');
}

export function isSettingsHashOpen(hash: string): boolean {
  const cleaned = hash.replace(/^#/, '');
  if (cleaned === 'settings') return true;
  return cleaned.startsWith('settings/') && cleaned.length > 'settings/'.length;
}

export function settingsHashSection(hash: string): string | null {
  const cleaned = hash.replace(/^#/, '');
  if (!cleaned.startsWith('settings/')) return null;
  const section = cleaned.slice('settings/'.length);
  return section.length > 0 ? section : null;
}

function readCurrentHash(): string {
  if (typeof window === 'undefined') return '';
  return window.location.hash;
}

export function useSettingsRoute(): SettingsRouteState {
  const [open, setOpen] = useState<boolean>(() => isSettingsHashOpen(readCurrentHash()));
  const [section, setSection] = useState<string | null>(() =>
    settingsHashSection(readCurrentHash()),
  );

  useEffect(() => {
    const onHashChange = () => {
      startTransition(() => {
        const hash = readCurrentHash();
        setOpen(isSettingsHashOpen(hash));
        setSection(settingsHashSection(hash));
      });
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const close = () => {
    if (typeof window === 'undefined') return;
    if (!isSettingsHashOpen(readCurrentHash())) return;
    window.history.back();
  };

  return { open, section, close };
}
