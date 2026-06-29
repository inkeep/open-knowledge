
import type { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';

type AssetMenuKind = 'asset' | 'wiki-link' | 'image';

interface AssetMenuActions {
  readonly reveal: () => void | Promise<void>;
  readonly openInDefault: () => void | Promise<void>;
  readonly copyLink: () => void | Promise<void>;
}

export function revealMenuLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'Reveal in Finder';
  if (platform === 'win32') return 'Show in Explorer';
  return 'Open in file manager';
}

interface BuildAssetMenuTemplateParams {
  readonly kind: AssetMenuKind;
  readonly platform: NodeJS.Platform;
  readonly actions: AssetMenuActions;
}

export function buildAssetMenuTemplate(
  params: BuildAssetMenuTemplateParams,
): MenuItemConstructorOptions[] {
  const { platform, actions } = params;
  return [
    {
      label: revealMenuLabel(platform),
      click: () => {
        void actions.reveal();
      },
    },
    {
      label: 'Open in default app',
      click: () => {
        void actions.openInDefault();
      },
    },
    { type: 'separator' },
    {
      label: 'Copy link',
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
