import type {
  OkUninstallBridge,
  UninstallDispatchResult,
  UninstallScreenSpec,
} from '@inkeep/open-knowledge-core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { UninstallApp } from './UninstallApp';

function stubBridge(ready: () => Promise<UninstallDispatchResult>): void {
  window.okUninstall = {
    ready,
    send: (): Promise<UninstallDispatchResult> => Promise.resolve({ kind: 'accepted' }),
  } satisfies OkUninstallBridge;
}

const sendsScreen = (spec: UninstallScreenSpec) => (): Promise<UninstallDispatchResult> =>
  Promise.resolve({ kind: 'screen', screen: spec });

describe('UninstallApp routing', () => {
  afterEach(() => {
    cleanup();
    window.okUninstall = undefined;
  });

  test('mounts the picker for a picker screen', async () => {
    stubBridge(sendsScreen({ kind: 'picker', projects: [] }));
    render(<UninstallApp />);
    expect(await screen.findByRole('heading', { name: 'Uninstall OpenKnowledge?' })).toBeDefined();
  });

  test('mounts the survey for a survey screen', async () => {
    stubBridge(sendsScreen({ kind: 'survey' }));
    render(<UninstallApp />);
    expect(await screen.findByText('Before you go, mind sharing why?')).toBeDefined();
  });

  test('mounts the progress screen for a progress screen', async () => {
    stubBridge(sendsScreen({ kind: 'progress' }));
    render(<UninstallApp />);
    expect(
      await screen.findByRole('heading', { name: 'Removing OpenKnowledge files…' }),
    ).toBeDefined();
  });

  test('mounts a notice for a notice screen', async () => {
    stubBridge(
      sendsScreen({
        kind: 'notice',
        notice: { title: 'All done', paragraphs: ['Cleanup finished.'], confirmLabel: 'Close' },
      }),
    );
    render(<UninstallApp />);
    expect(await screen.findByText('Cleanup finished.')).toBeDefined();
  });

  test('keeps the loading placeholder when main refuses', async () => {
    stubBridge(() => Promise.resolve({ kind: 'refused', reason: 'unknown-window' }));
    render(<UninstallApp />);
    expect(await screen.findByText('Preparing to uninstall OpenKnowledge')).toBeDefined();
  });

  test('keeps the loading placeholder when the ready invoke rejects', async () => {
    stubBridge(() => Promise.reject(new Error('ipc channel closed')));
    render(<UninstallApp />);
    expect(await screen.findByText('Preparing to uninstall OpenKnowledge')).toBeDefined();
  });
});
