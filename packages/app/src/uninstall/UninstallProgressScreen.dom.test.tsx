import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { UninstallProgressScreen } from './UninstallProgressScreen';

describe('uninstall progress screen', () => {
  afterEach(cleanup);

  test('says what is happening and what is being kept', () => {
    render(<UninstallProgressScreen />);

    expect(screen.getByRole('heading', { name: 'Removing OpenKnowledge files…' })).toBeDefined();
    expect(
      screen.getByText('This may take a moment. Your markdown content is kept.'),
    ).toBeDefined();
  });

  test('announces itself as busy without asking for anything', () => {
    render(<UninstallProgressScreen />);

    // Cleanup is already running and cannot be answered, waived or interrupted;
    // main also refuses to let this window close while it runs.
    expect(screen.getByRole('status')).toBeDefined();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
