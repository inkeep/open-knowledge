import { menuLabelForPlatform, NATIVE_MENU_LABELS } from '@inkeep/open-knowledge-core';
import type { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
import { getLogger } from './desktop-logger.ts';
import { type MenuTranslator, translateEnglish } from './menu-translator.ts';

type AssetMenuKind = 'asset' | 'wiki-link' | 'image';

interface AssetMenuActions {
  readonly reveal: () => void | Promise<void>;
  readonly openInDefault: () => void | Promise<void>;
  readonly copyLink: () => void | Promise<void>;
}

function runAssetMenuAction(name: keyof AssetMenuActions, action: () => void | Promise<void>) {
  const report = (err: unknown) => {
    getLogger('asset-context-menu').warn({ err, action: name }, 'asset menu action failed');
  };
  try {
    void Promise.resolve(action()).catch(report);
  } catch (err) {
    report(err);
  }
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
        runAssetMenuAction('reveal', actions.reveal);
      },
    },
    {
      label: translate(NATIVE_MENU_LABELS.openInDefaultApp),
      click: () => {
        runAssetMenuAction('openInDefault', actions.openInDefault);
      },
    },
    { type: 'separator' },
    {
      label: translate(NATIVE_MENU_LABELS.copyLink),
      click: () => {
        runAssetMenuAction('copyLink', actions.copyLink);
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
