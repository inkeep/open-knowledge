import { describe, expect, test, vi } from 'vitest';
import {
  classifyInstallFailure,
  detectGraphicalAuthCommand,
  GRAPHICAL_AUTH_COMMANDS,
  hasCommandOnPath,
  type LinuxManualInstallContext,
  type ManualInstallDialogDeps,
  type ManualInstallDialogRequest,
  manualInstallPlanFor,
  runManualInstallFallbackDialog,
  shellSingleQuote,
} from './linux-install-fallback.ts';

describe('shellSingleQuote', () => {
  test('wraps plain paths', () => {
    expect(shellSingleQuote('/tmp/pkg.deb')).toBe("'/tmp/pkg.deb'");
  });

  test('spaces, $, backticks, semicolons, newlines are inert inside single quotes', () => {
    expect(shellSingleQuote('/tmp/my pkgs/$(rm -rf ~)/a;b`c\nd.deb')).toBe(
      "'/tmp/my pkgs/$(rm -rf ~)/a;b`c\nd.deb'",
    );
  });

  test('embedded single quotes re-quote safely', () => {
    expect(shellSingleQuote("/tmp/o'brien.deb")).toBe("'/tmp/o'\\''brien.deb'");
  });
});

describe('manualInstallPlanFor', () => {
  test('deb → sudo apt install with option-parsing stop', () => {
    expect(manualInstallPlanFor('/cache/pending/ok_0.48.0_arm64.deb')).toEqual({
      packageKind: 'deb',
      command: "sudo apt install -- '/cache/pending/ok_0.48.0_arm64.deb'",
    });
  });

  test('rpm → sudo dnf install', () => {
    expect(manualInstallPlanFor('/cache/pending/ok-0.48.0.x86_64.rpm')).toEqual({
      packageKind: 'rpm',
      command: "sudo dnf install '/cache/pending/ok-0.48.0.x86_64.rpm'",
    });
  });

  test('extension match is case-insensitive', () => {
    expect(manualInstallPlanFor('/x/OK.DEB')?.packageKind).toBe('deb');
  });

  test('unknown format and missing path return null', () => {
    expect(manualInstallPlanFor('/x/OpenKnowledge.AppImage')).toBeNull();
    expect(manualInstallPlanFor(null)).toBeNull();
    expect(manualInstallPlanFor('')).toBeNull();
  });

  test('arbitrary paths are quoted, and no trust-bypass flags ever appear', () => {
    const hostile = "/tmp/a b'; rm -rf ~ #/pkg.deb";
    const plan = manualInstallPlanFor(hostile);
    expect(plan?.command).toBe(`sudo apt install -- ${shellSingleQuote(hostile)}`);
    for (const path of [hostile, '/plain/pkg.deb', '/plain/pkg.rpm']) {
      const command = manualInstallPlanFor(path)?.command ?? '';
      expect(command).not.toContain('--allow-unauthenticated');
      expect(command).not.toContain('--nogpgcheck');
    }
  });
});

describe('classifyInstallFailure', () => {
  test('pkexec exit 126 (user dismissed the auth dialog) → cancelled', () => {
    expect(classifyInstallFailure('Command pkexec exited with code 126')).toBe('cancelled');
  });

  test('exit 127 (authorization unobtainable / no agent) → infrastructure', () => {
    expect(classifyInstallFailure('Command pkexec exited with code 127')).toBe('infrastructure');
  });

  test('sudo no-tty and unrecognized shapes → infrastructure', () => {
    expect(classifyInstallFailure('Command sudo exited with code 1')).toBe('infrastructure');
    expect(classifyInstallFailure('spawn ENOENT')).toBe('infrastructure');
    expect(classifyInstallFailure(undefined)).toBe('infrastructure');
  });

  test('126 must be the whole exit code, not a prefix', () => {
    expect(classifyInstallFailure('Command pkexec exited with code 1260')).toBe('infrastructure');
  });
});

describe('detectGraphicalAuthCommand', () => {
  test('returns the first wrapper found in electron-updater probe order', () => {
    expect(detectGraphicalAuthCommand((cmd) => cmd === 'pkexec')).toBe('pkexec');
    expect(detectGraphicalAuthCommand((cmd) => cmd === 'kdesudo' || cmd === 'beesu')).toBe(
      'kdesudo',
    );
  });

  test('returns null when nothing is available (plain sudo does not count)', () => {
    expect(detectGraphicalAuthCommand(() => false)).toBeNull();
  });

  test('each probe gets the remaining shared budget, capped at the per-probe ceiling', () => {
    const timeouts: number[] = [];
    // Clock advances 1500ms per probe: remaining budget shrinks 4000 → 2500
    // → 1000, so the third probe gets less than the 2000ms ceiling.
    let clock = 0;
    const now = () => clock;
    const hasCommand = vi.fn((_cmd: string, timeoutMs: number) => {
      timeouts.push(timeoutMs);
      clock += 1500;
      return false;
    });
    expect(detectGraphicalAuthCommand(hasCommand, now)).toBeNull();
    expect(timeouts).toEqual([2000, 2000, 1000]);
    // The fourth wrapper is never probed — the budget was spent.
    expect(hasCommand).toHaveBeenCalledTimes(3);
  });

  test('budget exhaustion mid-sweep stops probing instead of serially blocking', () => {
    let clock = 0;
    const now = () => clock;
    const hasCommand = vi.fn((_cmd: string, _timeoutMs: number) => {
      clock += 5000;
      return false;
    });
    expect(detectGraphicalAuthCommand(hasCommand, now)).toBeNull();
    expect(hasCommand).toHaveBeenCalledTimes(1);
  });

  test('probe list matches electron-updater determineSudoCommand', () => {
    expect([...GRAPHICAL_AUTH_COMMANDS]).toEqual(['gksudo', 'kdesudo', 'pkexec', 'beesu']);
  });
});

