import { describe, expect, test } from 'vitest';
import {
  isSettingsHashOpen,
  isSettingsShortcut,
  pluginSettingsSectionId,
  SETTINGS_OPEN_HASH,
  settingsHashSection,
} from './use-settings-route';

describe('isSettingsHashOpen', () => {
  test('empty hash → false', () => {
    expect(isSettingsHashOpen('')).toBe(false);
  });

  test('non-settings hash → false', () => {
    expect(isSettingsHashOpen('#/some-doc')).toBe(false);
    expect(isSettingsHashOpen('#install-claude-desktop')).toBe(false);
  });

  test('`#settings` → true', () => {
    expect(isSettingsHashOpen('#settings')).toBe(true);
  });

  test('hash without leading `#` is tolerated', () => {
    expect(isSettingsHashOpen('settings')).toBe(true);
  });

  test('section deep-links open (unknown sections fall back to the default)', () => {
    expect(isSettingsHashOpen('#settings/configure-agents')).toBe(true);
    expect(isSettingsHashOpen('#settings/project')).toBe(true);
    expect(isSettingsHashOpen('#settings/user')).toBe(true);
    expect(settingsHashSection('#settings/configure-agents')).toBe('configure-agents');
  });

  test('typo / unrecognized hash → false', () => {
    expect(isSettingsHashOpen('#settings-typo')).toBe(false);
    expect(isSettingsHashOpen('#settings/')).toBe(false);
    expect(settingsHashSection('#settings/')).toBeNull();
    expect(settingsHashSection('#settings')).toBeNull();
  });

  test('`#settings/account` (the trust-gate Connect target) → true', () => {
    expect(isSettingsHashOpen('#settings/account')).toBe(true);
  });
});

describe('settingsHashSection', () => {
  test('`#settings/account` (the trust-gate Connect target) → "account"', () => {
    expect(settingsHashSection('#settings/account')).toBe('account');
  });

  test('non-settings hash → null', () => {
    expect(settingsHashSection('#/some-doc')).toBeNull();
  });

  test('round-trips a `plugin:<id>` section (the colon survives the parse)', () => {
    const hash = `#settings/${pluginSettingsSectionId('frontmatter')}`;
    expect(isSettingsHashOpen(hash)).toBe(true);
    expect(settingsHashSection(hash)).toBe('plugin:frontmatter');
  });
});

describe('SETTINGS_OPEN_HASH', () => {
  test('is the canonical `#settings` literal', () => {
    expect(SETTINGS_OPEN_HASH).toBe('#settings');
    expect(isSettingsHashOpen(SETTINGS_OPEN_HASH)).toBe(true);
  });
});

describe('isSettingsShortcut', () => {
  function ev(overrides: Partial<Parameters<typeof isSettingsShortcut>[0]> = {}) {
    return {
      target: null,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      key: ',',
      ...overrides,
    };
  }

  test('Cmd+, on macOS-shaped event → true', () => {
    expect(isSettingsShortcut(ev({ metaKey: true, key: ',' }))).toBe(true);
  });

  test('Ctrl+, on Windows/Linux-shaped event → true', () => {
    expect(isSettingsShortcut(ev({ ctrlKey: true, key: ',' }))).toBe(true);
  });

  test('plain "," (no modifier) → false', () => {
    expect(isSettingsShortcut(ev({ key: ',' }))).toBe(false);
  });

  test('Cmd+Alt+, → false (avoid hijacking other modifier combinations)', () => {
    expect(isSettingsShortcut(ev({ metaKey: true, altKey: true, key: ',' }))).toBe(false);
  });

  test('Cmd+. → false (different key)', () => {
    expect(isSettingsShortcut(ev({ metaKey: true, key: '.' }))).toBe(false);
  });

  test('suppresses inside <input>', () => {
    expect(isSettingsShortcut(ev({ metaKey: true, target: { tagName: 'INPUT' } }))).toBe(false);
  });

  test('suppresses inside <textarea>', () => {
    expect(isSettingsShortcut(ev({ metaKey: true, target: { tagName: 'TEXTAREA' } }))).toBe(false);
  });

  test('suppresses inside contenteditable host', () => {
    expect(isSettingsShortcut(ev({ metaKey: true, target: { isContentEditable: true } }))).toBe(
      false,
    );
  });

  test('fires on non-form targets (button, div, body)', () => {
    expect(isSettingsShortcut(ev({ metaKey: true, target: { tagName: 'BUTTON' } }))).toBe(true);
    expect(isSettingsShortcut(ev({ metaKey: true, target: { tagName: 'DIV' } }))).toBe(true);
    expect(isSettingsShortcut(ev({ metaKey: true, target: null }))).toBe(true);
  });
});
