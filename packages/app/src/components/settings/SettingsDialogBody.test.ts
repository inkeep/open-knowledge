import { describe, expect, test } from 'bun:test';

describe('SettingsDialogBody module', () => {
  test('exports SettingsDialogBody component', async () => {
    const mod = await import('./SettingsDialogBody');
    expect(typeof mod.SettingsDialogBody).toBe('function');
  });
});
