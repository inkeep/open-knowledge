import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  activateAssetLink,
  handleChipLinkClick,
  toInternalHashHref,
} from './internal-link-helpers';

const originalWindow = globalThis.window;

/**
 * Covers the prop-panel destination click wiring shared by
 * InternalLinkPropPanel + WikiLinkPropPanel. The regression surface is the
 * preventDefault dedup (so the JS nav and the native <a href> don't both
 * fire) and the same-tab-only close.
 */
describe('handleChipLinkClick', () => {
  function makeEvent(overrides: Partial<{ metaKey: boolean; ctrlKey: boolean }> = {}) {
    return {
      metaKey: false,
      ctrlKey: false,
      preventDefault: mock(() => {}),
      ...overrides,
    };
  }

  it('bare click: navigates same-tab, suppresses native nav, closes the panel', () => {
    const event = makeEvent();
    const onNavigate = mock((_newTab: boolean) => true);
    const onClose = mock(() => {});

    handleChipLinkClick(event, onNavigate, onClose);

    expect(onNavigate).toHaveBeenCalledWith(false);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cmd/Ctrl click: navigates new-tab, suppresses native nav, leaves panel open', () => {
    for (const mod of [{ metaKey: true }, { ctrlKey: true }] as const) {
      const event = makeEvent(mod);
      const onNavigate = mock((_newTab: boolean) => true);
      const onClose = mock(() => {});

      handleChipLinkClick(event, onNavigate, onClose);

      expect(onNavigate).toHaveBeenCalledWith(true);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    }
  });

  it('handler declines (non-navigable / unsafe scheme): native <a href> proceeds, panel stays open', () => {
    const event = makeEvent();
    const onNavigate = mock((_newTab: boolean) => false);
    const onClose = mock(() => {});

    handleChipLinkClick(event, onNavigate, onClose);

    expect(onNavigate).toHaveBeenCalledWith(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * The asset-link activation routing shared by `internal-link.ts` +
 * `wiki-link-embed.ts`. Regression surface: bare click must navigate to the
 * in-app asset preview (sidebar parity) rather than OS-delegate, while
 * Cmd/Ctrl/middle-click keeps the OS-delegation escape hatch. Deps are
 * injected so the branching is asserted without touching `window` /
 * `dispatchAssetClick`'s real Electron+web fallback.
 */
describe('activateAssetLink', () => {
  const params = {
    url: './report.html',
    projectRelPath: 'docs/report.html',
    ext: 'html',
    title: 'report.html',
  };

  it('bare click navigates to the asset preview and does NOT OS-delegate', () => {
    const navigate = mock((_assetPath: string) => {});
    const dispatch = mock(async () => {});

    activateAssetLink({ ...params, newTab: false }, { navigate, dispatch });

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('docs/report.html');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('Cmd/Ctrl/middle-click OS-delegates (forceOsDelegation) and does NOT navigate', () => {
    const navigate = mock((_assetPath: string) => {});
    const dispatch = mock(async () => {});

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

  // The cases above inject both deps to isolate the branching. This one
  // exercises the REAL default `navigate` (the module-private
  // `navigateToAssetPreview`) against a stubbed `window`, so a future change
  // that wires the default to the wrong helper — e.g. doc hash nav instead
  // of the `#/__asset__/…` asset hash — fails here at unit tier rather than
  // only at the E2E. `window` stub mirrors `documents-events.test.ts`.
  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
      writable: true,
    });
  });

  it('bare click with no injected deps assigns the canonical asset hash via the default navigate', () => {
    const assign = mock((_url: string) => {});
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
