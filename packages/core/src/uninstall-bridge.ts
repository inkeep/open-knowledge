export interface UninstallProjectRow {
  readonly path: string;
  readonly open: boolean;
  readonly recent: boolean;
  readonly running: boolean;
}

export interface UninstallNoticeScreen {
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly footnote?: string;
  readonly log?: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly danger?: boolean;
}

export type UninstallScreenSpec =
  | { readonly kind: 'picker'; readonly projects: readonly UninstallProjectRow[] }
  | { readonly kind: 'survey' }
  | { readonly kind: 'progress' }
  | { readonly kind: 'notice'; readonly notice: UninstallNoticeScreen };

export type UninstallIntent =
  | { readonly kind: 'picker-confirm'; readonly selectedIndexes: readonly number[] }
  | { readonly kind: 'picker-cancel' }
  | {
      readonly kind: 'survey-send';
      readonly reason?: string;
      readonly note?: string;
      readonly email?: string;
    }
  | { readonly kind: 'survey-skip' }
  | { readonly kind: 'notice-confirm' }
  | { readonly kind: 'notice-cancel' };

export type UninstallDispatchRequest = { readonly kind: 'ready' } | UninstallIntent;

export type UninstallDispatchResult =
  | { readonly kind: 'screen'; readonly screen: UninstallScreenSpec }
  | { readonly kind: 'accepted' }
  | { readonly kind: 'refused'; readonly reason: 'unknown-window' | 'invalid-intent' };

export interface OkUninstallBridge {
  ready(): Promise<UninstallDispatchResult>;
  send(intent: UninstallIntent): Promise<UninstallDispatchResult>;
}
