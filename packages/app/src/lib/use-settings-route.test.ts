import { describe, expect, test } from 'bun:test';
import { isSettingsHashOpen, isSettingsShortcut, SETTINGS_OPEN_HASH } from './use-settings-route';

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

  test('legacy sub-routes are no longer recognized', () => {
    expect(isSettingsHashOpen('#settings/project')).toBe(false);
    expect(isSettingsHashOpen('#settings/user')).toBe(false);
  });

  test('typo / unrecognized hash → false', () => {
    expect(isSettingsHashOpen('#settings-typo')).toBe(false);
    expect(isSettingsHashOpen('#settings/')).toBe(false);
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
