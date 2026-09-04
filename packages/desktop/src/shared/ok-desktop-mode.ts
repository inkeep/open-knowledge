import type { OkDesktopConfig } from './bridge-contract.ts';

export function resolveOkDesktopMode(raw: string | undefined): OkDesktopConfig['mode'] {
  if (raw === 'navigator') return 'navigator';
  if (raw === 'terminal') return 'terminal';
  if (raw === 'note') return 'note';
  return 'editor';
}
