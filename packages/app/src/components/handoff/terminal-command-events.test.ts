import { describe, expect, test, vi } from 'vitest';
import {
  requestTerminalCommand,
  subscribeToTerminalCommandRequests,
  terminalCommandFor,
  windowsTerminalCommandFor,
} from './terminal-command-events';

describe('terminalCommandFor', () => {
  test('resolves the install id to a command naming BOTH packages', () => {
    const cmd = terminalCommandFor('install-slidev');
    expect(cmd).toContain('@slidev/cli');
    expect(cmd).toContain('@slidev/theme-default');
  });

  test('resolves nothing for an id outside the union', () => {
    expect(terminalCommandFor('rm -rf /')).toBeUndefined();
    expect(terminalCommandFor('constructor')).toBeUndefined();
    expect(terminalCommandFor('__proto__')).toBeUndefined();
  });

  test('keeps the Windows install command structured until shell composition', () => {
    expect(windowsTerminalCommandFor('install-slidev')).toEqual({
      executable: 'npm',
      args: ['install', '-g', '@slidev/cli', '@slidev/theme-default'],
    });
    expect(windowsTerminalCommandFor('git-status')).toEqual({
      executable: 'git',
      args: ['status'],
    });
    expect(windowsTerminalCommandFor('npm publish')).toBeUndefined();
  });
});

describe('the bus', () => {
  test('delivers a known id to a subscriber', () => {
    const target = new EventTarget();
    const seen = vi.fn();
    const unsubscribe = subscribeToTerminalCommandRequests(seen, target);

    requestTerminalCommand('install-slidev', target);

    expect(seen).toHaveBeenCalledWith('install-slidev');
    unsubscribe();
  });

  test('drops an event whose id is not in the union', () => {
    const target = new EventTarget();
    const seen = vi.fn();
    const unsubscribe = subscribeToTerminalCommandRequests(seen, target);

    target.dispatchEvent(
      new CustomEvent('open-knowledge:terminal-command', { detail: 'npm publish' }),
    );

    expect(seen).not.toHaveBeenCalled();
    unsubscribe();
  });

  test('stops delivering after unsubscribe', () => {
    const target = new EventTarget();
    const seen = vi.fn();
    subscribeToTerminalCommandRequests(seen, target)();

    requestTerminalCommand('install-slidev', target);

    expect(seen).not.toHaveBeenCalled();
  });
});
