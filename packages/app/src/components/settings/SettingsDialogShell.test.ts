import { describe, expect, test } from 'vitest';
import { SettingsDialogShell } from './SettingsDialogShell';

describe('SettingsDialogShell module', () => {
  test('exports SettingsDialogShell component', () => {
    expect(typeof SettingsDialogShell).toBe('function');
  });
});
