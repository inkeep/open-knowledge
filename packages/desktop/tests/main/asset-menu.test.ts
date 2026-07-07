/**
 * Unit tests for asset context-menu template + pop dispatch. Covers
 * platform-specific Reveal label, action dispatch wiring, and the pop
 * integration with an injected Menu ctor.
 */

import { describe, expect, mock, test } from 'bun:test';
import type { BrowserWindow, Menu, MenuItemConstructorOptions } from 'electron';
import {
  buildAssetMenuTemplate,
  popAssetMenu,
  revealMenuLabel,
} from '../../src/main/asset-menu.ts';

describe('revealMenuLabel — platform-specific Reveal text', () => {
  test('macOS → Reveal in Finder', () => {
    expect(revealMenuLabel('darwin')).toBe('Reveal in Finder');
  });
  test('Windows → Show in Explorer', () => {
    expect(revealMenuLabel('win32')).toBe('Show in Explorer');
  });
  test('Linux → Open in file manager', () => {
    expect(revealMenuLabel('linux')).toBe('Open in file manager');
  });
});

describe('buildAssetMenuTemplate', () => {
  function makeActions() {
    return {
      reveal: mock(() => {}),
      openInDefault: mock(() => {}),
      copyLink: mock(() => {}),
    };
  }

  test('emits [Reveal, Open in default app, separator, Copy link]', () => {
    const actions = makeActions();
    const template = buildAssetMenuTemplate({
      kind: 'asset',
      platform: 'darwin',
      actions,
    });
    expect(template).toHaveLength(4);
    expect(template[0]?.label).toBe('Reveal in Finder');
    expect(template[1]?.label).toBe('Open in default app');
    expect(template[2]?.type).toBe('separator');
    expect(template[3]?.label).toBe('Copy link');
  });

  test('Reveal entry fires the reveal action', () => {
    const actions = makeActions();
    const template = buildAssetMenuTemplate({
      kind: 'asset',
      platform: 'darwin',
      actions,
    });
    // biome-ignore lint/suspicious/noExplicitAny: test invokes the click callback
    (template[0] as any).click();
    expect(actions.reveal).toHaveBeenCalledTimes(1);
    expect(actions.openInDefault).not.toHaveBeenCalled();
    expect(actions.copyLink).not.toHaveBeenCalled();
  });

  test('Open-in-default fires the openInDefault action', () => {
    const actions = makeActions();
    const template = buildAssetMenuTemplate({
      kind: 'asset',
      platform: 'darwin',
      actions,
    });
    // biome-ignore lint/suspicious/noExplicitAny: test invokes the click callback
    (template[1] as any).click();
    expect(actions.openInDefault).toHaveBeenCalledTimes(1);
  });

  test('Copy link fires the copyLink action', () => {
    const actions = makeActions();
    const template = buildAssetMenuTemplate({
      kind: 'asset',
      platform: 'darwin',
      actions,
    });
    // biome-ignore lint/suspicious/noExplicitAny: test invokes the click callback
    (template[3] as any).click();
    expect(actions.copyLink).toHaveBeenCalledTimes(1);
  });

  test('wiki-link kind produces the same template shape (uniform UX)', () => {
    const wikiActions = makeActions();
    const assetActions = makeActions();
    const wikiTpl = buildAssetMenuTemplate({
      kind: 'wiki-link',
      platform: 'darwin',
      actions: wikiActions,
    });
    const assetTpl = buildAssetMenuTemplate({
      kind: 'asset',
      platform: 'darwin',
      actions: assetActions,
    });
    expect(wikiTpl.map((e) => e.label ?? e.type)).toEqual(assetTpl.map((e) => e.label ?? e.type));
  });
});

describe('popAssetMenu', () => {
  test('builds template + pops via injected Menu ctor', () => {
    const popup = mock((_: unknown) => {});
    const menuInstance = { popup } as unknown as ReturnType<typeof Menu.buildFromTemplate>;
    const buildFromTemplate = mock((_: MenuItemConstructorOptions[]) => menuInstance);
    const fakeWindow = { id: 42, isDestroyed: () => false } as unknown as BrowserWindow;

    popAssetMenu(
      {
        Menu: { buildFromTemplate },
        window: fakeWindow,
      },
      {
        kind: 'asset',
        platform: 'darwin',
        actions: {
          reveal: () => {},
          openInDefault: () => {},
          copyLink: () => {},
        },
      },
    );

    expect(buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(popup).toHaveBeenCalledWith({ window: fakeWindow });
  });

  test('destroyed window → no build, no popup (right-click racing window close)', () => {
    const popup = mock((_: unknown) => {});
    const menuInstance = { popup } as unknown as ReturnType<typeof Menu.buildFromTemplate>;
    const buildFromTemplate = mock((_: MenuItemConstructorOptions[]) => menuInstance);
    const fakeWindow = { id: 42, isDestroyed: () => true } as unknown as BrowserWindow;

    popAssetMenu(
      {
        Menu: { buildFromTemplate },
        window: fakeWindow,
      },
      {
        kind: 'asset',
        platform: 'darwin',
        actions: {
          reveal: () => {},
          openInDefault: () => {},
          copyLink: () => {},
        },
      },
    );

    expect(buildFromTemplate).not.toHaveBeenCalled();
    expect(popup).not.toHaveBeenCalled();
  });
});
