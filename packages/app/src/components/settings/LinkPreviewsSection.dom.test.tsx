import type { Config, ConfigBinding } from '@inkeep/open-knowledge-core';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { describedTextOf } from './settings-a11y.test-helper';

type WindowGlobals = { NodeFilter?: typeof NodeFilter };
type GlobalWithDomShims = typeof globalThis &
  WindowGlobals & { window?: WindowGlobals; ResizeObserver?: unknown };
const globalWithDomShims = globalThis as GlobalWithDomShims;
if (
  globalWithDomShims.NodeFilter === undefined &&
  globalWithDomShims.window?.NodeFilter !== undefined
) {
  globalWithDomShims.NodeFilter = globalWithDomShims.window.NodeFilter;
}
if (globalWithDomShims.ResizeObserver === undefined) {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalWithDomShims.ResizeObserver = NoopResizeObserver;
}

let mockProjectLocalConfig: Config | null = null;
let mockProjectLocalSynced = true;
let mockProjectLocalBinding: ConfigBinding | null = null;

vi.doMock('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    userBinding: null,
    userSynced: false,
    projectBinding: null,
    projectLocalBinding: mockProjectLocalBinding,
    okignoreBinding: null,
    okignoreSynced: false,
    userConfig: null,
    projectConfig: null,
    projectLocalConfig: mockProjectLocalConfig,
    projectLocalSynced: mockProjectLocalSynced,
    merged: null,
  }),
}));

const { LinkPreviewsSection } = await import('./LinkPreviewsSection');

function configWithLinkPreviews(enabled: boolean): Config {
  return { linkPreviews: { enabled } } as unknown as Config;
}

function makeBinding(): { binding: ConfigBinding; calls: unknown[] } {
  const calls: unknown[] = [];
  const binding = {
    current: () => ({}),
    patch: (patch: unknown) => {
      calls.push(patch);
      return { ok: true, value: { applied: [], effective: {} } };
    },
    subscribe: () => () => {},
    hasSynced: () => true,
    subscribeSynced: () => () => {},
    dispose: () => {},
  } as unknown as ConfigBinding;
  return { binding, calls };
}

beforeEach(() => {
  mockProjectLocalConfig = null;
  mockProjectLocalSynced = true;
  mockProjectLocalBinding = null;
});

afterEach(() => {
  cleanup();
});

describe('LinkPreviewsSection', () => {
  test('off: switch is unchecked and the body says no requests leave the computer', () => {
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithLinkPreviews(false);

    render(<LinkPreviewsSection />);

    const toggle = screen.getByTestId('settings-link-previews-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('settings-link-previews-body').textContent).toContain(
      'No requests leave this computer',
    );
  });

  test('on: switch is checked and the body discloses the per-hover egress', () => {
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithLinkPreviews(true);

    render(<LinkPreviewsSection />);

    const toggle = screen.getByTestId('settings-link-previews-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('settings-link-previews-body').textContent).toContain(
      'sends its URL to the destination site',
    );
  });

  test('the egress disclosure is announced with the toggle, not just shown beside it', () => {
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithLinkPreviews(true);

    render(<LinkPreviewsSection />);

    expect(describedTextOf('settings-link-previews-toggle')).toContain(
      'sends its URL to the destination site',
    );
  });

  test('toggle is disabled until the project-local binding has synced', () => {
    mockProjectLocalBinding = null;
    mockProjectLocalSynced = false;

    render(<LinkPreviewsSection />);

    expect(
      screen.getByTestId('settings-link-previews-toggle').getAttribute('disabled'),
    ).not.toBeNull();
  });

  test('enabling opens the egress confirm dialog and does NOT write until confirmed', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithLinkPreviews(false);

    render(<LinkPreviewsSection />);

    await user.click(screen.getByTestId('settings-link-previews-toggle'));

    expect(await screen.findByText("This sends the link's address off your machine")).toBeDefined();
    expect(calls.length).toBe(0);

    await user.click(screen.getByTestId('settings-link-previews-confirm-enable'));

    expect(calls).toEqual([{ linkPreviews: { enabled: true } }]);
  });

  test('disabling commits immediately with no confirmation dialog', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithLinkPreviews(true);

    render(<LinkPreviewsSection />);

    await user.click(screen.getByTestId('settings-link-previews-toggle'));

    expect(screen.queryByText("This sends the link's address off your machine")).toBeNull();
    expect(calls).toEqual([{ linkPreviews: { enabled: false } }]);
  });

  test('cancelling the confirm dialog writes nothing and leaves the toggle off', async () => {
    const user = userEvent.setup();
    const { binding, calls } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithLinkPreviews(false);

    render(<LinkPreviewsSection />);

    await user.click(screen.getByTestId('settings-link-previews-toggle'));
    await user.click(await screen.findByRole('button', { name: /cancel/i }));

    expect(calls.length).toBe(0);
    expect(screen.getByTestId('settings-link-previews-toggle').getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  test('cancelling the confirm dialog returns focus to the toggle switch (WCAG 2.4.3)', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithLinkPreviews(false);

    render(<LinkPreviewsSection />);

    const toggle = screen.getByTestId('settings-link-previews-toggle');
    await user.click(toggle);
    await user.click(await screen.findByRole('button', { name: /cancel/i }));

    await waitFor(() => {
      expect(screen.queryByTestId('settings-link-previews-confirm')).toBeNull();
    });
    expect(document.activeElement).toBe(toggle);
  });

  test('confirming the dialog returns focus to the toggle switch', async () => {
    const user = userEvent.setup();
    const { binding } = makeBinding();
    mockProjectLocalBinding = binding;
    mockProjectLocalConfig = configWithLinkPreviews(false);

    render(<LinkPreviewsSection />);

    const toggle = screen.getByTestId('settings-link-previews-toggle');
    await user.click(toggle);
    await user.click(await screen.findByTestId('settings-link-previews-confirm-enable'));

    await waitFor(() => {
      expect(screen.queryByTestId('settings-link-previews-confirm')).toBeNull();
    });
    expect(document.activeElement).toBe(toggle);
  });

  test('write failure keeps the confirm dialog open for retry (egress consent invariant)', async () => {
    const user = userEvent.setup();
    const failBinding = {
      ...makeBinding().binding,
      patch: () => ({ ok: false, error: { code: 'noop', message: 'fail' } }),
    } as unknown as ConfigBinding;
    mockProjectLocalBinding = failBinding;
    mockProjectLocalConfig = configWithLinkPreviews(false);

    render(<LinkPreviewsSection />);

    await user.click(screen.getByTestId('settings-link-previews-toggle'));
    await user.click(await screen.findByTestId('settings-link-previews-confirm-enable'));

    expect(await screen.findByTestId('settings-link-previews-confirm')).toBeDefined();
  });
});
