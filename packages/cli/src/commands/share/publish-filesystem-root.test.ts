import { afterEach, describe, expect, test, vi } from 'vitest';

const tokenLookups = vi.hoisted(() => ({ count: 0 }));

vi.mock('../auth/repos.ts', () => ({
  resolveReposToken: async () => {
    tokenLookups.count += 1;
    return null;
  },
}));

const { sharePublishCommand } = await import('./publish.ts');

describe('share publish refuses the top of a drive', () => {
  afterEach(() => {
    tokenLookups.count = 0;
  });

  test('prints the refusal and exits 64 before looking up credentials', async () => {
    const savedExitCode = process.exitCode;
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await sharePublishCommand(async () => ({}) as never).parseAsync(
        ['--owner', 'someone', '--name', 'notes', '--visibility', 'private', '--project-dir', '/'],
        { from: 'user' },
      );

      expect(process.exitCode).toBe(64);
      const printed = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(printed).toContain('top of a drive');
      expect(tokenLookups.count).toBe(0);
    } finally {
      process.exitCode = savedExitCode;
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });
});
