import { classifyMarkdownHref } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateAssetLink,
  buildCurrentRelativeMarkdownHref,
  handleChipLinkClick,
  navigateToMarkdownTarget,
  toInternalHashHref,
} from './internal-link-helpers';

const originalWindow = globalThis.window;

describe('handleChipLinkClick', () => {
  function makeEvent(overrides: Partial<{ metaKey: boolean; ctrlKey: boolean }> = {}) {
    return {
      metaKey: false,
      ctrlKey: false,
      preventDefault: vi.fn(() => {}),
      ...overrides,
    };
  }

  it('bare click: navigates same-tab, suppresses native nav, closes the panel', () => {
    const event = makeEvent();
    const onNavigate = vi.fn((_newTab: boolean) => true);
    const onClose = vi.fn(() => {});

    handleChipLinkClick(event, onNavigate, onClose);

    expect(onNavigate).toHaveBeenCalledWith(false);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cmd/Ctrl click: navigates new-tab, suppresses native nav, leaves panel open', () => {
    for (const mod of [{ metaKey: true }, { ctrlKey: true }] as const) {
      const event = makeEvent(mod);
      const onNavigate = vi.fn((_newTab: boolean) => true);
      const onClose = vi.fn(() => {});

      handleChipLinkClick(event, onNavigate, onClose);

      expect(onNavigate).toHaveBeenCalledWith(true);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    }
  });

  it('handler declines (non-navigable / unsafe scheme): native <a href> proceeds, panel stays open', () => {
    const event = makeEvent();
    const onNavigate = vi.fn((_newTab: boolean) => false);
    const onClose = vi.fn(() => {});

    handleChipLinkClick(event, onNavigate, onClose);

    expect(onNavigate).toHaveBeenCalledWith(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('activateAssetLink', () => {
  const params = {
    url: './report.html',
    projectRelPath: 'docs/report.html',
    ext: 'html',
    title: 'report.html',
  };

  it('bare click navigates to the asset preview and does NOT OS-delegate', () => {
    const navigate = vi.fn((_assetPath: string) => {});
    const dispatch = vi.fn(async () => {});

    activateAssetLink({ ...params, newTab: false }, { navigate, dispatch });

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('docs/report.html');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('Cmd/Ctrl/middle-click OS-delegates (forceOsDelegation) and does NOT navigate', () => {
    const navigate = vi.fn((_assetPath: string) => {});
    const dispatch = vi.fn(async () => {});

    activateAssetLink({ ...params, newTab: true }, { navigate, dispatch });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      url: './report.html',
      projectRelPath: 'docs/report.html',
      ext: 'html',
      title: 'report.html',
      forceOsDelegation: true,
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
      writable: true,
    });
  });

  it('bare click with no injected deps assigns the canonical asset hash via the default navigate', () => {
    const assign = vi.fn((_url: string) => {});
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { assign } },
      writable: true,
    });

    activateAssetLink({ ...params, newTab: false });

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('#/__asset__/docs/report.html');
  });
});

describe('navigateToMarkdownTarget — external routing', () => {
  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
      writable: true,
    });
  });

  function stubWindow(overrides: { okDesktop?: unknown; open?: unknown }): void {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { hash: '' }, open: overrides.open, okDesktop: overrides.okDesktop },
      writable: true,
    });
  }

  it('desktop (bridge present): routes through okDesktop.shell.openExternal, NOT window.open', () => {
    const openExternal = vi.fn(async (_url: string) => {});
    const openWindow = vi.fn(() => null);
    stubWindow({ okDesktop: { shell: { openExternal } }, open: openWindow });

    navigateToMarkdownTarget({ kind: 'external', url: 'https://example.com/watch' });

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/watch');
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('web (no bridge): falls back to window.open with the new-tab + noopener features', () => {
    const openWindow = vi.fn(() => null);
    stubWindow({ okDesktop: undefined, open: openWindow });

    navigateToMarkdownTarget({ kind: 'external', url: 'https://example.com/web' });

    expect(openWindow).toHaveBeenCalledTimes(1);
    expect(openWindow).toHaveBeenCalledWith(
      'https://example.com/web',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('unsafe scheme is refused: neither the bridge nor window.open fires', () => {
    const openExternal = vi.fn(async (_url: string) => {});
    const openWindow = vi.fn(() => null);
    stubWindow({ okDesktop: { shell: { openExternal } }, open: openWindow });

    navigateToMarkdownTarget({ kind: 'external', url: 'javascript:alert(1)' });

    expect(openExternal).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });
});

describe('toInternalHashHref', () => {
  it('builds standard fragment anchors for document sections', () => {
    expect(toInternalHashHref({ docName: 'docs/guide', anchor: 'install' })).toBe(
      '#/docs/guide#install',
    );
  });

  it('encodes section anchors', () => {
    expect(toInternalHashHref({ docName: 'docs/guide', anchor: 'hello world' })).toBe(
      '#/docs/guide#hello%20world',
    );
  });

  it('omits the fragment for null anchors', () => {
    expect(toInternalHashHref({ docName: 'docs/guide', anchor: null })).toBe('#/docs/guide');
  });
});

describe('buildCurrentRelativeMarkdownHref — popover field round-trip', () => {
  it('emits an href that classifies straight back to the picked doc', () => {
    const href = buildCurrentRelativeMarkdownHref('notes/Agent Memory', null, '#/notes/index');
    expect(href).toBe('./Agent%20Memory.md');
    expect(classifyMarkdownHref(href, 'notes/index')).toEqual({
      kind: 'doc',
      docName: 'notes/Agent Memory',
      anchor: null,
    });
  });

  it('shows the decoded name on the friendly display surface', () => {
    const classified = classifyMarkdownHref('./Agent%20Memory.md', 'notes/index');
    expect(classified?.kind === 'doc' && classified.docName).toBe('notes/Agent Memory');
  });
});