describe('hasCommandOnPath', () => {
  test('probes via `command -v` through a shell (load-bearing: `command` is a shell built-in)', () => {
    const spy = vi.fn().mockReturnValue({ error: null, status: 0 });
    expect(hasCommandOnPath('pkexec', spy as never)).toBe(true);
    // Single command string, no args array: args + `shell: true` trips
    // Node's DEP0190 deprecation warning on every probe.
    expect(spy).toHaveBeenCalledWith(
      'command -v pkexec',
      expect.objectContaining({ shell: true, timeout: 2000 }),
    );
  });

  test('refuses to probe non-bare command names (interpolation guard)', () => {
    const spy = vi.fn().mockReturnValue({ error: null, status: 0 });
    for (const hostile of ['pk exec', 'pkexec; rm -rf ~', '$(reboot)', '`id`', 'a|b', '']) {
      expect(hasCommandOnPath(hostile, spy as never)).toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  test('status 0 → true, non-zero → false, spawn error → false', () => {
    expect(
      hasCommandOnPath('x', vi.fn().mockReturnValue({ error: null, status: 0 }) as never),
    ).toBe(true);
    expect(
      hasCommandOnPath('x', vi.fn().mockReturnValue({ error: null, status: 1 }) as never),
    ).toBe(false);
    expect(
      hasCommandOnPath(
        'x',
        vi.fn().mockReturnValue({ error: new Error('ENOENT'), status: null }) as never,
      ),
    ).toBe(false);
    expect(
      hasCommandOnPath(
        'x',
        vi.fn(() => {
          throw new Error('spawn failed');
        }) as never,
      ),
    ).toBe(false);
  });
});

describe('runManualInstallFallbackDialog', () => {
  const ctx: LinuxManualInstallContext = {
    version: '0.48.0',
    installerPath: '/cache/pending/ok.deb',
    packageKind: 'deb',
    command: "sudo apt install -- '/cache/pending/ok.deb'",
  };

  function makeDeps(responses: number[]): ManualInstallDialogDeps & {
    shown: ReturnType<typeof vi.fn>;
    copied: ReturnType<typeof vi.fn>;
    relaunched: ReturnType<typeof vi.fn>;
  } {
    const queue = [...responses];
    const shown = vi.fn(async (_request: ManualInstallDialogRequest) => ({
      response: queue.shift() ?? 2,
    }));
    const copied = vi.fn();
    const relaunched = vi.fn();
    return {
      shown,
      copied,
      relaunched,
      showDialog: shown,
      copyCommandToClipboard: copied,
      relaunchApp: relaunched,
    };
  }

  test('Not now dismisses without copying or relaunching', async () => {
    const deps = makeDeps([2]);
    await expect(runManualInstallFallbackDialog(deps, ctx)).resolves.toBe('dismissed');
    expect(deps.copied).not.toHaveBeenCalled();
    expect(deps.relaunched).not.toHaveBeenCalled();
    expect(deps.shown).toHaveBeenCalledTimes(1);
  });

  test('Copy Command copies the exact command and re-shows the dialog', async () => {
    const deps = makeDeps([0, 0, 2]);
    await expect(runManualInstallFallbackDialog(deps, ctx)).resolves.toBe('dismissed');
    expect(deps.copied).toHaveBeenCalledTimes(2);
    expect(deps.copied).toHaveBeenCalledWith(ctx.command);
    expect(deps.shown).toHaveBeenCalledTimes(3);
  });

  test('Relaunch is unconditional — fires without any install confirmation', async () => {
    const deps = makeDeps([1]);
    await expect(runManualInstallFallbackDialog(deps, ctx)).resolves.toBe('relaunch');
    expect(deps.relaunched).toHaveBeenCalledTimes(1);
  });

  test('copy-then-relaunch keeps both effects', async () => {
    const deps = makeDeps([0, 1]);
    await expect(runManualInstallFallbackDialog(deps, ctx)).resolves.toBe('relaunch');
    expect(deps.copied).toHaveBeenCalledWith(ctx.command);
    expect(deps.relaunched).toHaveBeenCalledTimes(1);
  });

  test('a dialog rejection mid-loop (parent window destroyed) resolves as dismissal', async () => {
    const copied = vi.fn();
    const relaunched = vi.fn();
    let calls = 0;
    const deps: ManualInstallDialogDeps = {
      showDialog: async () => {
        calls += 1;
        if (calls === 1) return { response: 0 };
        throw new Error('Object has been destroyed');
      },
      copyCommandToClipboard: copied,
      relaunchApp: relaunched,
    };
    await expect(runManualInstallFallbackDialog(deps, ctx)).resolves.toBe('dismissed');
    expect(copied).toHaveBeenCalledWith(ctx.command);
    expect(relaunched).not.toHaveBeenCalled();
  });

  test('dialog copy shows the command and offers the three actions', async () => {
    const deps = makeDeps([2]);
    await runManualInstallFallbackDialog(deps, ctx);
    const request = deps.shown.mock.calls[0]?.[0] as {
      detail: string;
      buttons: string[];
      cancelId: number;
    };
    expect(request.detail).toContain(ctx.command);
    expect(request.buttons).toEqual(['Copy Command', 'Relaunch OpenKnowledge', 'Not Now']);
    expect(request.cancelId).toBe(2);
  });
});
