import { describe, expect, test } from 'vitest';

describe('SettingsDialogBody module', () => {
  test('exports SettingsDialogBody component', async () => {
    const mod = await import('./SettingsDialogBody');
    expect(typeof mod.SettingsDialogBody).toBe('function');
  });
});
