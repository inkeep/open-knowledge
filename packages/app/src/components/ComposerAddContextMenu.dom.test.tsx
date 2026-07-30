/**
 * The composer's `+` menu.
 *
 * What it exists to fix: dismissing the queued-comments chip had no inverse, so
 * "not part of this message" was a one-way door until you happened to queue
 * another comment. These pin the door open in both directions, and pin the two
 * states where the row must NOT act — nothing queued, and already attached —
 * since both would otherwise read as a button that silently does nothing.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import { ComposerAddContextMenu } from './ComposerAddContextMenu';

afterEach(() => cleanup());

function renderMenu(
  props: Partial<{
    queueCount: number;
    queueAttached: boolean;
    compact: boolean;
    onAddQueue: () => void;
    onRemoveQueue: () => void;
  }> = {},
) {
  return render(
    <ComposerAddContextMenu
      queueCount={props.queueCount ?? 3}
      queueAttached={props.queueAttached ?? false}
      compact={props.compact ?? false}
      onAddQueue={props.onAddQueue ?? (() => {})}
      onRemoveQueue={props.onRemoveQueue ?? (() => {})}
    />,
  );
}

describe('the composer + menu', () => {
  test('is present with nothing attached — it is how you attach', async () => {
    // Gating the `+` on there being something to add would hide it exactly when
    // someone goes looking for it.
    renderMenu({ queueCount: 0 });
    expect(screen.getByTestId('composer-add-context')).toBeTruthy();
  });

  test('opens to a Queue row that reports the count', async () => {
    const user = userEvent.setup();
    renderMenu({ queueCount: 3 });

    await user.click(screen.getByTestId('composer-add-context'));
    const row = await screen.findByTestId('composer-add-context-queue');
    expect(row.textContent).toMatch(/3 comments/);
  });

  test('clicking Queue attaches it', async () => {
    const user = userEvent.setup();
    let added = 0;
    renderMenu({
      onAddQueue: () => {
        added += 1;
      },
    });

    await user.click(screen.getByTestId('composer-add-context'));
    await user.click(await screen.findByTestId('composer-add-context-queue'));
    expect(added).toBe(1);
  });

  test('an empty queue leaves the row inert and says why', async () => {
    const user = userEvent.setup();
    let added = 0;
    renderMenu({
      queueCount: 0,
      onAddQueue: () => {
        added += 1;
      },
    });

    await user.click(screen.getByTestId('composer-add-context'));
    const row = await screen.findByTestId('composer-add-context-queue');
    // Visible but disabled: a missing row reads as a broken menu to someone who
    // opened it specifically to add comments.
    expect(row.getAttribute('data-disabled')).not.toBeNull();
    expect(row.textContent).toMatch(/nothing queued/i);
    await user.click(row);
    expect(added).toBe(0);
  });

  test('the menu is wide enough that a row does not wrap', async () => {
    // `DropdownMenuContent` sizes to `--radix-dropdown-menu-trigger-width` with
    // a `min-w-32` floor. Against this icon trigger that is 8rem, which wrapped
    // "Queue (5 comments)" onto two lines. `w-60` also matches the agent
    // settings menu sharing that action bar.
    const user = userEvent.setup();
    renderMenu({ queueCount: 5 });

    await user.click(screen.getByTestId('composer-add-context'));
    const content = await screen.findByTestId('composer-add-context-menu');
    expect(content.className).toContain('w-60');
    // The bug was the trigger-width sizing, and that is what must be gone. The
    // `min-w-32` floor survives (different tailwind-merge group) and is inert
    // at 15rem — leaving it in place is correct, not a missed override.
    expect(content.className).not.toContain('--radix-dropdown-menu-trigger-width');
  });

  test('compact sizes the trigger to a dense action bar', async () => {
    // The agent thread's bar is `h-6` controls; the default `size-8` button
    // towered over the settings trigger beside it.
    const { rerender } = renderMenu({ compact: true });
    expect(screen.getByTestId('composer-add-context').className).toContain('h-6');

    rerender(
      <ComposerAddContextMenu
        queueCount={3}
        queueAttached={false}
        compact={false}
        onAddQueue={() => {}}
      />,
    );
    // The composer row is sized to a full-height input — not h-6 there.
    expect(screen.getByTestId('composer-add-context').className).toContain('size-8');
  });

  test('a detach handler turns the row into a real checkbox', async () => {
    // `menuitemcheckbox` + `aria-checked` is what makes the state reachable to
    // a screen reader — the Switch beside it is decorative and aria-hidden, so
    // the role is the whole accessibility story here.
    const user = userEvent.setup();
    renderMenu({ queueAttached: true, onRemoveQueue: () => {} });

    await user.click(screen.getByTestId('composer-add-context'));
    const row = await screen.findByTestId('composer-add-context-queue');
    expect(row.getAttribute('role')).toBe('menuitemcheckbox');
    expect(row.getAttribute('aria-checked')).toBe('true');
  });

  test('toggling off detaches, toggling on re-attaches', async () => {
    const user = userEvent.setup();
    let added = 0;
    let removed = 0;
    const { rerender } = renderMenu({
      queueAttached: true,
      onAddQueue: () => {
        added += 1;
      },
      onRemoveQueue: () => {
        removed += 1;
      },
    });

    await user.click(screen.getByTestId('composer-add-context'));
    await user.click(await screen.findByTestId('composer-add-context-queue'));
    expect(removed).toBe(1);
    expect(added).toBe(0);

    rerender(
      <ComposerAddContextMenu
        queueCount={3}
        queueAttached={false}
        compact={false}
        onAddQueue={() => {
          added += 1;
        }}
        onRemoveQueue={() => {
          removed += 1;
        }}
      />,
    );
    // The menu stays open through a toggle (settings-menu parity), so the row
    // is still reachable without reopening.
    await user.click(await screen.findByTestId('composer-add-context-queue'));
    expect(added).toBe(1);
    expect(removed).toBe(1);
  });

  test('an empty queue cannot be toggled on', async () => {
    const user = userEvent.setup();
    let added = 0;
    renderMenu({
      queueCount: 0,
      queueAttached: true,
      onAddQueue: () => {
        added += 1;
      },
      onRemoveQueue: () => {},
    });

    await user.click(screen.getByTestId('composer-add-context'));
    const row = await screen.findByTestId('composer-add-context-queue');
    // Attached-but-empty must read as OFF: a switch promising an attachment
    // that carries nothing is worse than no switch.
    expect(row.getAttribute('aria-checked')).toBe('false');
    expect(row.getAttribute('data-disabled')).not.toBeNull();
    await user.click(row);
    expect(added).toBe(0);
  });

  test('the trigger says what it does, not what it looks like', async () => {
    // "Plus" / "Add" alone leaves a screen-reader user guessing what is added.
    renderMenu();
    expect(screen.getByTestId('composer-add-context').getAttribute('aria-label')).toMatch(
      /add context to this message/i,
    );
  });
});
