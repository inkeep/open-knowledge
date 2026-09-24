import { z } from 'zod';
import { GIT_HOST_PROVIDERS } from '../constants/github.ts';
import type { ConfigValidationError } from './errors.ts';
import { fieldRegistry } from './field-registry.ts';
import type { ConfigPatch } from './schema.ts';
import { toConfigIssue } from './yaml-patch.ts';

const gitHostEntryShape = {
  provider: z.enum(GIT_HOST_PROVIDERS).register(fieldRegistry, {
    scope: 'user',
    agentSettable: false,
    reload: 'boot',
    defaultScope: 'user',
    description:
      "Declares that this git host is a GitHub Enterprise Server instance, so OpenKnowledge treats its remotes the way it treats github.com (OpenKnowledge credential handling, the push-permission check, share links, and the default host for `ok auth`). 'github' is the only accepted value today. A host that is not declared here and is not github.com is treated as a generic git remote, so OpenKnowledge leaves the machine's own git credentials alone and does not check push permission. Per-machine (user scope, `~/.ok/global.yml`); a value in a project's `.ok/config.yml` is ignored. The declaration takes effect when OpenKnowledge next starts.",
  }),
};

type GitHostEntryShape = typeof gitHostEntryShape;

const effectiveEntryShape = Object.fromEntries(
  Object.entries(gitHostEntryShape).map(([key, schema]) => [
    key,
    schema.optional().catch(undefined),
  ]),
) as {
  [K in keyof GitHostEntryShape]: z.ZodCatch<z.ZodOptional<GitHostEntryShape[K]>>;
};

const patchEntryShape = Object.fromEntries(
  Object.entries(gitHostEntryShape).map(([key, schema]) => [key, schema.nullish()]),
) as {
  [K in keyof GitHostEntryShape]: z.ZodOptional<z.ZodNullable<GitHostEntryShape[K]>>;
};

export const EffectiveGitHostEntrySchema = z.looseObject(effectiveEntryShape).catch({});

export const GitHostsSchema = z.record(z.string(), z.looseObject(gitHostEntryShape).partial());

const GitHostPatchSchema = z.looseObject({
  git: z
    .looseObject({
      hosts: z.record(z.string(), z.looseObject(patchEntryShape).nullish()).nullish(),
    })
    .nullish(),
});

export function validateGitHostPatch(
  patch: ConfigPatch,
): Extract<ConfigValidationError, { code: 'SCHEMA_INVALID' }> | null {
  const parsed = GitHostPatchSchema.safeParse(patch);
  return parsed.success
    ? null
    : { code: 'SCHEMA_INVALID', issues: parsed.error.issues.map(toConfigIssue) };
}
