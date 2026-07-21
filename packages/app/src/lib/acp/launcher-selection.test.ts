import type { TerminalCli } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { IN_APP_THREAD_ID, terminalCliId } from '../unified-agent-store';
import {
  desktopEnabledKey,
  type EnabledOverrides,
  inAppEnabledKey,
  terminalEnabledKey,
} from './enabled-agents';
import {
  enabledDesktopTargets,
  enabledTerminalClis,
  enabledThreadAgents,
  type LauncherSelectionInputs,
  resolveLauncherSelection,
} from './launcher-selection';
import type { RegisteredAgent } from './registered-agents';

const claude: RegisteredAgent = { source: 'registry', id: 'claude-acp', name: 'Claude' };
const codexAgent: RegisteredAgent = { source: 'registry', id: 'codex-acp', name: 'Codex' };

const base: LauncherSelectionInputs = {
  sticky: null,
  effectiveThreadAgent: null,
  enabledClis: [],
  enabledDesktopTargets: [],
  installedClis: {},
  terminalAvailable: true,
  threadsAvailable: true,
  desktopSelectable: false,
};

function inputs(over: Partial<LauncherSelectionInputs>): LauncherSelectionInputs {
  return { ...base, ...over };
}

describe('enabled-set helpers', () => {
  test('enabledThreadAgents drops disabled + keeps registered-by-default', () => {
    const key = inAppEnabledKey('registry', 'codex-acp');
    const overrides: EnabledOverrides = { [key]: false };
    expect(enabledThreadAgents([claude, codexAgent], overrides).map((a) => a.id)).toEqual([
      'claude-acp',
    ]);
  });

  test('enabledTerminalClis: fail-open unless probed absent or toggled off', () => {
    const overrides: EnabledOverrides = { [terminalEnabledKey('codex')]: false };
    const clis = enabledTerminalClis(overrides, { cursor: false });
    expect(clis).toContain('claude'); // unknown install → shown
    expect(clis).not.toContain('codex'); // toggled off
    expect(clis).not.toContain('cursor'); // probed absent
  });

  test('enabledDesktopTargets: off by default, on with an override', () => {
    expect(enabledDesktopTargets({})).toEqual([]);
    expect(enabledDesktopTargets({ [desktopEnabledKey('cursor')]: true })).toEqual(['cursor']);
  });
});

describe('resolveLauncherSelection — defaults', () => {
  test('leads with the effective in-app agent (thread-first)', () => {
    expect(resolveLauncherSelection(inputs({ effectiveThreadAgent: claude }))).toEqual({
      kind: 'thread',
      agent: claude,
    });
  });

  test('no in-app agent but an enabled CLI → that CLI', () => {
    expect(
      resolveLauncherSelection(inputs({ effectiveThreadAgent: null, enabledClis: ['codex'] })),
    ).toEqual({ kind: 'cli', cli: 'codex' });
  });

  test('default CLI prefers an installed enabled CLI over an unknown-install one', () => {
    const clis: TerminalCli[] = ['claude', 'codex'];
    expect(
      resolveLauncherSelection(
        inputs({ effectiveThreadAgent: null, enabledClis: clis, installedClis: { codex: true } }),
      ),
    ).toEqual({ kind: 'cli', cli: 'codex' });
  });

  test('nothing enabled → none (composer) or bare terminal (dock)', () => {
    expect(resolveLauncherSelection(inputs({}))).toEqual({ kind: 'none' });
    expect(resolveLauncherSelection(inputs({ bareTerminalFallback: true }))).toEqual({
      kind: 'terminal',
    });
  });

  test('preferBareTerminal wins on a terminal surface', () => {
    expect(
      resolveLauncherSelection(inputs({ preferBareTerminal: true, effectiveThreadAgent: claude })),
    ).toEqual({ kind: 'terminal' });
  });
});

