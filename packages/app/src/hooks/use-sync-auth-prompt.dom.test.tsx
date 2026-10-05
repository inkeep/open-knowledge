import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const toastInfoCalls: string[] = [];
const toastInfoActions: Array<{ label: string; onClick: () => void } | undefined> = [];

import * as actualLinguiMacro from '@lingui/react/macro';

vi.doMock('sonner', () => ({
  toast: {
    info: (msg: string, opts?: { action?: { label: string; onClick: () => void } }) => {
      toastInfoCalls.push(msg);
      toastInfoActions.push(opts?.action);
    },
    success: () => {},
    error: () => {},
    warn: () => {},
  },
}));

vi.doMock('@lingui/react/macro', () => ({
  ...actualLinguiMacro,
  useLingui: () => ({
    t: (strings: TemplateStringsArray) => strings.join(''),
  }),
}));

const { authPromptStore } = await import('@/lib/auth-prompt-store');
const { useSyncAuthPrompt } = await import('./use-sync-auth-prompt');

const NO_CREDENTIAL_COPY =
  'OpenKnowledge has no credential stored for this host. Add a token in Settings, or let git use the credentials it already has.';

type Remote = Parameters<typeof useSyncAuthPrompt>[0];

const GITHUB_REMOTE: Remote = {
  label: 'github.com/o/r',
  webUrl: 'https://github.com/o/r',
  transport: 'https',
};
const GITEA_HTTPS_REMOTE: Remote = {
  label: 'gitea.internal/o/r',
  webUrl: null,
  transport: 'https',
};
const GITEA_SSH_REMOTE: Remote = { label: 'gitea.internal/o/r', webUrl: null, transport: 'ssh' };

const NO_TOKEN_COPY =
  "Git couldn't authenticate with this host. Check the SSH key or saved credentials git uses for it.";

function TestComponent({ remote, onPrompt }: { remote: Remote; onPrompt: () => void }) {
  useSyncAuthPrompt(remote, onPrompt);
  return null;
}

describe('useSyncAuthPrompt', () => {
  beforeEach(() => {
    toastInfoCalls.length = 0;
    toastInfoActions.length = 0;
    authPromptStore.clear();
    window.location.hash = '';
  });

  afterEach(() => {
    cleanup();
    authPromptStore.clear();
  });

  test('a GitHub or remote-less project opens the sign-in modal', () => {
    const onPrompt = vi.fn();
    render(<TestComponent remote={GITHUB_REMOTE} onPrompt={onPrompt} />);

    act(() => authPromptStore.request());

    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(toastInfoCalls).toEqual([]);
  });

  test('a non-GitHub remote gets the stored-credential sentence and no modal', () => {
    const onPrompt = vi.fn();
    render(<TestComponent remote={GITEA_HTTPS_REMOTE} onPrompt={onPrompt} />);

    act(() => authPromptStore.request());

    expect(onPrompt).not.toHaveBeenCalled();
    expect(toastInfoCalls).toEqual([NO_CREDENTIAL_COPY]);
    expect(toastInfoCalls[0]).not.toContain('GitHub sign');
  });

  test('the notice carries an action that opens Account settings, where the token form lives', () => {
    render(<TestComponent remote={GITEA_HTTPS_REMOTE} onPrompt={vi.fn()} />);

    act(() => authPromptStore.request());

    const action = toastInfoActions[0];
    expect(action?.label).toBe('Add token');
    action?.onClick();
    expect(window.location.hash).toBe('#settings/account');
  });

  test('a pending request is consumed either way, so it cannot replay', () => {
    const onPrompt = vi.fn();
    render(<TestComponent remote={GITEA_HTTPS_REMOTE} onPrompt={onPrompt} />);

    act(() => authPromptStore.request());

    expect(authPromptStore.getSnapshot()).toBe(false);
    expect(toastInfoCalls).toHaveLength(1);
  });

  test('an SSH remote is pointed at its SSH key, with no Add token action', () => {
    const onPrompt = vi.fn();
    render(<TestComponent remote={GITEA_SSH_REMOTE} onPrompt={onPrompt} />);

    act(() => authPromptStore.request());

    expect(onPrompt).not.toHaveBeenCalled();
    expect(toastInfoCalls).toEqual([NO_TOKEN_COPY]);
    expect(toastInfoActions[0]).toBeUndefined();
  });

  test('no request means neither surface fires', () => {
    const onPrompt = vi.fn();
    render(<TestComponent remote={GITEA_HTTPS_REMOTE} onPrompt={onPrompt} />);

    expect(onPrompt).not.toHaveBeenCalled();
    expect(toastInfoCalls).toEqual([]);
  });
});
