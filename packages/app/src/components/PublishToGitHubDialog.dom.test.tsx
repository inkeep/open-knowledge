import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { SharePublishOwner } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { act } from 'react';
import type { PublishErrorPresentation } from '@/lib/share/publish-wizard';
import { renderLinguiTemplate } from '@/test-utils/lingui-mock';

type OwnersResult =
  | { ok: true; owners: SharePublishOwner[] }
  | { ok: false; error: 'auth-required' | 'network' };

type SubmitPayload = {
  description?: string;
  name: string;
  owner: string;
  visibility: 'private' | 'public';
};

const defaultOwners: SharePublishOwner[] = [
  { kind: 'user', login: 'alice' },
  { kind: 'org', login: 'docs-team' },
];

let ownersQueue: OwnersResult[] = [];
let submitResult:
  | { ok: true; ownerLogin: string; repoName: string }
  | { ok: false; error: string } = {
  ok: true,
  ownerLogin: 'alice',
  repoName: 'my-project',
};
let presentError: PublishErrorPresentation = {
  banner: 'Could not publish',
  next: { kind: 'edit-form' },
};
let workspaceContentDir = '/Users/alice/My Project';
let activeDocName: string | null = 'docs/intro';
let submitCalls: SubmitPayload[] = [];
let openExternalCalls: string[] = [];
let windowOpenCalls: string[] = [];
let shareConstructUrlResponse:
  | { ok: true; shareUrl: string; sharedUrl: string; branch: string }
  | { ok: false; error: string; branch?: string } = {
  ok: true,
  shareUrl: 'https://openknowledge.ai/d/Published123',
  sharedUrl: 'https://github.com/alice/my-project/blob/main/docs/intro.md',
  branch: 'main',
};
let clipboardError: unknown = null;
let permissionsPolicyRefusal = false;
let clipboardCalls: string[] = [];

function sanitizeRepoName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const fetchPublishOwnersMock = mock(
  async () => ownersQueue.shift() ?? { ok: true, owners: defaultOwners },
);
const fetchPublishNameCheckMock = mock(async () => ({ ok: true }));
const submitPublishRequestMock = mock(async (payload: SubmitPayload) => {
  submitCalls.push(payload);
  return submitResult;
});
const requestShareConstructUrlMock = mock(async () => shareConstructUrlResponse);
const mapShareErrorToToastMock = mock((error: string, branch?: string) =>
  branch ? `mapped ${error} on ${branch}` : `mapped ${error}`,
);
const scheduleClipboardWriteMock = mock(async (text: string) => {
  clipboardCalls.push(text);
  if (clipboardError) throw clipboardError;
});
const isPermissionsPolicyRefusalMock = mock(() => permissionsPolicyRefusal);
const toastMock = {
  error: mock(() => {}),
  success: mock(() => {}),
};

mock.module('@lingui/react/macro', () => ({
  Trans: ({ children }: { children: ReactNode }) => <>{children}</>,
  useLingui: () => ({ t: renderLinguiTemplate }),
}));

mock.module('@/components/AuthModal', () => ({
  AuthModal: ({ onSuccess, open }: { onSuccess: () => void; open: boolean }) =>
    open ? (
      <button data-testid="auth-modal" type="button" onClick={onSuccess}>
        GitHub auth
      </button>
    ) : null,
}));

mock.module('@/editor/DocumentContext', () => ({
  useDocumentContext: () => ({ activeDocName }),
}));

mock.module('@/lib/use-workspace', () => ({
  useWorkspace: () => ({ contentDir: workspaceContentDir }),
}));

mock.module('@/lib/share/run-share-action', () => ({
  mapShareErrorToToast: mapShareErrorToToastMock,
  requestShareConstructUrl: requestShareConstructUrlMock,
}));

mock.module('@/lib/share/clipboard-adapter', () => ({
  isPermissionsPolicyRefusal: isPermissionsPolicyRefusalMock,
  scheduleClipboardWrite: scheduleClipboardWriteMock,
}));

mock.module('@/lib/share/publish-wizard', () => ({
  canSubmitPublish: ({
    nameCheck,
    owner,
    sanitizedName,
    submitting,
  }: {
    nameCheck: { kind: string };
    owner: SharePublishOwner | null;
    sanitizedName: string;
    submitting: boolean;
  }) => Boolean(owner && sanitizedName && nameCheck.kind === 'available' && !submitting),
  extractFolderBasename: (path: string) => path.split('/').filter(Boolean).at(-1) ?? '',
  fetchPublishNameCheck: fetchPublishNameCheckMock,
  fetchPublishOwners: fetchPublishOwnersMock,
  pickDefaultOwner: (owners: SharePublishOwner[]) =>
    owners.find((o) => o.kind === 'org')?.login ?? owners[0]?.login ?? '',
  presentPublishError: () => presentError,
  resolveNameCheckStatus: (_result: unknown, owner: string, name: string) => ({
    kind: 'available' as const,
    name,
    owner,
  }),
  sanitizeRepoName,
  submitPublishRequest: submitPublishRequestMock,
}));

