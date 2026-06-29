
import {
  type Config,
  type ConfigBinding,
  type ConfigBindingPatchResult,
  type ConfigIssue,
  type ConfigPatch,
  type ConfigValidationError,
  humanFormat,
  isKnownConfigError,
} from '@inkeep/open-knowledge-core';
import { useEffect } from 'react';
import { type FieldPath, type UseFormReturn, useForm } from 'react-hook-form';
import { buildPatch } from './schema-walker';

interface UseConfigFormResult {
  form: UseFormReturn<Config>;
  commitField: (name: FieldPath<Config>) => boolean;
}

export function useConfigForm(binding: ConfigBinding): UseConfigFormResult {
  const form = useForm<Config>({
    defaultValues: binding.current() as Config,
    mode: 'onBlur',
  });

  useEffect(() => {
    return binding.subscribe((next) => {
      applyExternalUpdate(form, next);
    });
  }, [binding, form]);

  const commitField = (name: FieldPath<Config>): boolean => runCommit(form, binding, name);

  return { form, commitField };
}


export type ApplyExternalUpdateForm<T extends Config = Config> = Pick<UseFormReturn<T>, 'reset'>;

export function applyExternalUpdate<T extends Config = Config>(
  form: ApplyExternalUpdateForm<T>,
  next: T,
): void {
  form.reset(next, {
    keepDirtyValues: true,
    keepDirty: true,
    keepTouched: true,
  });
}

export type RunCommitForm<T extends Config = Config> = Pick<
  UseFormReturn<T>,
  'getValues' | 'setError' | 'clearErrors' | 'resetField'
>;

export interface RunCommitBinding {
  patch(patch: ConfigPatch): ConfigBindingPatchResult;
}

export function runCommit<T extends Config = Config>(
  form: RunCommitForm<T>,
  binding: RunCommitBinding,
  name: FieldPath<T>,
): boolean {
  const value = form.getValues(name);
  const patch = buildPatch(splitFieldPath(name), value) as ConfigPatch;
  const result = binding.patch(patch);
  if (result.ok) {
    form.clearErrors(name);
    form.resetField(name, {
      defaultValue: value as never,
      keepError: false,
    });
    return true;
  }
  if (
    isKnownConfigError(result.error) &&
    result.error.code === 'SCHEMA_INVALID' &&
    result.error.issues.length > 0
  ) {
    form.clearErrors(name);
    for (const issue of result.error.issues) {
      const issuePath = issue.path.length > 0 ? issue.path.map(String).join('.') : name;
      form.setError(issuePath as FieldPath<T>, {
        type: 'config-binding',
        message: issue.message,
      });
    }
  } else {
    form.setError(name, {
      type: 'config-binding',
      message: pickFirstIssueForPath(result.error, name),
    });
  }
  return false;
}

export function pickFirstIssueForPath(error: ConfigValidationError, name: string): string {
  if (isKnownConfigError(error) && error.code === 'SCHEMA_INVALID') {
    const matching = error.issues.find((iss) => issuePathMatches(iss, name));
    if (matching) return matching.message;
  }
  return humanFormat(error);
}

function issuePathMatches(issue: ConfigIssue, name: string): boolean {
  return issue.path.map(String).join('.') === name;
}

function splitFieldPath(name: string): string[] {
  return name.split('.');
}
