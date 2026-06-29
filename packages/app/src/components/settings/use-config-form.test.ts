import { describe, expect, mock, test } from 'bun:test';
import type {
  Config,
  ConfigBindingPatchResult,
  ConfigPatch,
  ConfigValidationError,
} from '@inkeep/open-knowledge-core';
import {
  type ApplyExternalUpdateForm,
  applyExternalUpdate,
  pickFirstIssueForPath,
  type RunCommitBinding,
  type RunCommitForm,
  runCommit,
} from './use-config-form';

describe('applyExternalUpdate', () => {
  test('calls form.reset with keepDirtyValues + keepDirty + keepTouched', () => {
    const reset = mock();
    const form: ApplyExternalUpdateForm<Config> = {
      reset: reset as unknown as ApplyExternalUpdateForm<Config>['reset'],
    };
    const next = { mcp: { autoStart: false } } as Config;

    applyExternalUpdate(form, next);

    expect(reset).toHaveBeenCalledTimes(1);
    const call = reset.mock.calls[0];
    expect(call?.[0]).toBe(next);
    expect(call?.[1]).toEqual({
      keepDirtyValues: true,
      keepDirty: true,
      keepTouched: true,
    });
  });
});

interface MockedRunCommitForm extends RunCommitForm<Config> {
  reset?: never;
}

function createMockForm(getValuesImpl: (name: string) => unknown): {
  form: MockedRunCommitForm;
  setError: ReturnType<typeof mock>;
  clearErrors: ReturnType<typeof mock>;
  resetField: ReturnType<typeof mock>;
  getValues: ReturnType<typeof mock>;
} {
  const setError = mock();
  const clearErrors = mock();
  const resetField = mock();
  const getValues = mock(getValuesImpl);
  const form: MockedRunCommitForm = {
    getValues: getValues as unknown as MockedRunCommitForm['getValues'],
    setError: setError as unknown as MockedRunCommitForm['setError'],
    clearErrors: clearErrors as unknown as MockedRunCommitForm['clearErrors'],
    resetField: resetField as unknown as MockedRunCommitForm['resetField'],
  };
  return { form, setError, clearErrors, resetField, getValues };
}

function createMockBinding(patchImpl: (patch: ConfigPatch) => ConfigBindingPatchResult): {
  binding: RunCommitBinding;
  patch: ReturnType<typeof mock>;
} {
  const patch = mock(patchImpl);
  const binding: RunCommitBinding = {
    patch: patch as unknown as RunCommitBinding['patch'],
  };
  return { binding, patch };
}

describe('runCommit — success path', () => {
  test('builds deep-partial patch from name + value, calls binding.patch, returns true', () => {
    const { form, clearErrors, getValues } = createMockForm(() => 100);
    const { binding, patch } = createMockBinding(() => ({
      ok: true,
      effective: { mcp: { tools: { grep: { maxResults: 100 } } } } as unknown as Config,
      appliedPaths: ['mcp.tools.grep.maxResults'],
    }));

    const result = runCommit(form, binding, 'mcp.tools.grep.maxResults');

    expect(result).toBe(true);
    expect(getValues).toHaveBeenCalledWith('mcp.tools.grep.maxResults');
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[0]).toEqual({
      mcp: { tools: { grep: { maxResults: 100 } } },
    });
    expect(clearErrors).toHaveBeenCalledWith('mcp.tools.grep.maxResults');
  });

  test('clears the field-level error after a successful patch', () => {
    const { form, clearErrors } = createMockForm(() => 'localhost');
    const { binding } = createMockBinding(() => ({
      ok: true,
      effective: {} as Config,
      appliedPaths: ['server.host'],
    }));

    runCommit(form, binding, 'server.host');

    expect(clearErrors).toHaveBeenCalledTimes(1);
    expect(clearErrors).toHaveBeenCalledWith('server.host');
  });

  test('re-baselines defaultValue via resetField so the field is no longer dirty', () => {
    const { form, resetField } = createMockForm(() => 100);
    const { binding } = createMockBinding(() => ({
      ok: true,
      effective: { mcp: { tools: { grep: { maxResults: 100 } } } } as unknown as Config,
      appliedPaths: ['mcp.tools.grep.maxResults'],
    }));

    runCommit(form, binding, 'mcp.tools.grep.maxResults');

    expect(resetField).toHaveBeenCalledTimes(1);
    const [name, options] = resetField.mock.calls[0] ?? [];
    expect(name).toBe('mcp.tools.grep.maxResults');
    expect(options).toEqual({ defaultValue: 100, keepError: false });
  });

  test('null-as-clear (reset path) round-trips through buildPatch and binding.patch', () => {
    const { form, resetField } = createMockForm(() => null);
    const { binding, patch } = createMockBinding(() => ({
      ok: true,
      effective: { appearance: {} } as unknown as Config,
      appliedPaths: ['appearance.theme'],
    }));

    const result = runCommit(form, binding, 'appearance.theme');

    expect(result).toBe(true);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0]?.[0]).toEqual({ appearance: { theme: null } });
    expect(resetField).toHaveBeenCalledTimes(1);
    expect(resetField.mock.calls[0]?.[1]).toMatchObject({ defaultValue: null });
  });
});

