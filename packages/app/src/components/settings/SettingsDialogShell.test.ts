import { describe, expect, test } from 'vitest';

describe('SettingsDialogShell module', () => {
  test('exports SettingsDialogShell component', async () => {
    const mod = await import('./SettingsDialogShell');
    expect(typeof mod.SettingsDialogShell).toBe('function');
  });
});
