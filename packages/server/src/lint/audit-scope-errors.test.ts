import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { auditScopeWarning } from './audit.ts';
import { resolveAuditScope } from './audit-scope.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    lstatSync: vi.fn(actual.lstatSync),
    realpathSync: vi.fn(actual.realpathSync),
  };
});

afterEach(() => {
  vi.mocked(fs.lstatSync).mockReset();
  vi.mocked(fs.realpathSync).mockReset();
});

test.each(['EACCES', 'EIO', 'EPERM'])('keeps %s scope resolution failures operational', (code) => {
  const failure = Object.assign(new Error(`scope probe ${code}`), { code });
  vi.mocked(fs.lstatSync).mockImplementationOnce(() => {
    throw failure;
  });
  expect(() => resolveAuditScope('document.md', process.cwd())).toThrow(failure);
});

test.each(['EACCES', 'EIO', 'EPERM'])('keeps %s containment failures operational', (code) => {
  const failure = Object.assign(new Error(`containment probe ${code}`), { code });
  const root = process.cwd();
  vi.mocked(fs.realpathSync).mockImplementation((path) => {
    if (path === root) return root;
    throw failure;
  });
  expect(() => auditScopeWarning({ path: join(root, 'document.md') }, root, 'document.md')).toThrow(
    failure,
  );
});
