import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { sweepWindowsUpdateSurvivors } from '../../src/main/windows-update-survivor-sweep.ts';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: vi.fn(),
}));

const execFileSyncMock = vi.mocked(execFileSync);

const INSTALL_TREE = 'C:\\Program Files\\Open Knowledge\\resources';
const WIN_ENV = { SystemRoot: 'C:\\Windows' };
const BOM = '\uFEFF';

const OWNED_HOST = String.raw`{"processId":101,"name":"OpenConsole.exe","executablePath":"C:\\Program Files\\Open Knowledge\\resources\\node-pty\\OpenConsole.exe","commandLine":null,"creationDate":"2026-08-25T12:00:00.0000000Z"}`;

function sweepProcessListOutput(output: string) {
  execFileSyncMock.mockReturnValue(output);
  const terminated: number[] = [];
  const info: Record<string, unknown>[] = [];
  const warnings: Record<string, unknown>[] = [];
  const result = sweepWindowsUpdateSurvivors({
    platform: 'win32',
    env: WIN_ENV,
    installTree: INSTALL_TREE,
    terminateProcess: (pid) => terminated.push(pid),
    logger: { info: (event) => info.push(event), warn: (event) => warnings.push(event) },
  });
  return { result, terminated, info, warnings };
}

beforeEach(() => {
  execFileSyncMock.mockReset();
});

describe('sweepWindowsUpdateSurvivors reading a real PowerShell process list', () => {
  test('terminates the owned host when the output carries a UTF-8 BOM', () => {
    const foreignHost = String.raw`{"processId":201,"name":"conhost.exe","executablePath":"C:\\Windows\\System32\\conhost.exe","commandLine":null,"creationDate":"2026-08-25T12:00:00.0000000Z"}`;

    const { result, terminated } = sweepProcessListOutput(`${BOM}[${OWNED_HOST},${foreignHost}]`);

    expect(terminated).toEqual([101]);
    expect(result).toEqual({
      candidateCount: 1,
      terminatedCount: 1,
      failedCount: 0,
      scanFailed: false,
      revalidationFailed: false,
    });
  });

  test('terminates the owned host from a one-element array', () => {
    const { result, terminated } = sweepProcessListOutput(`[${OWNED_HOST}]`);

    expect(terminated).toEqual([101]);
    expect(result).toEqual({
      candidateCount: 1,
      terminatedCount: 1,
      failedCount: 0,
      scanFailed: false,
      revalidationFailed: false,
    });
  });

  test('revalidates multiple candidates in one PID-filtered query', () => {
    const secondOwnedHost = OWNED_HOST.replace('"processId":101', '"processId":102');

    const { result, terminated } = sweepProcessListOutput(`[${OWNED_HOST},${secondOwnedHost}]`);

    expect(result).toEqual({
      candidateCount: 2,
      terminatedCount: 2,
      failedCount: 0,
      scanFailed: false,
      revalidationFailed: false,
    });
    expect(terminated).toEqual([101, 102]);
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    const revalidationArgs = execFileSyncMock.mock.calls[1]?.[1];
    expect(revalidationArgs).toEqual(expect.arrayContaining(['-Command']));
    expect(revalidationArgs?.at(-1)).toContain(
      'Get-CimInstance Win32_Process -Filter "ProcessId = 101 OR ProcessId = 102"',
    );
  });

  test('skips records with a null or absent creation date and sweeps the rest', () => {
    const nullCreationDate = String.raw`{"processId":102,"name":"OpenConsole.exe","executablePath":"C:\\Program Files\\Open Knowledge\\resources\\node-pty\\OpenConsole.exe","commandLine":null,"creationDate":null}`;
    const noCreationDate = String.raw`{"processId":103,"name":"OpenConsole.exe","executablePath":"C:\\Program Files\\Open Knowledge\\resources\\node-pty\\OpenConsole.exe","commandLine":null}`;

    const { result, terminated, info, warnings } = sweepProcessListOutput(
      `[${OWNED_HOST},${nullCreationDate},${noCreationDate}]`,
    );

    expect(terminated).toEqual([101]);
    expect(result).toEqual({
      candidateCount: 1,
      terminatedCount: 1,
      failedCount: 0,
      scanFailed: false,
      revalidationFailed: false,
    });
    expect(info).toContainEqual({
      event: 'windows-update-survivor-sweep',
      candidateCount: 1,
      terminatedCount: 1,
      failedCount: 0,
      scanFailed: false,
      revalidationFailed: false,
    });
    expect(warnings).toEqual([]);
  });

  test('skips malformed records and sweeps the rest', () => {
    const garbage = [
      'null',
      '"OpenConsole.exe"',
      '42',
      '[]',
      String.raw`{"processId":"104","name":"OpenConsole.exe","executablePath":"C:\\Program Files\\Open Knowledge\\resources\\OpenConsole.exe","commandLine":null,"creationDate":"2026-08-25T12:00:00.0000000Z"}`,
      String.raw`{"processId":0,"name":"OpenConsole.exe","executablePath":"C:\\Program Files\\Open Knowledge\\resources\\OpenConsole.exe","commandLine":null,"creationDate":"2026-08-25T12:00:00.0000000Z"}`,
      String.raw`{"processId":105,"name":42,"executablePath":"C:\\Program Files\\Open Knowledge\\resources\\OpenConsole.exe","commandLine":null,"creationDate":"2026-08-25T12:00:00.0000000Z"}`,
    ].join(',');

    const { result, terminated, warnings } = sweepProcessListOutput(`[${OWNED_HOST},${garbage}]`);

    expect(terminated).toEqual([101]);
    expect(result).toEqual({
      candidateCount: 1,
      terminatedCount: 1,
      failedCount: 0,
      scanFailed: false,
      revalidationFailed: false,
    });
    expect(warnings).toEqual([]);
  });

  test('abandons the sweep when the output is not a JSON array', () => {
    const { result, terminated, warnings } = sweepProcessListOutput(OWNED_HOST);

    expect(terminated).toEqual([]);
    expect(result).toEqual({
      candidateCount: 0,
      terminatedCount: 0,
      failedCount: 0,
      scanFailed: true,
      revalidationFailed: false,
    });
    expect(warnings).toContainEqual({
      event: 'windows-update-survivor-scan-failed',
      code: 'unknown',
    });
  });

  test('reports a clean no-survivors sweep when the query prints nothing', () => {
    for (const output of ['', '\r\n', `${BOM}\r\n`]) {
      const { result, terminated, info, warnings } = sweepProcessListOutput(output);

      expect(terminated).toEqual([]);
      expect(result).toEqual({
        candidateCount: 0,
        terminatedCount: 0,
        failedCount: 0,
        scanFailed: false,
        revalidationFailed: false,
      });
      expect(info).toContainEqual({
        event: 'windows-update-survivor-sweep',
        candidateCount: 0,
        terminatedCount: 0,
        failedCount: 0,
        scanFailed: false,
        revalidationFailed: false,
      });
      expect(warnings).toEqual([]);
    }
  });
});
