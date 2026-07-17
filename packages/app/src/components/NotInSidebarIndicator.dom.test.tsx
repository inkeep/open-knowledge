/**
 * Behavioral tests for the not-in-sidebar indicator: per-axis attribution
 * rendering, per-axis flip patches, recompute after a flip that leaves the
 * doc hidden by the other axis, and the silent cases (visible docs, skills /
 * templates / `.ok` docs, which never have a row the toggles govern).
 *
 * Runs under `bun run test:dom` (jsdom substrate per precedent #43).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Config } from '@inkeep/open-knowledge-core';
import * as actualLinguiMacro from '@lingui/react/macro';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

mock.module('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

type SidebarVisibilityConfig = {
  appearance?: {
    sidebar?: {
      showHiddenFiles?: boolean;
      showOnlyMarkdownFiles?: boolean;
    };
  };
};

let mergedConfig: SidebarVisibilityConfig | null = null;
let projectLocalBindingNull = false;
let patchResultOk = true;
const patchCalls: unknown[] = [];
const toastErrors: unknown[][] = [];

mock.module('@/lib/config-provider', () => ({
  useConfigContext: () => ({
    merged: mergedConfig as Config | null,
    projectLocalBinding: projectLocalBindingNull
      ? null
      : {
          patch: (value: unknown) => {
            patchCalls.push(value);
            return patchResultOk
              ? { ok: true, appliedPaths: [], effective: {} }
              : { ok: false, error: { issues: [] } };
          },
        },
  }),
}));

mock.module('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrors.push(args),
    success: () => {},
  },
}));

const { NotInSidebarIndicator } = await import('./NotInSidebarIndicator');

const indicator = () => screen.queryByTestId('not-in-sidebar-indicator');
const hiddenFilesFlip = () => screen.queryByTestId('not-in-sidebar-flip-hidden-files');
const onlyMarkdownFlip = () => screen.queryByTestId('not-in-sidebar-flip-only-markdown');

describe('NotInSidebarIndicator', () => {
  beforeEach(() => {
    mergedConfig = null;
    projectLocalBindingNull = false;
    patchResultOk = true;
    patchCalls.length = 0;
    toastErrors.length = 0;
  });

  afterEach(() => cleanup());

  test('dot-path doc at defaults names the hidden-files axis only', () => {
    render(<NotInSidebarIndicator entry={{ kind: 'document', docName: '.scratch/note' }} />);

    expect(indicator()).toBeTruthy();
    expect(hiddenFilesFlip()).toBeTruthy();
    expect(onlyMarkdownFlip()).toBeNull();
  });

  test('flip action patches the axis config leaf through the project-local binding', () => {
    render(<NotInSidebarIndicator entry={{ kind: 'document', docName: '.scratch/note' }} />);

    fireEvent.click(hiddenFilesFlip() as HTMLElement);
    expect(patchCalls).toEqual([{ appearance: { sidebar: { showHiddenFiles: true } } }]);
  });

  test('both-axes file lists both toggles; flipping one leaves the other (recompute)', () => {
    mergedConfig = { appearance: { sidebar: { showOnlyMarkdownFiles: true } } };
    const rendered = render(
      <NotInSidebarIndicator entry={{ kind: 'asset', path: '.scratch/data.csv' }} />,
    );
    expect(hiddenFilesFlip()).toBeTruthy();
    expect(onlyMarkdownFlip()).toBeTruthy();

    fireEvent.click(onlyMarkdownFlip() as HTMLElement);
    expect(patchCalls).toEqual([{ appearance: { sidebar: { showOnlyMarkdownFiles: false } } }]);

    // The patch lands in merged config via the CRDT round-trip; mirror that
    // by re-rendering with the updated merged view.
    mergedConfig = { appearance: { sidebar: { showOnlyMarkdownFiles: false } } };
    rendered.rerender(
      <NotInSidebarIndicator entry={{ kind: 'asset', path: '.scratch/data.csv' }} />,
    );
    expect(indicator()).toBeTruthy();
    expect(hiddenFilesFlip()).toBeTruthy();
    expect(onlyMarkdownFlip()).toBeNull();
  });

  test('renders nothing when the doc has a visible row', () => {
    render(<NotInSidebarIndicator entry={{ kind: 'document', docName: 'notes/todo' }} />);
    expect(indicator()).toBeNull();
  });

  test('renders nothing for docs structurally outside the tree (skills, templates, .ok)', () => {
    mergedConfig = { appearance: { sidebar: { showOnlyMarkdownFiles: true } } };
    for (const docName of [
      '.ok/skills/writer/SKILL',
      '__skill__/global/writer',
      '__template__/.private/meeting-notes',
    ]) {
      const rendered = render(<NotInSidebarIndicator entry={{ kind: 'document', docName }} />);
      expect(indicator()).toBeNull();
      rendered.unmount();
    }
  });

  test('flip actions disable while the project-local binding is unavailable', () => {
    projectLocalBindingNull = true;
    render(<NotInSidebarIndicator entry={{ kind: 'document', docName: '.scratch/note' }} />);

    expect(indicator()).toBeTruthy();
    expect((hiddenFilesFlip() as HTMLButtonElement).disabled).toBe(true);
  });

  test('a rejected patch surfaces the shared settings-update toast', () => {
    patchResultOk = false;
    render(<NotInSidebarIndicator entry={{ kind: 'document', docName: '.scratch/note' }} />);

    fireEvent.click(hiddenFilesFlip() as HTMLElement);
    expect(toastErrors.length).toBe(1);
  });
});
