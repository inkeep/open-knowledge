import { describe, expect, test } from 'vitest';

import {
  isDesktopTargetEnabled,
  isInAppAgentEnabled,
  isTerminalCliEnabled,
} from './agent-visibility';
import { desktopEnabledKey, inAppEnabledKey, terminalEnabledKey } from './enabled-agents';

describe('agent-visibility — in-app', () => {
  test('defaults to registered; override wins either way', () => {
    expect(isInAppAgentEnabled({}, 'registry', 'claude', true, true)).toBe(true);
    expect(isInAppAgentEnabled({}, 'registry', 'claude', false, true)).toBe(false);
    const key = inAppEnabledKey('registry', 'claude');
    expect(isInAppAgentEnabled({ [key]: false }, 'registry', 'claude', true, true)).toBe(false);
    expect(isInAppAgentEnabled({ [key]: true }, 'registry', 'claude', false, true)).toBe(true);
  });

  test('supported: undefined fails open (catalog not yet hydrated)', () => {
    expect(isInAppAgentEnabled({}, 'registry', 'claude', true, undefined)).toBe(true);
  });

  test('supported: false force-hides regardless of override or registration', () => {
    const key = inAppEnabledKey('registry', 'cursor');
    expect(isInAppAgentEnabled({}, 'registry', 'cursor', true, false)).toBe(false);
    expect(isInAppAgentEnabled({ [key]: true }, 'registry', 'cursor', true, false)).toBe(false);
  });
});

describe('agent-visibility — terminal (fail-open default)', () => {
  test('Claude is not special-cased: hidden when the probe reports it absent', () => {
    expect(isTerminalCliEnabled({}, 'claude', {})).toBe(true);
    expect(isTerminalCliEnabled({}, 'claude', { claude: true })).toBe(true);
    expect(isTerminalCliEnabled({}, 'claude', { claude: false })).toBe(false);
  });

  test('other CLIs default enabled unless positively absent', () => {
    expect(isTerminalCliEnabled({}, 'codex', {})).toBe(true);
    expect(isTerminalCliEnabled({}, 'codex', { codex: true })).toBe(true);
    expect(isTerminalCliEnabled({}, 'codex', { codex: false })).toBe(false);
  });

  test('override wins over the fail-open default', () => {
    const key = terminalEnabledKey('codex');
    expect(isTerminalCliEnabled({ [key]: true }, 'codex', { codex: false })).toBe(true);
    expect(isTerminalCliEnabled({ [key]: false }, 'codex', { codex: true })).toBe(false);
    expect(isTerminalCliEnabled({ [terminalEnabledKey('claude')]: false }, 'claude', {})).toBe(
      false,
    );
  });
});

describe('agent-visibility — desktop (detected by default)', () => {
  test('follows install detection; a pending probe stays hidden', () => {
    expect(isDesktopTargetEnabled({}, 'claude-code', true)).toBe(true);
    expect(isDesktopTargetEnabled({}, 'codex', false)).toBe(false);
    expect(isDesktopTargetEnabled({}, 'codex', null)).toBe(false);
    expect(isDesktopTargetEnabled({}, 'codex', undefined)).toBe(false);
  });

  test('override wins — shows a not-installed target, hides an installed one', () => {
    const key = desktopEnabledKey('cursor');
    expect(isDesktopTargetEnabled({ [key]: true }, 'cursor', false)).toBe(true);
    expect(isDesktopTargetEnabled({ [key]: false }, 'cursor', true)).toBe(false);
  });
});
