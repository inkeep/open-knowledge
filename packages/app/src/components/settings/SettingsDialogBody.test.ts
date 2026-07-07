/**
 * Module smoke for the lazy Settings dialog body.
 *
 * Runtime behavior lives in:
 * - `SettingsDialogBody.dom.test.tsx` for preferences form binding + L3 rejection feedback.
 * - `SettingsDialogBody.sections.dom.test.tsx` for section dispatch, Sync, Okignore, and Integrations wiring.
 */

import { describe, expect, test } from 'bun:test';

describe('SettingsDialogBody module', () => {
  test('exports SettingsDialogBody component', async () => {
    const mod = await import('./SettingsDialogBody');
    expect(typeof mod.SettingsDialogBody).toBe('function');
  });
});