describe('runCommit — failure path', () => {
  test('mirrors path-matched SCHEMA_INVALID issue into form.setError, returns false', () => {
    const { form, setError, clearErrors, resetField } = createMockForm(() => 'fast');
    const error: ConfigValidationError = {
      code: 'SCHEMA_INVALID',
      issues: [
        {
          path: ['mcp', 'tools', 'grep', 'maxResults'],
          message: 'Expected number, received string',
          issueCode: 'invalid_type',
        },
      ],
    };
    const { binding } = createMockBinding(() => ({ ok: false, error }));

    const result = runCommit(form, binding, 'mcp.tools.grep.maxResults');

    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledTimes(1);
    const [name, errArg] = setError.mock.calls[0] ?? [];
    expect(name).toBe('mcp.tools.grep.maxResults');
    expect(errArg).toMatchObject({
      type: 'config-binding',
      message: 'Expected number, received string',
    });
    expect(clearErrors).toHaveBeenCalledTimes(1);
    expect(clearErrors).toHaveBeenCalledWith('mcp.tools.grep.maxResults');
    expect(resetField).not.toHaveBeenCalled();
  });

  test('falls back to humanFormat when no SCHEMA_INVALID issue path matches the field name', () => {
    const { form, setError, resetField } = createMockForm(() => 'localhost');
    const error: ConfigValidationError = {
      code: 'WRITE_ERROR',
      detail: 'EACCES: permission denied',
    };
    const { binding } = createMockBinding(() => ({ ok: false, error }));

    const result = runCommit(form, binding, 'server.host');

    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledTimes(1);
    const errArg = setError.mock.calls[0]?.[1] as { message?: string } | undefined;
    expect(errArg?.message).toBeDefined();
    expect(errArg?.message).toContain('EACCES');
    expect(resetField).not.toHaveBeenCalled();
  });

  test('routes child-path issues to their own dotted path when commit name is the parent (atomic array commit)', () => {
    const { form, setError } = createMockForm(() => [{ match: '', frontmatter: {} }]);
    const error: ConfigValidationError = {
      code: 'SCHEMA_INVALID',
      issues: [
        {
          path: ['folders', 0, 'match'],
          message: '`match` must be a non-empty glob pattern',
          issueCode: 'too_small',
        },
      ],
    };
    const { binding } = createMockBinding(() => ({ ok: false, error }));

    const result = runCommit(form, binding, 'folders');

    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledTimes(1);
    const [name, errArg] = setError.mock.calls[0] ?? [];
    expect(name).toBe('folders.0.match');
    expect(errArg).toMatchObject({
      type: 'config-binding',
      message: '`match` must be a non-empty glob pattern',
    });
  });

  test('routes multiple SCHEMA_INVALID issues each to their own path', () => {
    const { form, setError } = createMockForm(() => [
      { match: '', frontmatter: { description: 42 } },
    ]);
    const error: ConfigValidationError = {
      code: 'SCHEMA_INVALID',
      issues: [
        {
          path: ['folders', 0, 'match'],
          message: '`match` must be a non-empty glob pattern',
          issueCode: 'too_small',
        },
        {
          path: ['folders', 0, 'frontmatter', 'description'],
          message: 'Expected string, received number',
          issueCode: 'invalid_type',
        },
      ],
    };
    const { binding } = createMockBinding(() => ({ ok: false, error }));

    runCommit(form, binding, 'folders');

    expect(setError).toHaveBeenCalledTimes(2);
    const paths = setError.mock.calls.map((c) => c[0]);
    expect(paths).toContain('folders.0.match');
    expect(paths).toContain('folders.0.frontmatter.description');
  });

  test('clears prior child-path errors before re-routing the new issue set (consecutive failures)', () => {
    const { form, setError, clearErrors } = createMockForm(() => [
      { match: 'specs/**', frontmatter: { description: 42 } },
    ]);
    const error: ConfigValidationError = {
      code: 'SCHEMA_INVALID',
      issues: [
        {
          path: ['folders', 0, 'frontmatter', 'description'],
          message: 'Expected string, received number',
          issueCode: 'invalid_type',
        },
      ],
    };
    const { binding } = createMockBinding(() => ({ ok: false, error }));

    runCommit(form, binding, 'folders');

    expect(clearErrors).toHaveBeenCalledTimes(1);
    expect(clearErrors).toHaveBeenCalledWith('folders');
    expect(setError).toHaveBeenCalledTimes(1);
    expect(setError.mock.calls[0]?.[0]).toBe('folders.0.frontmatter.description');
  });

  test('falls back to commit name when issue.path is empty (root-level refine guard)', () => {
    const { form, setError } = createMockForm(() => ({}));
    const error: ConfigValidationError = {
      code: 'SCHEMA_INVALID',
      issues: [
        {
          path: [],
          message: 'cross-field invariant violated',
          issueCode: 'custom',
        },
      ],
    };
    const { binding } = createMockBinding(() => ({ ok: false, error }));

    runCommit(form, binding, 'folders');

    expect(setError).toHaveBeenCalledTimes(1);
    const [name, errArg] = setError.mock.calls[0] ?? [];
    expect(name).toBe('folders');
    expect(errArg).toMatchObject({
      type: 'config-binding',
      message: 'cross-field invariant violated',
    });
  });

  test('SCHEMA_INVALID with empty issues[] falls back to humanFormat on the commit name', () => {
    const { form, setError } = createMockForm(() => 'localhost');
    const error: ConfigValidationError = {
      code: 'SCHEMA_INVALID',
      issues: [],
    };
    const { binding } = createMockBinding(() => ({ ok: false, error }));

    const result = runCommit(form, binding, 'server.host');

    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledTimes(1);
    expect(setError.mock.calls[0]?.[0]).toBe('server.host');
    const errArg = setError.mock.calls[0]?.[1] as { message?: string } | undefined;
    expect(errArg?.message).toBeDefined();
    expect(errArg?.message?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('pickFirstIssueForPath', () => {
  test('returns the issue.message when an issue path matches the field name', () => {
    const error: ConfigValidationError = {
      code: 'SCHEMA_INVALID',
      issues: [
        {
          path: ['server', 'host'],
          message: 'Bad host string',
          issueCode: 'invalid_type',
        },
        {
          path: ['mcp', 'autoStart'],
          message: 'Expected boolean',
          issueCode: 'invalid_type',
        },
      ],
    };
    expect(pickFirstIssueForPath(error, 'mcp.autoStart')).toBe('Expected boolean');
    expect(pickFirstIssueForPath(error, 'server.host')).toBe('Bad host string');
  });

  test('falls back to humanFormat for SCHEMA_INVALID with no matching path', () => {
    const error: ConfigValidationError = {
      code: 'SCHEMA_INVALID',
      issues: [
        {
          path: ['preview', 'baseUrl'],
          message: 'invalid url',
          issueCode: 'invalid_string',
        },
      ],
    };
    const out = pickFirstIssueForPath(error, 'server.host');
    expect(out).not.toBe('invalid url');
    expect(out.length).toBeGreaterThan(0);
  });

  test('falls back to humanFormat for non-SCHEMA_INVALID errors', () => {
    const error: ConfigValidationError = {
      code: 'YAML_PARSE',
      detail: 'unexpected token at line 5',
    };
    const out = pickFirstIssueForPath(error, 'mcp.autoStart');
    expect(out).toContain('unexpected token at line 5');
  });

  test('handles forward-compat tail variant by falling back to humanFormat', () => {
    const error = {
      code: 'FUTURE_ERROR_CODE',
      message: 'something the current client does not know about',
    } as unknown as ConfigValidationError;
    const out = pickFirstIssueForPath(error, 'server.host');
    expect(out).toContain('something the current client does not know about');
  });
});

describe('useConfigForm module shape', () => {
  test('exports useConfigForm as a function', async () => {
    const mod = await import('./use-config-form');
    expect(typeof mod.useConfigForm).toBe('function');
    expect(typeof mod.applyExternalUpdate).toBe('function');
    expect(typeof mod.runCommit).toBe('function');
    expect(typeof mod.pickFirstIssueForPath).toBe('function');
  });
});
