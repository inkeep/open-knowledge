/**
 * Unit tests for the binding-harness pure helpers (`applyExternalUpdate`,
 * `runCommit`, `pickFirstIssueForPath`). The hook itself (`useConfigForm`)
 * is glue — its full stateful behavior is exercised at the Settings-dialog
 * level (Playwright E2E + source-level guards in `SettingsDialog.test.ts`).
 *
 * Repo convention (no @testing-library/react, no happy-dom): mock the
 * `ConfigBinding` system boundary; structure logic so it can be tested
 * against a `Pick<UseFormReturn>`-shaped mock instead of a live `useForm`.
 *
 * The single integration-style assertion is the keepDirtyValues semantic:
 * `applyExternalUpdate` must call `form.reset(next, { keepDirtyValues:
 * true, keepDirty: true, keepTouched: true })` — that exact options
 * triple is what `bindConfigDoc.subscribe → form.reset` relies on for the
 * "external update lands on non-dirty fields, leaves dirty fields alone"
 * contract.
 */

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

// ---------------------------------------------------------------------------
// applyExternalUpdate — bridge contract for binding.subscribe → form.reset
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// runCommit — per-field commit + error mirroring
// ---------------------------------------------------------------------------

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
    // Asserting the field-name argument guards against a refactor where
    // form.getValues() is called with no argument — which in production
    // would return the entire form state and produce a malformed patch
    // (entire Config nested under `mcp.tools.grep.maxResults`).
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
    // Without this re-baseline, every committed field stays dirty
    // forever; the next external Y.Text update would skip it under
    // `keepDirtyValues: true`, leaving the UI stuck on the user's old
    // value after a remote-writer change.
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
    // Exact match — `keepDirty` MUST NOT be present. If it slipped in
    // (e.g. `keepDirty: true`), committed fields would stay dirty forever
    // and external Y.Text updates under `keepDirtyValues: true` would
    // skip them — exactly the regression this test is meant to prevent.
    expect(options).toEqual({ defaultValue: 100, keepError: false });
  });

  test('null-as-clear (reset path) round-trips through buildPatch and binding.patch', () => {
    // The Settings-pane reset button writes `null` for fields with no
    // schema default. `buildPatch` must preserve null (RFC 7396
    // null-as-clear), and `binding.patch` must receive `{[path]: null}`.
    // A regression that strips nulls would silently break reset-to-default
    // for `appearance.theme`.
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
    // Re-baseline the resetField default to null so subsequent external
    // updates can flow through.
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
    // clearErrors(name) IS called in the SCHEMA_INVALID-with-issues branch
    // before the per-issue setError loop, so stale child-path errors from
    // a prior failure don't survive when the new issue set shrinks.
    expect(clearErrors).toHaveBeenCalledTimes(1);
    expect(clearErrors).toHaveBeenCalledWith('mcp.tools.grep.maxResults');
    // resetField MUST stay inside the success branch — if it leaked to
    // the failure path, committed-but-invalid fields would lose their
    // dirty status and the next external update under
    // `keepDirtyValues: true` would skip them, silently reverting the
    // user's edit.
    expect(resetField).not.toHaveBeenCalled();
  });

  test('falls back to humanFormat when no SCHEMA_INVALID issue path matches the field name', () => {
    const { form, setError, resetField } = createMockForm(() => 'localhost');
    // Generic WRITE_ERROR (no path-keyed issues) — humanFormat fallback
    // must produce a non-empty message.
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
    // Atomic full-array commit on `folders` rejected by a Zod issue at
    // `folders.0.match`. The error must land on the child path so the
    // matching FormMessage renders inline at the row's Match input —
    // setError on the called parent path would land on a FieldPath with
    // no FormField, leaving the row visually silent.
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
    // Concrete scenario: a folders row is rejected with both `match` and
    // `frontmatter.description` invalid. The user fixes `match` and blurs;
    // the second commit rejects with only `frontmatter.description` left.
    // Without clearErrors(name) before the loop, the old `folders.0.match`
    // error persists in formState.errors and the row visually shows a red
    // FormMessage on a field the user has already fixed. RHF's
    // unset(errors, 'folders') deletes the whole subtree, so a single
    // clearErrors call on the parent path covers all child-path errors.
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
    // Order matters: the clearErrors call must precede the setError calls
    // — otherwise the loop sets the new error but the stale ones survive.
    // bun:test's `mock.calls` records call order across the same mock; we
    // assert ordering via invocationCallOrder is unavailable, so instead
    // verify that the resulting setError targets only the current issue.
    expect(setError).toHaveBeenCalledTimes(1);
    expect(setError.mock.calls[0]?.[0]).toBe('folders.0.frontmatter.description');
  });

  test('falls back to commit name when issue.path is empty (root-level refine guard)', () => {
    // ConfigIssueSchema.path has no .min(1), so an empty path is
    // schema-valid (e.g., a future .refine()/.superRefine() on the
    // ConfigSchema root would emit issues with empty paths). Without the
    // length guard, `''.map(String).join('.')` produces the empty string;
    // setError('', …) lands at formState.errors[''] — invisible to every
    // FormField and never cleared by clearErrors('folders') because
    // unset(errors, 'folders') only touches the 'folders' subtree.
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
    // The `issues.length > 0` guard in runCommit is intentional: a
    // structurally-valid SCHEMA_INVALID (per ConfigIssueSchema) may carry
    // an empty issues[] array. Routing it through the SCHEMA_INVALID
    // branch with no issues would zero-iterate the loop and call no
    // setError, leaving the commit silently failing. The else branch
    // surfaces humanFormat(error) on the commit name instead.
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

// ---------------------------------------------------------------------------
// pickFirstIssueForPath — message selection contract
// ---------------------------------------------------------------------------

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
    // humanFormat for SCHEMA_INVALID renders the full multi-line summary —
    // assert it isn't the bare path-matched message (which doesn't exist
    // for `server.host`) and isn't empty.
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

// ---------------------------------------------------------------------------
// Smoke test for the hook's exported interface — the hook function itself
// can't be invoked outside a render context (RHF requires it), so we
// verify it's a function and the typed result names match the contract.
// ---------------------------------------------------------------------------

describe('useConfigForm module shape', () => {
  test('exports useConfigForm as a function', async () => {
    const mod = await import('./use-config-form');
    expect(typeof mod.useConfigForm).toBe('function');
    expect(typeof mod.applyExternalUpdate).toBe('function');
    expect(typeof mod.runCommit).toBe('function');
    expect(typeof mod.pickFirstIssueForPath).toBe('function');
  });
});