mock.module('sonner', () => ({
  toast: toastMock,
}));

function setDesktopBridge(bridge: unknown) {
  Object.defineProperty(window, 'okDesktop', {
    configurable: true,
    writable: true,
    value: bridge,
  });
}

async function renderDialog() {
  const { PublishToGitHubDialog } = await import('./PublishToGitHubDialog');
  const onOpenChange = mock((_open: boolean) => {});
  await act(async () => {
    render(<PublishToGitHubDialog open={true} onOpenChange={onOpenChange} />);
    await Promise.resolve();
  });
  return { onOpenChange };
}

async function waitForAvailableNameCheck() {
  await waitFor(
    () => {
      expect(screen.getByTestId('publish-name-check').getAttribute('data-status')).toBe(
        'available',
      );
    },
    { timeout: 1500 },
  );
}

describe('PublishToGitHubDialog runtime behavior', () => {
  afterEach(() => {
    cleanup();
    ownersQueue = [];
    submitResult = { ok: true, ownerLogin: 'alice', repoName: 'my-project' };
    presentError = { banner: 'Could not publish', next: { kind: 'edit-form' } };
    workspaceContentDir = '/Users/alice/My Project';
    activeDocName = 'docs/intro';
    submitCalls = [];
    openExternalCalls = [];
    windowOpenCalls = [];
    shareConstructUrlResponse = {
      ok: true,
      shareUrl: 'https://openknowledge.ai/d/Published123',
      sharedUrl: 'https://github.com/alice/my-project/blob/main/docs/intro.md',
      branch: 'main',
    };
    clipboardError = null;
    permissionsPolicyRefusal = false;
    clipboardCalls = [];
    fetchPublishOwnersMock.mockClear();
    fetchPublishNameCheckMock.mockClear();
    submitPublishRequestMock.mockClear();
    requestShareConstructUrlMock.mockClear();
    mapShareErrorToToastMock.mockClear();
    scheduleClipboardWriteMock.mockClear();
    isPermissionsPolicyRefusalMock.mockClear();
    toastMock.error.mockClear();
    toastMock.success.mockClear();
    setDesktopBridge(undefined);
    window.open = ((url: string) => {
      windowOpenCalls.push(url);
      return null;
    }) as typeof window.open;
  });

  test('renders the dialog frame, fields, default private visibility, and live name-check preview', async () => {
    await renderDialog();

    expect(screen.getByRole('dialog', { name: 'Publish to GitHub' })).toBeTruthy();
    expect(await screen.findByTestId('publish-owner-radio')).toBeTruthy();
    // Owners render as radio options; the org is pre-selected over the user
    // account (pickDefaultOwner) so a team's KB doesn't default to a personal repo.
    expect(screen.getByTestId('publish-owner-option-docs-team').getAttribute('data-state')).toBe(
      'checked',
    );
    expect(screen.getByTestId('publish-owner-option-alice').getAttribute('data-state')).toBe(
      'unchecked',
    );
    expect((screen.getByTestId('publish-name') as HTMLInputElement).value).toBe('my-project');
    expect(screen.getByText('Will be created as')).toBeTruthy();
    expect(screen.getByText('my-project')).toBeTruthy();
    expect(screen.getByTestId('publish-visibility-private').getAttribute('data-state')).toBe(
      'checked',
    );
    expect(screen.getByTestId('publish-visibility-public').getAttribute('data-state')).toBe(
      'unchecked',
    );
    expect(screen.getByTestId('publish-description')).toBeTruthy();
    expect(screen.getByTestId('publish-submit').getAttribute('type')).toBe('button');
    expect((screen.getByTestId('publish-submit') as HTMLButtonElement).disabled).toBe(true);

    await waitForAvailableNameCheck();

    expect(screen.getByTestId('publish-name-check').textContent).toContain('Available');
    expect((screen.getByTestId('publish-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  test('pre-selects the user account when no org is available', async () => {
    ownersQueue = [{ ok: true, owners: [{ kind: 'user', login: 'alice' }] }];
    await renderDialog();

    expect(await screen.findByTestId('publish-owner-radio')).toBeTruthy();
    expect(screen.getByTestId('publish-owner-option-alice').getAttribute('data-state')).toBe(
      'checked',
    );
    await waitForAvailableNameCheck();
    await userEvent.click(screen.getByTestId('publish-submit'));

    await waitFor(() => expect(submitCalls).toHaveLength(1));
    expect(submitCalls[0]?.owner).toBe('alice');
  });

  test('selecting a different owner radio updates the publish payload', async () => {
    const { onOpenChange } = await renderDialog();
    await waitForAvailableNameCheck();

    // Default is the org; switch to the personal account before submitting.
    await userEvent.click(screen.getByTestId('publish-owner-option-alice'));
    expect(screen.getByTestId('publish-owner-option-alice').getAttribute('data-state')).toBe(
      'checked',
    );
    await waitForAvailableNameCheck();
    await userEvent.click(screen.getByTestId('publish-submit'));

    await waitFor(() => expect(submitCalls).toHaveLength(1));
    expect(submitCalls[0]?.owner).toBe('alice');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  test('submits through publish helpers, shows success URL, copies from a fresh button click, and Done closes', async () => {
    const { onOpenChange } = await renderDialog();
    await waitForAvailableNameCheck();

    await userEvent.type(screen.getByTestId('publish-description'), 'Internal docs');
    await userEvent.click(screen.getByTestId('publish-submit'));

    await waitFor(() => {
      expect(submitCalls).toHaveLength(1);
    });
    expect(submitCalls).toEqual([
      {
        description: 'Internal docs',
        name: 'my-project',
        owner: 'docs-team',
        visibility: 'private',
      },
    ]);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(await screen.findByTestId('publish-success')).toBeTruthy();
    await waitFor(() =>
      expect(requestShareConstructUrlMock).toHaveBeenCalledWith({
        kind: 'doc',
        docPath: 'docs/intro.md',
      }),
    );
    const shareUrl = (await screen.findByTestId('publish-share-url')) as HTMLInputElement;
    expect(shareUrl.value).toBe('https://openknowledge.ai/d/Published123');

    await userEvent.click(screen.getByTestId('publish-copy-link'));

    expect(clipboardCalls).toEqual(['https://openknowledge.ai/d/Published123']);
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Link copied.'));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    cleanup();
    const next = await renderDialog();
    await waitForAvailableNameCheck();
    await userEvent.click(screen.getByTestId('publish-submit'));
    await screen.findByTestId('publish-success');
    await userEvent.click(screen.getByTestId('publish-success-done'));
    expect(next.onOpenChange).toHaveBeenCalledWith(false);
  });

  test('success view maps share-url prefetch failures into the inline manual-copy slot', async () => {
    shareConstructUrlResponse = {
      ok: false,
      error: 'branch-not-on-origin',
      branch: 'feat/share',
    };
    await renderDialog();
    await waitForAvailableNameCheck();

    await userEvent.click(screen.getByTestId('publish-submit'));

    expect((await screen.findByTestId('publish-share-url-error')).textContent).toBe(
      'mapped branch-not-on-origin on feat/share',
    );
    expect(mapShareErrorToToastMock).toHaveBeenCalledWith('branch-not-on-origin', 'feat/share');
  });

  test('copy failure keeps the visible URL and surfaces generic manual-copy copy in jsdom', async () => {
    clipboardError = new DOMException('Permission denied', 'NotAllowedError');
    await renderDialog();
    await waitForAvailableNameCheck();

    await userEvent.click(screen.getByTestId('publish-submit'));
    await screen.findByTestId('publish-share-url');
    await userEvent.click(screen.getByTestId('publish-copy-link'));

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(
        "Couldn't copy. Select the URL above to copy it manually.",
      );
    });
    expect((screen.getByTestId('publish-share-url') as HTMLInputElement).value).toBe(
      'https://openknowledge.ai/d/Published123',
    );
  });

  test('mounts AuthModal for auth-required owners and retries owners after auth success', async () => {
    ownersQueue = [
      { ok: false, error: 'auth-required' },
      { ok: true, owners: defaultOwners },
    ];
    await renderDialog();

    expect(await screen.findByTestId('auth-modal')).toBeTruthy();
    expect(screen.getByText('Connect GitHub to continue.')).toBeTruthy();

    fireEvent.click(screen.getByTestId('auth-modal'));

    await waitFor(() => {
      expect(fetchPublishOwnersMock).toHaveBeenCalledTimes(2);
    });
    await waitForAvailableNameCheck();
    expect(screen.queryByTestId('auth-modal') === null).toBe(true);
  });

  test('routes SAML authorization through desktop openExternal and falls back to window.open', async () => {
    submitResult = { ok: false, error: 'saml-sso' };
    presentError = {
      banner: 'Authorize this organization.',
      next: { authorizeUrl: 'https://github.com/orgs/docs-team/sso', kind: 'authorize-org' },
    };
    setDesktopBridge({
      shell: {
        openExternal: async (url: string) => {
          openExternalCalls.push(url);
          return { ok: true };
        },
      },
    });
    await renderDialog();
    await waitForAvailableNameCheck();

    await userEvent.click(screen.getByTestId('publish-submit'));
    await userEvent.click(await screen.findByTestId('publish-authorize-org'));

    expect(openExternalCalls).toEqual(['https://github.com/orgs/docs-team/sso']);
    cleanup();

    setDesktopBridge(undefined);
    await renderDialog();
    await waitForAvailableNameCheck();
    await userEvent.click(screen.getByTestId('publish-submit'));
    await userEvent.click(await screen.findByTestId('publish-authorize-org'));

    expect(windowOpenCalls).toEqual(['https://github.com/orgs/docs-team/sso']);
  });
});
