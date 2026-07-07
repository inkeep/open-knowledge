import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewWorktreeDialog } from './NewWorktreeDialog';

const refreshWorktrees = mock(() => {});
mock.module('@/lib/worktree-store', () => ({ refreshWorktrees }));

function createBridge(createResult: unknown) {
  return {
    worktree: { create: mock(() => Promise.resolve(createResult)) },
    project: { open: mock(() => Promise.resolve()) },
  };
}

const noop = () => {};

describe('NewWorktreeDialog', () => {
  beforeEach(() => {
    cleanup();
    refreshWorktrees.mockClear();
  });

  test('creates a new branch worktree and opens it (entryPoint worktree)', async () => {
    const bridge = createBridge({
      ok: true,
      path: '/repo/.ok/worktrees/my-feature',
      created: true,
    });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
      />,
    );
    const input = await screen.findByTestId('new-worktree-branch');
    fireEvent.change(input, { target: { value: 'my-feature' } });
    fireEvent.click(screen.getByTestId('new-worktree-create'));

    await waitFor(() => expect(bridge.worktree.create).toHaveBeenCalledTimes(1));
    expect(bridge.worktree.create).toHaveBeenCalledWith({
      branch: 'my-feature',
      createBranch: true,
      baseBranch: 'main',
    });
    await waitFor(() =>
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/repo/.ok/worktrees/my-feature',
        target: 'new-window',
        entryPoint: 'worktree',
      }),
    );
  });

  test('pre-fills the branch field from initialBranchName on open (create mode) and submits it', async () => {
    const bridge = createBridge({
      ok: true,
      path: '/repo/.ok/worktrees/pre-seeded',
      created: true,
    });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev']}
        initialBranchName="pre-seeded"
      />,
    );
    // The field opens carrying the seeded name (not empty), so the confirm is
    // immediately actionable and the create indicator reflects the seeded name.
    const input = (await screen.findByTestId('new-worktree-branch')) as HTMLInputElement;
    expect(input.value).toBe('pre-seeded');
    expect(screen.getByTestId('new-worktree-mode-create').textContent).toContain('pre-seeded');

    fireEvent.click(screen.getByTestId('new-worktree-create'));
    await waitFor(() => expect(bridge.worktree.create).toHaveBeenCalledTimes(1));
    expect(bridge.worktree.create).toHaveBeenCalledWith({
      branch: 'pre-seeded',
      createBranch: true,
      baseBranch: 'main',
    });
  });

  test('a seeded name matching an existing branch opens straight into checkout mode', async () => {
    const bridge = createBridge({ ok: true, path: '/repo/.ok/worktrees/dev', created: false });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev', 'release']}
        initialBranchName="dev"
      />,
    );
    // The pre-filled value flows through the same create/checkout disambiguation
    // as typed input — "dev" is an existing branch, so it's a checkout.
    await screen.findByTestId('new-worktree-branch');
    expect(screen.getByTestId('new-worktree-mode-checkout').textContent).toContain(
      'Existing branch',
    );
    expect(screen.getByTestId('new-worktree-create').textContent).toContain('Check out');
  });

  test('without initialBranchName the field opens empty (default)', async () => {
    const bridge = createBridge({ ok: true, path: '/x', created: true });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
      />,
    );
    const input = (await screen.findByTestId('new-worktree-branch')) as HTMLInputElement;
    expect(input.value).toBe('');
  });

  test('surfaces a branch-exists failure inline without opening a window', async () => {
    const bridge = createBridge({ ok: false, reason: 'branch-exists' });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
      />,
    );
    fireEvent.change(await screen.findByTestId('new-worktree-branch'), {
      target: { value: 'dev' },
    });
    fireEvent.click(screen.getByTestId('new-worktree-create'));
    const err = await screen.findByTestId('new-worktree-error');
    expect(err.textContent).toContain('already exists');
    expect(bridge.project.open).not.toHaveBeenCalled();
  });

  test('checks out an existing branch (createBranch false, no base) and refreshes the cache', async () => {
    const bridge = createBridge({
      ok: true,
      path: '/repo/.ok/worktrees/dev',
      created: false,
    });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev', 'release']}
      />,
    );
    const input = await screen.findByTestId('new-worktree-branch');
    fireEvent.change(input, { target: { value: 'dev' } });

    // The confirm affordance flips to checkout wording for an existing branch.
    expect(screen.getByTestId('new-worktree-create').textContent).toContain('Check out');

    fireEvent.click(screen.getByTestId('new-worktree-create'));
    await waitFor(() => expect(bridge.worktree.create).toHaveBeenCalledTimes(1));
    expect(bridge.worktree.create).toHaveBeenCalledWith({
      branch: 'dev',
      createBranch: false,
      baseBranch: undefined,
    });
    await waitFor(() =>
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/repo/.ok/worktrees/dev',
        target: 'new-window',
        entryPoint: 'worktree',
      }),
    );
    expect(refreshWorktrees).toHaveBeenCalled();
  });

  test('shows existing branches as a styled suggestion list; clicking one fills the field', async () => {
    const bridge = createBridge({ ok: true, path: '/x', created: true });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'release/1.x', 'dev']}
      />,
    );
    // Styled list (not a native <datalist>) with one option button per branch.
    const list = await screen.findByTestId('new-worktree-branch-list');
    expect(list.querySelector('datalist')).toBeNull();
    expect(screen.getByTestId('new-worktree-branch-option-release/1.x')).not.toBeNull();

    // Typing filters the list; clicking a suggestion fills the field and flips
    // the confirm to checkout wording.
    fireEvent.change(screen.getByTestId('new-worktree-branch'), { target: { value: 'rel' } });
    expect(screen.queryByTestId('new-worktree-branch-option-dev')).toBeNull();
    fireEvent.click(screen.getByTestId('new-worktree-branch-option-release/1.x'));
    expect((screen.getByTestId('new-worktree-branch') as HTMLInputElement).value).toBe(
      'release/1.x',
    );
    expect(screen.getByTestId('new-worktree-create').textContent).toContain('Check out');
  });

  test('suggestions use a prefix match, not substring — unrelated branches are excluded', async () => {
    const bridge = createBridge({ ok: true, path: '/x', created: true });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'claude/xenodochial-germain-895b95', 'dev']}
      />,
    );
    // "mai" is a SUBSTRING of "claude/xenodochial-germain-895b95" (it contains
    // "germain") but not a PREFIX of it — only the real "main" branch should
    // surface as a suggestion. (Using a partial, non-exact prefix here so the
    // exact-match dismissal from the other test doesn't also kick in.)
    fireEvent.change(await screen.findByTestId('new-worktree-branch'), {
      target: { value: 'mai' },
    });
    const list = await screen.findByTestId('new-worktree-branch-list');
    expect(list.querySelectorAll('[data-testid^="new-worktree-branch-option-"]')).toHaveLength(1);
    expect(screen.getByTestId('new-worktree-branch-option-main')).not.toBeNull();
    expect(
      screen.queryByTestId('new-worktree-branch-option-claude/xenodochial-germain-895b95'),
    ).toBeNull();
  });

  test('the suggestion list dismisses once the input exactly matches an existing branch', async () => {
    const bridge = createBridge({ ok: true, path: '/x', created: false });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'main-2']}
      />,
    );
    const input = await screen.findByTestId('new-worktree-branch');

    // Partial input ("mai") still has two prefix matches — list stays open.
    fireEvent.change(input, { target: { value: 'mai' } });
    expect(await screen.findByTestId('new-worktree-branch-list')).not.toBeNull();

    // Exact match ("main") — even though "main-2" also starts with "main" and
    // would otherwise remain a candidate, the checkout indicator already
    // communicates the match, so the list is redundant and dismisses entirely.
    fireEvent.change(input, { target: { value: 'main' } });
    expect(screen.queryByTestId('new-worktree-branch-list')).toBeNull();

    // The base selector (create-mode UI) is not present in checkout mode either,
    // so nothing is left obscuring the surrounding layout.
    expect(screen.queryByTestId('new-worktree-base-trigger')).toBeNull();
  });

  test('the create button is disabled until a branch name is entered', async () => {
    const bridge = createBridge({ ok: true, path: '/x', created: true });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch={null}
      />,
    );
    const button = (await screen.findByTestId('new-worktree-create')) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('new-worktree-branch'), { target: { value: 'x' } });
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  test('the base-branch selector defaults to currentBranch and creating passes it as the base', async () => {
    const bridge = createBridge({
      ok: true,
      path: '/repo/.ok/worktrees/my-feature',
      created: true,
    });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev', 'release']}
      />,
    );
    // The selector trigger shows the current branch as the default base.
    const trigger = await screen.findByTestId('new-worktree-base-trigger');
    expect(trigger.textContent).toContain('main');

    // Creating a new branch (name NOT among existing branches) sends the
    // defaulted base without any selector interaction.
    fireEvent.change(screen.getByTestId('new-worktree-branch'), {
      target: { value: 'my-feature' },
    });
    fireEvent.click(screen.getByTestId('new-worktree-create'));
    await waitFor(() => expect(bridge.worktree.create).toHaveBeenCalledTimes(1));
    expect(bridge.worktree.create).toHaveBeenCalledWith({
      branch: 'my-feature',
      createBranch: true,
      baseBranch: 'main',
    });
  });

  test('selecting a different base branch passes the chosen base to create', async () => {
    const bridge = createBridge({
      ok: true,
      path: '/repo/.ok/worktrees/my-feature',
      created: true,
    });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev', 'release']}
      />,
    );
    fireEvent.change(await screen.findByTestId('new-worktree-branch'), {
      target: { value: 'my-feature' },
    });

    // Drain the dialog's mount-time branch-input autofocus rAF before opening the
    // base Popover — otherwise under load it fires mid-interaction, steals focus,
    // and trips Radix's focus-outside auto-dismiss (flaky in the full CI suite).
    await new Promise((resolve) => requestAnimationFrame(resolve));
    // Open the base selector and pick a non-default branch. The Popover opens on
    // click (the Electron-safe primitive); jsdom fires this synchronously.
    fireEvent.click(screen.getByTestId('new-worktree-base-trigger'));
    fireEvent.click(await screen.findByTestId('new-worktree-base-option-dev'));

    // Trigger reflects the new base and the mode helper text follows it.
    await waitFor(() =>
      expect(screen.getByTestId('new-worktree-base-trigger').textContent).toContain('dev'),
    );
    expect(screen.getByTestId('new-worktree-mode-create').textContent).toContain('dev');

    fireEvent.click(screen.getByTestId('new-worktree-create'));
    await waitFor(() => expect(bridge.worktree.create).toHaveBeenCalledTimes(1));
    expect(bridge.worktree.create).toHaveBeenCalledWith({
      branch: 'my-feature',
      createBranch: true,
      baseBranch: 'dev',
    });
  });

  test('typing a new branch name shows the create indicator, not the checkout one', async () => {
    const bridge = createBridge({ ok: true, path: '/x', created: true });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev', 'release']}
      />,
    );
    const input = await screen.findByTestId('new-worktree-branch');
    fireEvent.change(input, { target: { value: 'my-feature' } });

    const indicator = await screen.findByTestId('new-worktree-mode-create');
    expect(indicator.textContent).toContain('New branch');
    expect(screen.queryByTestId('new-worktree-mode-checkout')).toBeNull();
  });

  test('typing an existing branch name shows the checkout indicator, not the create one', async () => {
    const bridge = createBridge({ ok: true, path: '/x', created: false });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev', 'release']}
      />,
    );
    const input = await screen.findByTestId('new-worktree-branch');
    fireEvent.change(input, { target: { value: 'dev' } });

    const indicator = await screen.findByTestId('new-worktree-mode-checkout');
    expect(indicator.textContent).toContain('Existing branch');
    expect(screen.queryByTestId('new-worktree-mode-create')).toBeNull();
  });

  test('an empty branch field shows neither mode indicator', async () => {
    const bridge = createBridge({ ok: true, path: '/x', created: true });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev', 'release']}
      />,
    );
    await screen.findByTestId('new-worktree-branch');
    expect(screen.queryByTestId('new-worktree-mode-create')).toBeNull();
    expect(screen.queryByTestId('new-worktree-mode-checkout')).toBeNull();
  });

  test('a branch that already has a worktree shows the existing-worktree indicator and "Open worktree" button (not plain checkout)', async () => {
    const bridge = createBridge({ ok: true, path: '/repo/.ok/worktrees/dev', created: false });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev', 'release']}
        existingWorktreeBranches={new Set(['dev'])}
      />,
    );
    const input = await screen.findByTestId('new-worktree-branch');
    fireEvent.change(input, { target: { value: 'dev' } });

    // The distinct third-state indicator — not the plain checkout one.
    const indicator = await screen.findByTestId('new-worktree-mode-existing-worktree');
    expect(indicator.textContent).toContain('already has a worktree');
    expect(screen.queryByTestId('new-worktree-mode-checkout')).toBeNull();
    expect(screen.queryByTestId('new-worktree-mode-create')).toBeNull();

    // Confirm affordance reads "Open worktree", not "Check out".
    const button = screen.getByTestId('new-worktree-create');
    expect(button.textContent).toContain('Open worktree');
    expect(button.textContent).not.toContain('Check out');
  });

  test('a branch WITHOUT a worktree still shows plain checkout even when other branches have one', async () => {
    const bridge = createBridge({ ok: true, path: '/repo/.ok/worktrees/release', created: false });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev', 'release']}
        // "dev" has a worktree; "release" (an existing local branch) does not.
        existingWorktreeBranches={new Set(['dev'])}
      />,
    );
    const input = await screen.findByTestId('new-worktree-branch');
    fireEvent.change(input, { target: { value: 'release' } });

    // Plain checkout copy, not the existing-worktree state.
    const indicator = await screen.findByTestId('new-worktree-mode-checkout');
    expect(indicator.textContent).toContain('Existing branch');
    expect(screen.queryByTestId('new-worktree-mode-existing-worktree')).toBeNull();
    expect(screen.getByTestId('new-worktree-create').textContent).toContain('Check out');
  });

  test('a NEW branch name still shows create even when existingWorktreeBranches is provided', async () => {
    const bridge = createBridge({ ok: true, path: '/x', created: true });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev', 'release']}
        existingWorktreeBranches={new Set(['dev'])}
      />,
    );
    const input = await screen.findByTestId('new-worktree-branch');
    fireEvent.change(input, { target: { value: 'my-feature' } });

    const indicator = await screen.findByTestId('new-worktree-mode-create');
    expect(indicator.textContent).toContain('New branch');
    expect(screen.queryByTestId('new-worktree-mode-existing-worktree')).toBeNull();
    expect(screen.getByTestId('new-worktree-create').textContent).toContain('Create');
  });

  test('opening an existing-worktree branch still calls create (createBranch false, no base) and opens its path', async () => {
    const onOpenChange = mock(() => {});
    const bridge = createBridge({ ok: true, path: '/repo/.ok/worktrees/dev', created: false });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={onOpenChange}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev', 'release']}
        existingWorktreeBranches={new Set(['dev'])}
      />,
    );
    const input = await screen.findByTestId('new-worktree-branch');
    fireEvent.change(input, { target: { value: 'dev' } });

    // The base selector never appears in this mode (it's a checkout subset).
    expect(screen.queryByTestId('new-worktree-base-trigger')).toBeNull();

    fireEvent.click(screen.getByTestId('new-worktree-create'));
    await waitFor(() => expect(bridge.worktree.create).toHaveBeenCalledTimes(1));
    // Same git call as a plain checkout — only the messaging differs.
    expect(bridge.worktree.create).toHaveBeenCalledWith({
      branch: 'dev',
      createBranch: false,
      baseBranch: undefined,
    });
    await waitFor(() =>
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/repo/.ok/worktrees/dev',
        target: 'new-window',
        entryPoint: 'worktree',
      }),
    );
    expect(refreshWorktrees).toHaveBeenCalled();
  });

  test('checkout mode hides the base selector and sends an undefined base', async () => {
    const bridge = createBridge({ ok: true, path: '/repo/.ok/worktrees/dev', created: false });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev', 'release']}
      />,
    );
    const input = await screen.findByTestId('new-worktree-branch');
    // Base selector is present in create mode…
    expect(screen.queryByTestId('new-worktree-base-trigger')).not.toBeNull();

    // …and disappears once the typed name matches an existing branch (checkout).
    fireEvent.change(input, { target: { value: 'dev' } });
    expect(screen.queryByTestId('new-worktree-base-trigger')).toBeNull();

    fireEvent.click(screen.getByTestId('new-worktree-create'));
    await waitFor(() => expect(bridge.worktree.create).toHaveBeenCalledTimes(1));
    expect(bridge.worktree.create).toHaveBeenCalledWith({
      branch: 'dev',
      createBranch: false,
      baseBranch: undefined,
    });
  });

  // a name that exists ONLY on a remote (no local branch) enters the
  // remote-checkout mode: distinct indicator, "Check out remote branch" button,
  // and a create request carrying `remoteRef` (a tracking checkout), NOT a fresh
  // create off stale HEAD.
  test('a remote-only branch name shows the remote-checkout indicator and sends remoteRef', async () => {
    const bridge = createBridge({
      ok: true,
      path: '/repo/.ok/worktrees/feature-x',
      created: true,
    });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev']}
        remoteBranches={['origin/main', 'origin/dev', 'origin/feature-x']}
      />,
    );
    fireEvent.change(await screen.findByTestId('new-worktree-branch'), {
      target: { value: 'feature-x' },
    });

    // The remote-checkout indicator (not create, not plain checkout) appears.
    const indicator = await screen.findByTestId('new-worktree-mode-remote-checkout');
    expect(indicator.textContent).toContain('Remote branch');
    expect(indicator.textContent).toContain('origin/feature-x');
    expect(screen.queryByTestId('new-worktree-mode-create')).toBeNull();
    expect(screen.queryByTestId('new-worktree-mode-checkout')).toBeNull();
    // No base selector — the remote ref IS the base for a tracking checkout.
    expect(screen.queryByTestId('new-worktree-base-trigger')).toBeNull();
    // The confirm button uses the remote-branch label.
    expect(screen.getByTestId('new-worktree-create').textContent).toContain(
      'Check out remote branch',
    );

    fireEvent.click(screen.getByTestId('new-worktree-create'));
    await waitFor(() => expect(bridge.worktree.create).toHaveBeenCalledTimes(1));
    expect(bridge.worktree.create).toHaveBeenCalledWith({
      branch: 'feature-x',
      createBranch: true,
      remoteRef: 'origin/feature-x',
    });
    await waitFor(() =>
      expect(bridge.project.open).toHaveBeenCalledWith({
        path: '/repo/.ok/worktrees/feature-x',
        target: 'new-window',
        entryPoint: 'worktree',
      }),
    );
  });

  // a name that is BOTH a local branch and a remote branch is a LOCAL
  // checkout (local wins), not a remote-tracking checkout.
  test('a name that is a local branch takes local checkout even when a remote ref matches', async () => {
    const bridge = createBridge({ ok: true, path: '/repo/.ok/worktrees/dev', created: false });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev']}
        remoteBranches={['origin/main', 'origin/dev']}
      />,
    );
    fireEvent.change(await screen.findByTestId('new-worktree-branch'), {
      target: { value: 'dev' },
    });
    // Local checkout indicator, not remote-checkout.
    expect(await screen.findByTestId('new-worktree-mode-checkout')).not.toBeNull();
    expect(screen.queryByTestId('new-worktree-mode-remote-checkout')).toBeNull();

    fireEvent.click(screen.getByTestId('new-worktree-create'));
    await waitFor(() => expect(bridge.worktree.create).toHaveBeenCalledTimes(1));
    expect(bridge.worktree.create).toHaveBeenCalledWith({ branch: 'dev', createBranch: false });
  });

  // a remote base is selectable and a new branch based on it sends `baseRef`
  // (which the git arm bases on WITH --no-track), not `baseBranch`.
  test('selecting a remote base option sends baseRef (no-track) instead of baseBranch', async () => {
    const bridge = createBridge({
      ok: true,
      path: '/repo/.ok/worktrees/my-feature',
      created: true,
    });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev']}
        remoteBranches={['origin/main', 'origin/dev']}
      />,
    );
    fireEvent.change(await screen.findByTestId('new-worktree-branch'), {
      target: { value: 'my-feature' },
    });
    // Drain the branch-input autofocus rAF before opening the base Popover so it
    // can't steal focus and auto-dismiss it.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    // Open the base selector; a remote option is present and selectable.
    fireEvent.click(screen.getByTestId('new-worktree-base-trigger'));
    fireEvent.click(await screen.findByTestId('new-worktree-base-option-origin/main'));
    // Trigger + caption reflect the remote base.
    await waitFor(() =>
      expect(screen.getByTestId('new-worktree-base-trigger').textContent).toContain('origin/main'),
    );
    expect(screen.getByTestId('new-worktree-mode-create').textContent).toContain('origin/main');

    fireEvent.click(screen.getByTestId('new-worktree-create'));
    await waitFor(() => expect(bridge.worktree.create).toHaveBeenCalledTimes(1));
    expect(bridge.worktree.create).toHaveBeenCalledWith({
      branch: 'my-feature',
      createBranch: true,
      baseRef: 'origin/main',
    });
  });

  // the "N behind origin" hint renders on a local base option whose branch
  // has diverged from its upstream (>0), nudging toward the fresh origin base.
  test('renders the N-behind-origin hint on a local base option that is behind', async () => {
    const bridge = createBridge({ ok: true, path: '/x', created: true });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev']}
        remoteBranches={['origin/main', 'origin/dev']}
        behindByBranch={
          new Map([
            ['main', 3],
            ['dev', 0],
          ])
        }
      />,
    );
    fireEvent.change(await screen.findByTestId('new-worktree-branch'), {
      target: { value: 'my-feature' },
    });
    // Drain the branch-input autofocus rAF before opening the base Popover so it
    // can't steal focus and trip Radix's focus-outside auto-dismiss.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    fireEvent.click(screen.getByTestId('new-worktree-base-trigger'));
    // `main` is 3 behind → hint shows the count.
    const behindHint = await screen.findByTestId('new-worktree-base-behind-main');
    expect(behindHint.textContent).toContain('3 behind origin');
    // `dev` is 0 behind → no hint (up to date needs no nudge).
    expect(screen.queryByTestId('new-worktree-base-behind-dev')).toBeNull();
  });

  test('typing in the base Popover search filters options by substring across local and remote', async () => {
    const bridge = createBridge({ ok: true, path: '/x', created: true });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'test-2', 'test-3', 'claude/foo']}
        remoteBranches={['origin/main', 'origin/test-2']}
      />,
    );
    fireEvent.change(await screen.findByTestId('new-worktree-branch'), {
      target: { value: 'my-feature' },
    });
    // Let the dialog's mount-time branch-input autofocus rAF settle before opening
    // the base Popover — otherwise it can fire mid-interaction, stealing focus back
    // from the Popover's search field and tripping Radix's focus-outside auto-dismiss.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    fireEvent.click(screen.getByTestId('new-worktree-base-trigger'));
    const search = await screen.findByTestId('new-worktree-base-search');

    // Substring match (not prefix-only): "test" surfaces both local test-* branches
    // and the matching remote ref, while unrelated options drop out.
    fireEvent.change(search, { target: { value: 'test' } });
    expect(screen.getByTestId('new-worktree-base-option-test-2')).not.toBeNull();
    expect(screen.getByTestId('new-worktree-base-option-test-3')).not.toBeNull();
    expect(screen.getByTestId('new-worktree-base-option-origin/test-2')).not.toBeNull();
    expect(screen.queryByTestId('new-worktree-base-option-main')).toBeNull();
    expect(screen.queryByTestId('new-worktree-base-option-claude/foo')).toBeNull();
    expect(screen.queryByTestId('new-worktree-base-option-origin/main')).toBeNull();
  });

  test('a base Popover query with no matches shows the empty-state row', async () => {
    const bridge = createBridge({ ok: true, path: '/x', created: true });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev']}
        remoteBranches={['origin/main', 'origin/dev']}
      />,
    );
    fireEvent.change(await screen.findByTestId('new-worktree-branch'), {
      target: { value: 'my-feature' },
    });
    // Let the dialog's mount-time branch-input autofocus rAF settle before opening
    // the base Popover — see the identical comment in the substring-filter test above.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    fireEvent.click(screen.getByTestId('new-worktree-base-trigger'));
    fireEvent.change(await screen.findByTestId('new-worktree-base-search'), {
      target: { value: 'nonexistent-branch' },
    });
    expect(await screen.findByText('No matching branches.')).not.toBeNull();
    expect(screen.queryByTestId('new-worktree-base-option-main')).toBeNull();
  });

  test('selecting a filtered base option applies the base and resets the query', async () => {
    const bridge = createBridge({
      ok: true,
      path: '/repo/.ok/worktrees/my-feature',
      created: true,
    });
    render(
      <NewWorktreeDialog
        open={true}
        onOpenChange={noop}
        bridge={bridge as never}
        currentBranch="main"
        branches={['main', 'dev', 'release']}
      />,
    );
    fireEvent.change(await screen.findByTestId('new-worktree-branch'), {
      target: { value: 'my-feature' },
    });
    // Let the dialog's mount-time branch-input autofocus rAF settle before opening
    // the base Popover — see the identical comment in the substring-filter test above.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    fireEvent.click(screen.getByTestId('new-worktree-base-trigger'));
    fireEvent.change(await screen.findByTestId('new-worktree-base-search'), {
      target: { value: 'dev' },
    });
    fireEvent.click(await screen.findByTestId('new-worktree-base-option-dev'));

    // Popover closes with the picked base applied.
    await waitFor(() =>
      expect(screen.getByTestId('new-worktree-base-trigger').textContent).toContain('dev'),
    );
    expect(screen.queryByTestId('new-worktree-base-list')).toBeNull();

    // Reopening shows the full, unfiltered list again (query reset on close).
    fireEvent.click(screen.getByTestId('new-worktree-base-trigger'));
    expect(await screen.findByTestId('new-worktree-base-option-main')).not.toBeNull();
    expect(screen.getByTestId('new-worktree-base-option-release')).not.toBeNull();
    expect((screen.getByTestId('new-worktree-base-search') as HTMLInputElement).value).toBe('');
  });
});
