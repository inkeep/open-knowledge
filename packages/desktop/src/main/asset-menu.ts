import { menuLabelForPlatform, NATIVE_MENU_LABELS } from '@inkeep/open-knowledge-core';
import type { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
import { type MenuTranslator, translateEnglish } from './menu-translator.ts';

type AssetMenuKind = 'asset' | 'wiki-link' | 'image';

interface AssetMenuActions {
  readonly reveal: () => void | Promise<void>;
  readonly openInDefault: () => void | Promise<void>;
  readonly copyLink: () => void | Promise<void>;
}

export function revealMenuLabel(platform: NodeJS.Platform): string {
  return menuLabelForPlatform('revealInFinder', platform);
}

interface BuildAssetMenuTemplateParams {
  readonly kind: AssetMenuKind;
  readonly platform: NodeJS.Platform;
  readonly actions: AssetMenuActions;
  readonly translate?: MenuTranslator;
}

export function buildAssetMenuTemplate(
  params: BuildAssetMenuTemplateParams,
): MenuItemConstructorOptions[] {
  const { platform, actions } = params;
  const translate = params.translate ?? translateEnglish;
  return [
    {
      label: translate(revealMenuLabel(platform)),
      click: () => {
        void actions.reveal();
      },
    },
    {
      label: translate(NATIVE_MENU_LABELS.openInDefaultApp),
      click: () => {
        void actions.openInDefault();
      },
    },
    { type: 'separator' },
    {
      label: translate(NATIVE_MENU_LABELS.copyLink),
      click: () => {
        void actions.copyLink();
      },
    },
  ];
}

interface PopAssetMenuDeps {
  readonly Menu: Pick<typeof Menu, 'buildFromTemplate'>;
  readonly window: BrowserWindow;
}

export function popAssetMenu(deps: PopAssetMenuDeps, params: BuildAssetMenuTemplateParams): void {
  if (deps.window.isDestroyed()) return;
  const template = buildAssetMenuTemplate(params);
  deps.Menu.buildFromTemplate(template).popup({ window: deps.window });
}