describe('resolveLauncherSelection — remembered pick honored only when still enabled', () => {
  test('thread sticky → the effective agent', () => {
    expect(
      resolveLauncherSelection(
        inputs({ sticky: IN_APP_THREAD_ID, effectiveThreadAgent: codexAgent }),
      ),
    ).toEqual({ kind: 'thread', agent: codexAgent });
  });

  test('CLI sticky that is still enabled → that CLI', () => {
    expect(
      resolveLauncherSelection(inputs({ sticky: terminalCliId('codex'), enabledClis: ['codex'] })),
    ).toEqual({ kind: 'cli', cli: 'codex' });
  });

  test('BUG 2: a CLI sticky the user disabled is NOT kept — it degrades', () => {
    // sticky = claude CLI, but claude is no longer enabled and no other CLI is
    // either; an in-app agent is enabled → fall to it (never the disabled CLI).
    const result = resolveLauncherSelection(
      inputs({
        sticky: terminalCliId('claude'),
        enabledClis: [],
        effectiveThreadAgent: claude,
      }),
    );
    expect(result).toEqual({ kind: 'thread', agent: claude });
  });

  test('BUG 2 (dock): all CLIs disabled, no in-app agent → bare terminal, never Claude CLI', () => {
    const result = resolveLauncherSelection(
      inputs({
        sticky: terminalCliId('claude'),
        enabledClis: [],
        effectiveThreadAgent: null,
        bareTerminalFallback: true,
      }),
    );
    expect(result).toEqual({ kind: 'terminal' });
  });

  test('desktop sticky honored only when enabled + desktopSelectable', () => {
    expect(
      resolveLauncherSelection(
        inputs({ sticky: 'cursor', desktopSelectable: true, enabledDesktopTargets: ['cursor'] }),
      ),
    ).toEqual({ kind: 'desktop', target: 'cursor' });
    // Not enabled → degrades (here: to none).
    expect(
      resolveLauncherSelection(
        inputs({ sticky: 'cursor', desktopSelectable: true, enabledDesktopTargets: [] }),
      ),
    ).toEqual({ kind: 'none' });
  });

  test('enabled desktop app is the default when it is the only enabled family', () => {
    // Turn on one Desktop agent with nothing picked and no in-app agent / CLI
    // enabled: the composer must default to it, not dead-end on a disabled
    // Create button with no picker to reach it.
    expect(
      resolveLauncherSelection(
        inputs({ desktopSelectable: true, enabledDesktopTargets: ['cursor'] }),
      ),
    ).toEqual({ kind: 'desktop', target: 'cursor' });
  });

  test('desktop never outranks an enabled in-app agent or CLI as the default', () => {
    // In-app agent wins.
    expect(
      resolveLauncherSelection(
        inputs({
          desktopSelectable: true,
          enabledDesktopTargets: ['cursor'],
          effectiveThreadAgent: claude,
        }),
      ),
    ).toEqual({ kind: 'thread', agent: claude });
    // No in-app agent, but an enabled CLI still wins over desktop.
    expect(
      resolveLauncherSelection(
        inputs({
          desktopSelectable: true,
          enabledDesktopTargets: ['cursor'],
          enabledClis: ['codex'],
        }),
      ),
    ).toEqual({ kind: 'cli', cli: 'codex' });
  });
});

describe('resolveLauncherSelection — surface capabilities', () => {
  test('terminal window (no threads): a thread sticky degrades to a CLI', () => {
    expect(
      resolveLauncherSelection(
        inputs({
          sticky: IN_APP_THREAD_ID,
          threadsAvailable: false,
          effectiveThreadAgent: claude,
          enabledClis: ['claude'],
        }),
      ),
    ).toEqual({ kind: 'cli', cli: 'claude' });
  });

  test('web (no terminal): a CLI sticky degrades to the in-app agent', () => {
    expect(
      resolveLauncherSelection(
        inputs({
          sticky: terminalCliId('codex'),
          terminalAvailable: false,
          enabledClis: ['codex'],
          effectiveThreadAgent: claude,
        }),
      ),
    ).toEqual({ kind: 'thread', agent: claude });
  });
});
