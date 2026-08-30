import { describe, expect, test } from 'vitest';
import { sweepWindowsUpdateSurvivors } from '../../src/main/windows-update-survivor-sweep.ts';

const INSTALL_TREE = 'C:\\Program Files\\Open Knowledge\\resources';
const CREATED = '2026-08-25T12:00:00.0000000Z';

describe('sweepWindowsUpdateSurvivors', () => {
  test('terminates only console hosts owned by the install tree and logs the sweep', () => {
    const terminated: number[] = [];
    const info: Record<string, unknown>[] = [];
    const result = sweepWindowsUpdateSurvivors({
      platform: 'win32',
      installTree: INSTALL_TREE,
      listProcesses: () => [
        {
          processId: 101,
          name: 'OpenConsole.exe',
          executablePath: `${INSTALL_TREE}\\app.asar.unpacked\\node_modules\\node-pty\\OpenConsole.exe`,
          commandLine: null,
          creationDate: CREATED,
        },
        {
          processId: 102,
          name: 'OpenConsole.exe',
          executablePath: null,
          commandLine: `"${INSTALL_TREE}\\node-pty\\OpenConsole.exe" --server`,
          creationDate: CREATED,
        },
        {
          processId: 201,
          name: 'OpenConsole.exe',
          executablePath: 'D:\\Other App\\OpenConsole.exe',
          commandLine: null,
          creationDate: CREATED,
        },
        {
          processId: 202,
          name: 'conhost.exe',
          executablePath: 'C:\\Windows\\System32\\conhost.exe',
          commandLine: `conhost.exe --title "${INSTALL_TREE}\\mentioned-only"`,
          creationDate: CREATED,
        },
        {
          processId: 203,
          name: 'OpenConsole.exe',
          executablePath: `${INSTALL_TREE}-old\\OpenConsole.exe`,
          commandLine: null,
          creationDate: CREATED,
        },
        {
          processId: 204,
          name: 'notepad.exe',
          executablePath: `${INSTALL_TREE}\\notepad.exe`,
          commandLine: null,
          creationDate: CREATED,
        },
      ],
      terminateProcess: (pid) => terminated.push(pid),
      logger: { info: (event) => info.push(event), warn: () => {} },
    });

    expect(terminated).toEqual([101, 102]);
    expect(result).toEqual({
      candidateCount: 2,
      terminatedCount: 2,
      failedCount: 0,
      scanFailed: false,
      revalidationFailed: false,
    });
    expect(info).toContainEqual({
      event: 'windows-update-survivor-sweep',
      candidateCount: 2,
      terminatedCount: 2,
      failedCount: 0,
      scanFailed: false,
      revalidationFailed: false,
    });
  });

  test('logs a no-survivors sweep without attempting termination', () => {
    const terminated: number[] = [];
    const info: Record<string, unknown>[] = [];
    const result = sweepWindowsUpdateSurvivors({
      platform: 'win32',
      installTree: INSTALL_TREE,
      listProcesses: () => [],
      terminateProcess: (pid) => terminated.push(pid),
      logger: { info: (event) => info.push(event), warn: () => {} },
    });

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
  });

  test('continues after one termination failure and reports the bounded diagnostic', () => {
    const warnings: Record<string, unknown>[] = [];
    const terminated: number[] = [];
    const result = sweepWindowsUpdateSurvivors({
      platform: 'win32',
      installTree: INSTALL_TREE,
      listProcesses: () => [
        {
          processId: 101,
          name: 'OpenConsole.exe',
          executablePath: `${INSTALL_TREE}\\one\\OpenConsole.exe`,
          commandLine: null,
          creationDate: CREATED,
        },
        {
          processId: 102,
          name: 'OpenConsole.exe',
          executablePath: `${INSTALL_TREE}\\two\\OpenConsole.exe`,
          commandLine: null,
          creationDate: CREATED,
        },
      ],
      terminateProcess: (pid) => {
        if (pid === 101) throw Object.assign(new Error('access denied'), { code: 'EPERM' });
        terminated.push(pid);
      },
      logger: { info: () => {}, warn: (event) => warnings.push(event) },
    });

    expect(terminated).toEqual([102]);
    expect(result).toEqual({
      candidateCount: 2,
      terminatedCount: 1,
      failedCount: 1,
      scanFailed: false,
      revalidationFailed: false,
    });
    expect(warnings).toContainEqual({
      event: 'windows-update-survivor-terminate-failed',
      processName: 'openconsole.exe',
      code: 'EPERM',
    });
    expect(warnings).toContainEqual({
      event: 'windows-update-survivor-sweep-incomplete',
      candidateCount: 2,
      terminatedCount: 1,
      failedCount: 1,
      scanFailed: false,
      revalidationFailed: false,
    });
  });

  test('does not terminate a reused PID whose creation identity changed', () => {
    const terminated: number[] = [];
    const warnings: Record<string, unknown>[] = [];
    const candidate = {
      processId: 101,
      name: 'OpenConsole.exe',
      executablePath: `${INSTALL_TREE}\\OpenConsole.exe`,
      commandLine: null,
      creationDate: CREATED,
    };
    const result = sweepWindowsUpdateSurvivors({
      platform: 'win32',
      installTree: INSTALL_TREE,
      listProcesses: () => [candidate],
      revalidateProcesses: () => [
        {
          ...candidate,
          executablePath: 'C:\\Windows\\System32\\notepad.exe',
          creationDate: '2026-08-25T12:00:01.0000000Z',
        },
      ],
      terminateProcess: (pid) => terminated.push(pid),
      logger: { info: () => {}, warn: (event) => warnings.push(event) },
    });

    expect(terminated).toEqual([]);
    expect(result).toEqual({
      candidateCount: 1,
      terminatedCount: 0,
      failedCount: 0,
      scanFailed: false,
      revalidationFailed: false,
    });
    expect(warnings).toContainEqual({
      event: 'windows-update-survivor-identity-changed',
      processName: 'openconsole.exe',
    });
  });

  test('revalidates every candidate with one query however many hosts leaked', () => {
    const sweepLeakedHosts = (survivorCount: number) => {
      const survivors = Array.from({ length: survivorCount }, (_unused, index) => ({
        processId: 101 + index,
        name: 'OpenConsole.exe',
        executablePath: `${INSTALL_TREE}\\pty-${index}\\OpenConsole.exe`,
        commandLine: null,
        creationDate: CREATED,
      }));
      const terminated: number[] = [];
      let queries = 0;
      const result = sweepWindowsUpdateSurvivors({
        platform: 'win32',
        installTree: INSTALL_TREE,
        listProcesses: () => {
          queries += 1;
          return survivors;
        },
        terminateProcess: (pid) => terminated.push(pid),
      });
      return { queries, terminated, result };
    };

    const oneSurvivor = sweepLeakedHosts(1);
    const manySurvivors = sweepLeakedHosts(12);

    expect(oneSurvivor.terminated).toHaveLength(1);
    expect(manySurvivors.terminated).toHaveLength(12);
    expect(manySurvivors.result).toEqual({
      candidateCount: 12,
      terminatedCount: 12,
      failedCount: 0,
      scanFailed: false,
      revalidationFailed: false,
    });
    // The scan plus one batched revalidation, so the main process pays two cold
    // PowerShell starts whether one host leaked or a dozen did.
    expect(oneSurvivor.queries).toBe(2);
    expect(manySurvivors.queries).toBe(oneSurvivor.queries);
  });

  test('terminates only the candidates the batched revalidation still confirms', () => {
    const alive = {
      processId: 101,
      name: 'OpenConsole.exe',
      executablePath: `${INSTALL_TREE}\\alive\\OpenConsole.exe`,
      commandLine: null,
      creationDate: CREATED,
    };
    const exited = { ...alive, processId: 102 };
    const recycled = { ...alive, processId: 103 };
    const terminated: number[] = [];
    const warnings: Record<string, unknown>[] = [];
    let requested: readonly number[] = [];

    const result = sweepWindowsUpdateSurvivors({
      platform: 'win32',
      installTree: INSTALL_TREE,
      listProcesses: () => [alive, exited, recycled],
      revalidateProcesses: (processIds) => {
        requested = processIds;
        return [alive, { ...recycled, creationDate: '2026-08-25T12:00:02.0000000Z' }];
      },
      terminateProcess: (pid) => terminated.push(pid),
      logger: { info: () => {}, warn: (event) => warnings.push(event) },
    });

    expect(requested).toEqual([101, 102, 103]);
    expect(terminated).toEqual([101]);
    expect(result).toEqual({
      candidateCount: 3,
      terminatedCount: 1,
      failedCount: 0,
      scanFailed: false,
      revalidationFailed: false,
    });
    expect(
      warnings.filter((event) => event.event === 'windows-update-survivor-identity-changed'),
    ).toHaveLength(2);
  });

  test('terminates nothing and reports the sweep incomplete when revalidation fails', () => {
    const survivor = {
      processId: 101,
      name: 'OpenConsole.exe',
      executablePath: `${INSTALL_TREE}\\one\\OpenConsole.exe`,
      commandLine: null,
      creationDate: CREATED,
    };
    const terminated: number[] = [];
    const warnings: Record<string, unknown>[] = [];

    const result = sweepWindowsUpdateSurvivors({
      platform: 'win32',
      installTree: INSTALL_TREE,
      listProcesses: () => [survivor, { ...survivor, processId: 102 }],
      revalidateProcesses: () => {
        throw Object.assign(new Error('powershell timed out'), { code: 'ETIMEDOUT' });
      },
      terminateProcess: (pid) => terminated.push(pid),
      logger: { info: () => {}, warn: (event) => warnings.push(event) },
    });

    expect(terminated).toEqual([]);
    expect(result).toEqual({
      candidateCount: 2,
      terminatedCount: 0,
      failedCount: 0,
      scanFailed: false,
      revalidationFailed: true,
    });
    expect(warnings).toContainEqual({
      event: 'windows-update-survivor-revalidate-failed',
      code: 'ETIMEDOUT',
    });
    expect(warnings).toContainEqual({
      event: 'windows-update-survivor-sweep-incomplete',
      candidateCount: 2,
      terminatedCount: 0,
      failedCount: 0,
      scanFailed: false,
      revalidationFailed: true,
    });
  });

  test('is a strict no-op on macOS and Linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      let listed = false;
      const result = sweepWindowsUpdateSurvivors({
        platform,
        installTree: INSTALL_TREE,
        listProcesses: () => {
          listed = true;
          return [];
        },
        terminateProcess: () => {
          throw new Error('must not terminate');
        },
      });
      expect(listed).toBe(false);
      expect(result).toEqual({
        candidateCount: 0,
        terminatedCount: 0,
        failedCount: 0,
        scanFailed: false,
        revalidationFailed: false,
      });
    }
  });
});
