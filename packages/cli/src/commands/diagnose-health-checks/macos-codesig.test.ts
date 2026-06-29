import { describe, expect, test } from 'bun:test';
import { makeMacosCodesigCheck } from './macos-codesig.ts';

const ctx = { cwd: '/tmp/macos-codesig-test' };

describe('macos-codesig check', () => {
  test('passes with skip on linux', async () => {
    const def = makeMacosCodesigCheck({
      platform: 'linux',
      execPath: '/usr/local/bin/ok',
    });
    const result = await def.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.summary).toContain('skipped on linux');
  });

  test('passes with skip on win32', async () => {
    const def = makeMacosCodesigCheck({
      platform: 'win32',
      execPath: 'C:\\Program Files\\OpenKnowledge\\ok.exe',
    });
    const result = await def.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.summary).toContain('skipped on win32');
  });

  test('passes with dev-mode caveat on darwin when execPath has no /Contents/MacOS/', async () => {
    const def = makeMacosCodesigCheck({
      platform: 'darwin',
      execPath: '/Users/me/.local/bin/bun',
    });
    const result = await def.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.summary).toBe('dev mode (no app bundle)');
  });

  test('fails on translocated bundle (under /private/var/folders/)', async () => {
    const def = makeMacosCodesigCheck({
      platform: 'darwin',
      execPath:
        '/private/var/folders/x/abc/T/AppTranslocation/12345/d/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
    });
    const result = await def.run(ctx);
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('translocated');
    expect(result.remediation).toContain('/Applications');
  });

  test('passes when bundle path is normal and codesign --verify succeeds', async () => {
    const def = makeMacosCodesigCheck({
      platform: 'darwin',
      execPath: '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
      codesignVerify: () => ({ ok: true, stderr: '' }),
    });
    const result = await def.run(ctx);
    expect(result.status).toBe('pass');
    expect(result.summary).toContain('/Applications/OpenKnowledge.app');
  });

  test('fails when codesign --verify exits non-zero', async () => {
    const def = makeMacosCodesigCheck({
      platform: 'darwin',
      execPath: '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
      codesignVerify: () => ({ ok: false, stderr: 'invalid signature' }),
    });
    const result = await def.run(ctx);
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('codesign --verify failed');
    expect(result.remediation).toContain('Re-download');
    expect(result.detail).toContain('invalid signature');
  });
});
