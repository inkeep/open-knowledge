import type { RowPresence } from './agent-connection-status';

export type RowAction =
  | { readonly kind: 'connect' }
  | { readonly kind: 'manage' }
  | { readonly kind: 'remove' }
  | { readonly kind: 'install'; readonly url: string }
  | { readonly kind: 'setup-doc'; readonly slug: string }
  | { readonly kind: 'none' };

export interface RowActionInput {
  readonly enabled: boolean;
  readonly installedCount: number;
  readonly presence: RowPresence;
  readonly configurable: boolean;
  readonly setupDocSlug: string | null;
  readonly installUrl?: string | null;
}

export function rowActionFor(input: RowActionInput): RowAction {
  const { enabled, installedCount, presence, configurable, setupDocSlug, installUrl } = input;
  const installed = installedCount > 0;
  const absent = presence === 'absent';

  const docAction = (): RowAction =>
    setupDocSlug === null ? { kind: 'none' } : { kind: 'setup-doc', slug: setupDocSlug };

  if (absent && installed) return { kind: 'remove' };
  if (absent) {
    return installUrl == null || installUrl === ''
      ? docAction()
      : { kind: 'install', url: installUrl };
  }
  if (!configurable) return installed ? { kind: 'remove' } : docAction();
  if (enabled) return installed ? { kind: 'manage' } : { kind: 'connect' };
  return installed ? { kind: 'remove' } : { kind: 'none' };
}
