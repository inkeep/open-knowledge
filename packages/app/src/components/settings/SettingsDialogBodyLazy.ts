import { lazyWithPreload } from '@/lib/lazy-with-preload';

export const SettingsDialogBodyLazy = lazyWithPreload(() =>
  import('./SettingsDialogBody').then((m) => ({ default: m.SettingsDialogBody })),
);

export async function preloadSettingsOnIntent(): Promise<void> {
  await SettingsDialogBodyLazy.preload()
    .then(() => import('./SettingsDialogBody'))
    .then((m) => m.preloadPreferencesSection())
    .catch(() => {});
}
