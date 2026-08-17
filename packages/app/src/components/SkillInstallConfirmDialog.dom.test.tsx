/**
 * RTL tests for the built-in-skill install/uninstall consent modal. They pin the
 * consent contract: the skill is named with its own description, the full
 * three-tier cost is shown (unlike the compact row, on-demand included), every
 * destination path is listed including a custom root, and nothing is written
 * until the user confirms. They also pin the safety behaviour — a destination
 * set that shifts underneath the open dialog forces a re-read before it can
 * commit. The AlertDialog and the estimator-fed cost run for real; only the
 * Lingui macros are shimmed to their English passthrough.
 */
import type { SkillCostTiers } from '@inkeep/open-knowledge-core';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as linguiShim from '../../tests/lingui-macro-shim';

vi.doMock('@lingui/react/macro', () => linguiShim);

const { SkillInstallConfirmDialog } = await import('./SkillInstallConfirmDialog');

type Props = Parameters<typeof SkillInstallConfirmDialog>[0];

function props(overrides: Partial<Props> = {}): Props {
  return {
    open: true,
    onOpenChange: vi.fn(),
    mode: 'install',
    name: 'open-knowledge-discovery',
    description: 'Helps your agent recognize OpenKnowledge projects.',
    paths: [
      '~/.claude/skills/open-knowledge-discovery',
      '~/.cursor/skills/open-knowledge-discovery',
    ],
    onConfirm: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);

describe('SkillInstallConfirmDialog', () => {
  test('names the skill and shows its own description', () => {
    render(<SkillInstallConfirmDialog {...props()} />);
    expect(screen.getByText('Install open-knowledge-discovery')).toBeTruthy();
    expect(screen.getByText('Helps your agent recognize OpenKnowledge projects.')).toBeTruthy();
  });

  test('shows the full three-tier cost, on-demand included', () => {
    const size: SkillCostTiers = { alwaysOn: 156, onTrigger: 3218, onDemand: 916 };
    render(<SkillInstallConfirmDialog {...props({ size })} />);
    const text = screen.getByTestId('skill-cost-value').textContent ?? '';
    expect(text).toContain('~156');
    expect(text).toContain('always-on');
    expect(text).toContain('~3.2k');
    expect(text).toContain('on trigger');
    // The modal is the full disclosure, so on-demand is present here even though
    // the compact install row omits it.
    expect(text).toContain('~916');
    expect(text).toContain('on demand');
  });

  test('lists every destination, including a declared custom root', () => {
    const paths = [
      '~/.claude/skills/open-knowledge-discovery',
      '~/.cursor/skills/open-knowledge-discovery',
      '/Users/me/.myagent/skills/open-knowledge-discovery',
    ];
    render(<SkillInstallConfirmDialog {...props({ paths })} />);
    const list = screen.getByTestId('skill-destination-list');
    for (const path of paths) {
      expect(within(list).getByText(path)).toBeTruthy();
    }
  });

  test('writes nothing on open or on cancel', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(<SkillInstallConfirmDialog {...props({ onConfirm, onOpenChange })} />);
    // Merely opening the dialog commits nothing.
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test('confirming commits the destination set that is shown', () => {
    const onConfirm = vi.fn();
    render(<SkillInstallConfirmDialog {...props({ onConfirm })} />);
    fireEvent.click(screen.getByTestId('skill-confirm-primary'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  test('a destination change while open requires a re-read before it commits', () => {
    const onConfirm = vi.fn();
    const base = props({ onConfirm, paths: ['~/.claude/skills/x'] });
    const { rerender } = render(<SkillInstallConfirmDialog {...base} />);
    expect(screen.queryByTestId('skill-destinations-changed')).toBeNull();

    // A host appears underneath the open dialog.
    rerender(
      <SkillInstallConfirmDialog {...base} paths={['~/.claude/skills/x', '~/.cursor/skills/x']} />,
    );
    expect(screen.getByTestId('skill-destinations-changed')).toBeTruthy();

    // The first click acknowledges the fresh list rather than committing it.
    fireEvent.click(screen.getByTestId('skill-confirm-primary'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId('skill-destinations-changed')).toBeNull();

    // Having re-read, the next click commits.
    fireEvent.click(screen.getByTestId('skill-confirm-primary'));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  test('the uninstall variant confirms removal over the paths that will be removed', () => {
    const onConfirm = vi.fn();
    render(<SkillInstallConfirmDialog {...props({ mode: 'uninstall', onConfirm })} />);
    expect(screen.getByText('Uninstall open-knowledge-discovery')).toBeTruthy();
    expect(screen.getByText('Removes from')).toBeTruthy();
    const primary = screen.getByTestId('skill-confirm-primary');
    expect(primary.textContent).toContain('Uninstall');
    fireEvent.click(primary);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
