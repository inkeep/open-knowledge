import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const refreshWorktrees = vi.fn(() => {});
vi.doMock('@/lib/worktree-store', () => ({ refreshWorktrees }));

function createBridge(createResult: unknown) {
  return {
    worktree: { create: vi.fn(() => Promise.resolve(createResult)) },
    project: { open: vi.fn(() => Promise.resolve()) },
  };
}

const noop = () => {};

const { NewWorktreeDialog } = await import('./NewWorktreeDialog');

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

  test('explains an empty repo instead of blaming the branch name', async () => {
    const bridge = createBridge({
      ok: false,
      reason: 'empty-repo',
      message: 'fatal: invalid reference: main',
    });
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
    expect(err.textContent).toContain('no commits yet');
    expect(err.textContent).not.toContain('different name');
  });

  test('surfaces the underlying git error alongside the copy', async () => {
    const bridge = createBridge({
      ok: false,
      reason: 'error',
      message: 'fatal: could not lock ref: Unable to create lock file',
    });
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
    const detail = await screen.findByTestId('new-worktree-error-detail');
    expect(detail.textContent).toContain('could not lock ref');
  });

  test('omits the detail line when the failure carries no git message', async () => {
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
    await screen.findByTestId('new-worktree-error');
    expect(screen.queryByTestId('new-worktree-error-detail')).toBeNull();
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
    const list = await screen.findByTestId('new-worktree-branch-list');
    expect(list.querySelector('datalist')).toBeNull();
    expect(screen.getByTestId('new-worktree-branch-option-release/1.x')).not.toBeNull();

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

    fireEvent.change(input, { target: { value: 'mai' } });
    expect(await screen.findByTestId('new-worktree-branch-list')).not.toBeNull();

    fireEvent.change(input, { target: { value: 'main' } });
    expect(screen.queryByTestId('new-worktree-branch-list')).toBeNull();

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
    const trigger = await screen.findByTestId('new-worktree-base-trigger');
    expect(trigger.textContent).toContain('main');

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

    await new Promise((resolve) => requestAnimationFrame(resolve));
    fireEvent.click(screen.getByTestId('new-worktree-base-trigger'));
    fireEvent.click(await screen.findByTestId('new-worktree-base-option-dev'));

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

    const indicator = await screen.findByTestId('new-worktree-mode-existing-worktree');
    expect(indicator.textContent).toContain('already has a worktree');
    expect(screen.queryByTestId('new-worktree-mode-checkout')).toBeNull();
    expect(screen.queryByTestId('new-worktree-mode-create')).toBeNull();

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
        existingWorktreeBranches={new Set(['dev'])}
      />,
    );
    const input = await screen.findByTestId('new-worktree-branch');
    fireEvent.change(input, { target: { value: 'release' } });

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
    const onOpenChange = vi.fn(() => {});
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

    expect(screen.queryByTestId('new-worktree-base-trigger')).toBeNull();

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
    expect(screen.queryByTestId('new-worktree-base-trigger')).not.toBeNull();

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

    const indicator = await screen.findByTestId('new-worktree-mode-remote-checkout');
    expect(indicator.textContent).toContain('Remote branch');
    expect(indicator.textContent).toContain('origin/feature-x');
    expect(screen.queryByTestId('new-worktree-mode-create')).toBeNull();
    expect(screen.queryByTestId('new-worktree-mode-checkout')).toBeNull();
    expect(screen.queryByTestId('new-worktree-base-trigger')).toBeNull();
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
    expect(await screen.findByTestId('new-worktree-mode-checkout')).not.toBeNull();
    expect(screen.queryByTestId('new-worktree-mode-remote-checkout')).toBeNull();

    fireEvent.click(screen.getByTestId('new-worktree-create'));
    await waitFor(() => expect(bridge.worktree.create).toHaveBeenCalledTimes(1));
    expect(bridge.worktree.create).toHaveBeenCalledWith({ branch: 'dev', createBranch: false });
  });

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
    await new Promise((resolve) => requestAnimationFrame(resolve));
    fireEvent.click(screen.getByTestId('new-worktree-base-trigger'));
    fireEvent.click(await screen.findByTestId('new-worktree-base-option-origin/main'));
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
    await new Promise((resolve) => requestAnimationFrame(resolve));
    fireEvent.click(screen.getByTestId('new-worktree-base-trigger'));
    const behindHint = await screen.findByTestId('new-worktree-base-behind-main');
    expect(behindHint.textContent).toContain('3 behind origin');
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
    await new Promise((resolve) => requestAnimationFrame(resolve));
    fireEvent.click(screen.getByTestId('new-worktree-base-trigger'));
    const search = await screen.findByTestId('new-worktree-base-search');

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
    await new Promise((resolve) => requestAnimationFrame(resolve));
    fireEvent.click(screen.getByTestId('new-worktree-base-trigger'));
    fireEvent.change(await screen.findByTestId('new-worktree-base-search'), {
      target: { value: 'dev' },
    });
    fireEvent.click(await screen.findByTestId('new-worktree-base-option-dev'));

    await waitFor(() =>
      expect(screen.getByTestId('new-worktree-base-trigger').textContent).toContain('dev'),
    );
    expect(screen.queryByTestId('new-worktree-base-list')).toBeNull();

    fireEvent.click(screen.getByTestId('new-worktree-base-trigger'));
    expect(await screen.findByTestId('new-worktree-base-option-main')).not.toBeNull();
    expect(screen.getByTestId('new-worktree-base-option-release')).not.toBeNull();
    expect((screen.getByTestId('new-worktree-base-search') as HTMLInputElement).value).toBe('');
  });
});
