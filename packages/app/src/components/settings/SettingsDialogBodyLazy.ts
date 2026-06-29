
import { lazyWithPreload } from '@/lib/lazy-with-preload';

export const SettingsDialogBodyLazy = lazyWithPreload(() =>
  import('./SettingsDialogBody').then((m) => ({ default: m.SettingsDialogBody })),
);
