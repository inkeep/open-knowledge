import { describe, expect, test } from 'vitest';
import {
  acquisitionDescriptors,
  native,
  npmOutputs,
  npmPackedVersion,
  npmPublicationTimes,
  registryPackage,
} from './package-acquisition.test-helper.ts';

describe('package acquisition command outcomes', () => {
  test('a signal-terminated command cannot report success', async () => {
    const result = await native(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"]);
    expect(result.code).toBe('SIGTERM');
    expect(result.stderr).toBe('');
  });

  test('preserves successful stdout and nonzero exit diagnostics', async () => {
    expect(await native(process.execPath, ['-e', "process.stdout.write('ready')"])).toEqual({
      code: 0,
      stdout: 'ready',
      stderr: '',
    });
    const failed = await native(process.execPath, [
      '-e',
      "process.stderr.write('refused'); process.exit(9)",
    ]);
    expect(failed.code).toBe(9);
    expect(failed.stderr).toBe('refused');
  });

  test('names a missing executable as a prerequisite failure', async () => {
    const failed = await native('ok-nonexistent-acquisition-executable', []);
    expect(failed.code).toBe('ENOENT');
    expect(failed.stderr).toBe('Missing test prerequisite: ok-nonexistent-acquisition-executable');
  });
});

describe('npm JSON output contracts', () => {
  test.each(npmOutputs)('reads captured npm $npmVersion output', ({ pack, publicationTimes }) => {
    expect(npmPackedVersion(JSON.stringify(pack))).toBe('7.0.0');
    expect(npmPublicationTimes(JSON.stringify(publicationTimes))['7.0.0']).toBe(
      '2018-07-04T15:08:58.238Z',
    );
  });

  test.each([
    { label: 'missing name', pack: [{ version: '7.0.0' }] },
    { label: 'prerelease', pack: { 'is-number': { name: 'is-number', version: '7.0.0-beta.1' } } },
  ])('rejects $label pack metadata outside the launch contract', ({ pack }) => {
    expect(() => npmPackedVersion(JSON.stringify(pack))).toThrow('Could not parse npm JSON output');
  });

  test.each([npmPackedVersion, npmPublicationTimes])(
    '%s preserves invalid output and its parse error',
    (parse) => {
      const invalid = '{broken-npm-output';
      expect(() => parse(invalid)).toThrow(invalid);
      expect(() => parse(invalid)).toThrow(expect.objectContaining({ cause: expect.any(Error) }));
    },
  );
});

test('catalog comparison retains every npm and uv descriptor and ignores binary-only agents', () => {
  const npx = { package: 'npm-one@1.0.0', args: ['--stdio'], env: { SETTING: 'enabled' } };
  const uvx = { package: 'python-one==2.0.0', args: ['--acp'], env: { PYTHON_SETTING: '1' } };
  const agents = [
    { ...registryPackage('ignored'), id: 'z', distribution: { npx, uvx } },
    { ...registryPackage('ignored'), id: 'binary', distribution: { binary: {} } },
    { ...registryPackage('ignored'), id: 'a', distribution: { uvx } },
    { ...registryPackage('ignored'), id: 'b', distribution: { npx } },
  ];
  expect(acquisitionDescriptors(agents)).toEqual([
    { id: 'a', npx: undefined, uvx },
    { id: 'b', npx, uvx: undefined },
    { id: 'z', npx, uvx },
  ]);
});

test.each(['syntax', 'schema-object', 'schema-array'] as const)(
  'late %s failures retain the offending npm output',
  (mode) => {
    const history = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`1.0.${i}`, '2020-01-01T00:00:00Z']),
    );
    const record = { ...history, 'broken-release': 42, 'later-release': '2020-01-01T00:00:00Z' };
    const output =
      mode === 'syntax'
        ? JSON.stringify(record).replace(':42', ':INVALID_NPM_JSON')
        : JSON.stringify(mode === 'schema-array' ? [record] : record);
    expect(() => npmPublicationTimes(output)).toThrow('broken-release');
    expect(() => npmPublicationTimes(output)).toThrow(
      expect.objectContaining({ cause: expect.any(Error) }),
    );
  },
);
