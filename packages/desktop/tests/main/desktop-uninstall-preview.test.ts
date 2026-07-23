import { describe, expect, it } from 'vitest';
import { resolveDesktopUninstallUiPreviewMode } from '../../src/main/desktop-uninstall.ts';

describe('resolveDesktopUninstallUiPreviewMode', () => {
  it('stays off in a packaged build regardless of the env value', () => {
    expect(resolveDesktopUninstallUiPreviewMode('success', true)).toBeNull();
    expect(resolveDesktopUninstallUiPreviewMode('failure', true)).toBeNull();
    expect(resolveDesktopUninstallUiPreviewMode('1', true)).toBeNull();
  });

  it('maps the success aliases in a dev build', () => {
    for (const raw of ['success', '1', 'true']) {
      expect(resolveDesktopUninstallUiPreviewMode(raw, false)).toBe('success');
    }
  });

  it('maps the failure aliases in a dev build', () => {
    for (const raw of ['failure', 'fail']) {
      expect(resolveDesktopUninstallUiPreviewMode(raw, false)).toBe('failure');
    }
  });

  it('stays off when unset or unrecognized', () => {
    expect(resolveDesktopUninstallUiPreviewMode(undefined, false)).toBeNull();
    expect(resolveDesktopUninstallUiPreviewMode('', false)).toBeNull();
    expect(resolveDesktopUninstallUiPreviewMode('yes', false)).toBeNull();
    expect(resolveDesktopUninstallUiPreviewMode('SUCCESS', false)).toBeNull();
  });
});
