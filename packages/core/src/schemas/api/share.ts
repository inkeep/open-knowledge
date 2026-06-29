import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

export const ShareConstructUrlRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('doc'),
      docPath: z.string().min(1),
    })
    .loose(),
  z
    .object({
      kind: z.literal('folder'),
      folderPath: z.string(),
    })
    .loose(),
]) satisfies StandardSchemaV1;
export type ShareConstructUrlRequest = z.infer<typeof ShareConstructUrlRequestSchema>;

export const ShareConstructUrlErrorCodeSchema = z.enum([
  'no-remote',
  'detached-head',
  'branch-not-on-origin',
  'non-github-remote',
  'invalid-path',
]) satisfies StandardSchemaV1;
export type ShareConstructUrlErrorCode = z.infer<typeof ShareConstructUrlErrorCodeSchema>;

export const ShareConstructUrlResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      shareUrl: z.string().min(1),
      sharedUrl: z.string().min(1),
      branch: z.string().min(1),
    })
    .loose(),
  z
    .object({
      ok: z.literal(false),
      error: ShareConstructUrlErrorCodeSchema,
      branch: z.string().min(1).optional(),
    })
    .loose(),
]) satisfies StandardSchemaV1;
export type ShareConstructUrlResponse = z.infer<typeof ShareConstructUrlResponseSchema>;

export const SharePublishOwnerKindSchema = z.enum(['user', 'org']) satisfies StandardSchemaV1;
export type SharePublishOwnerKind = z.infer<typeof SharePublishOwnerKindSchema>;

export const SharePublishOwnerSchema = z
  .object({
    login: z.string().min(1),
    kind: SharePublishOwnerKindSchema,
    avatarUrl: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SharePublishOwner = z.infer<typeof SharePublishOwnerSchema>;

export const SharePublishOwnersErrorCodeSchema = z.enum([
  'auth-required',
  'network',
]) satisfies StandardSchemaV1;
export type SharePublishOwnersErrorCode = z.infer<typeof SharePublishOwnersErrorCodeSchema>;

export const SharePublishOwnersResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      owners: z.array(SharePublishOwnerSchema),
    })
    .loose(),
  z
    .object({
      ok: z.literal(false),
      error: SharePublishOwnersErrorCodeSchema,
    })
    .loose(),
]) satisfies StandardSchemaV1;
export type SharePublishOwnersResponse = z.infer<typeof SharePublishOwnersResponseSchema>;

export const SharePublishNameCheckResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      available: z.boolean(),
    })
    .loose(),
  z
    .object({
      ok: z.literal(false),
      error: SharePublishOwnersErrorCodeSchema,
    })
    .loose(),
]) satisfies StandardSchemaV1;
export type SharePublishNameCheckResponse = z.infer<typeof SharePublishNameCheckResponseSchema>;

export const SharePublishVisibilitySchema = z.enum([
  'public',
  'private',
]) satisfies StandardSchemaV1;
export type SharePublishVisibility = z.infer<typeof SharePublishVisibilitySchema>;

export const SharePublishRequestSchema = z
  .object({
    owner: z.string().min(1),
    name: z.string().min(1),
    visibility: SharePublishVisibilitySchema,
    description: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type SharePublishRequest = z.infer<typeof SharePublishRequestSchema>;

export const SharePublishErrorCodeSchema = z.enum([
  'name-conflict',
  'saml-sso',
  'auth-required',
  'push-failed',
  'init-failed',
  'network',
  'no-project',
]) satisfies StandardSchemaV1;
export type SharePublishErrorCode = z.infer<typeof SharePublishErrorCodeSchema>;

export const SharePublishResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      ownerLogin: z.string().min(1),
      repoName: z.string().min(1),
      cloneUrl: z.string().min(1),
      defaultBranch: z.string().min(1),
    })
    .loose(),
  z
    .object({
      ok: z.literal(false),
      error: SharePublishErrorCodeSchema,
    })
    .loose(),
]) satisfies StandardSchemaV1;
export type SharePublishResponse = z.infer<typeof SharePublishResponseSchema>;

export function isValidBranchName(branch: unknown): branch is string {
  if (typeof branch !== 'string') return false;
  if (branch.length === 0) return false;
  if (branch.startsWith('-')) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what we want to reject
  if (/[\x00-\x1F\x7F]/.test(branch)) return false;
  if (/\s/.test(branch)) return false;
  if (branch.includes(':')) return false;
  if (branch.split('/').includes('..')) return false;
  return true;
}

const refineBranchName = <T extends z.ZodString>(schema: T) =>
  schema.refine(isValidBranchName, 'invalid branch name');

export function isBranchNotFoundGitError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /couldn'?t find remote ref|Remote branch .+ not found/i.test(message);
}

export type GitAuthFailureSubclass =
  | 'no-credential'
  | '401'
  | '403'
  | 'scope-mismatch'
  | 'ssh-auth'
  | 'unknown-auth';

export type ClassifiedGitAuthError =
  | { kind: 'auth'; subclass: GitAuthFailureSubclass }
  | { kind: 'non-auth' };

const GIT_AUTH_NO_CREDENTIAL_PATTERNS: RegExp[] = [
  /could not read (username|password)/i,
  /terminal prompts disabled/i,
];

const GIT_AUTH_SCOPE_MISMATCH_PATTERNS: RegExp[] = [
  /insufficient scopes/i,
  /missing.*scope/i,
  /required scope/i,
];

const GIT_AUTH_SSH_PATTERNS: RegExp[] = [
  /permission denied.*\(publickey\)/i,
  /host key verification failed/i,
];

const GIT_AUTH_GENERAL_PATTERNS: RegExp[] = [
  /\b(401|403)\b/,
  /authentication failed/i,
  /authorization failed/i,
  /invalid credentials/i,
  /credential helper/i,
  /bad credentials/i,
  /token.*expired/i,
  /expired.*token/i,
  /fatal:.*repository.*not found/i,
];

function gitAuthExtractStderr(error: unknown): string {
  if (error === null || typeof error !== 'object') return '';
  const git = (error as { git?: unknown }).git;
  return git == null ? '' : String(git);
}

export function classifyGitAuthError(error: unknown): ClassifiedGitAuthError {
  if (error === null || error === undefined) return { kind: 'non-auth' };
  const message = error instanceof Error ? error.message : String(error);
  const combined = `${message}\n${gitAuthExtractStderr(error)}`;

  if (GIT_AUTH_NO_CREDENTIAL_PATTERNS.some((re) => re.test(combined))) {
    return { kind: 'auth', subclass: 'no-credential' };
  }
  if (GIT_AUTH_SCOPE_MISMATCH_PATTERNS.some((re) => re.test(combined))) {
    return { kind: 'auth', subclass: 'scope-mismatch' };
  }
  if (GIT_AUTH_SSH_PATTERNS.some((re) => re.test(combined))) {
    return { kind: 'auth', subclass: 'ssh-auth' };
  }
  if (GIT_AUTH_GENERAL_PATTERNS.some((re) => re.test(combined))) {
    if (/\b401\b/.test(combined) || /token.*expired/i.test(combined)) {
      return { kind: 'auth', subclass: '401' };
    }
    if (/\b403\b/.test(combined)) {
      return { kind: 'auth', subclass: '403' };
    }
    return { kind: 'auth', subclass: 'unknown-auth' };
  }
  return { kind: 'non-auth' };
}

export function isLoginFixableGitAuthError(classified: ClassifiedGitAuthError): boolean {
  if (classified.kind !== 'auth') return false;
  return (
    classified.subclass === 'no-credential' ||
    classified.subclass === '401' ||
    classified.subclass === 'unknown-auth'
  );
}

const BranchInfoSharedFields = {
  shareTargetExists: z.boolean(),
  dirtyConflicts: z
    .object({
      conflicts: z.boolean(),
      files: z.array(z.string().min(1)),
    })
    .loose(),
  branchIsLocal: z.boolean(),
};

export const BranchInfoResponseSchema = z.discriminatedUnion('detached', [
  z
    .object({
      detached: z.literal(false),
      currentBranch: z.string().min(1).nullable(),
      currentHeadSha: z.null(),
      ...BranchInfoSharedFields,
    })
    .loose(),
  z
    .object({
      detached: z.literal(true),
      currentBranch: z.null(),
      currentHeadSha: z.string().min(1),
      ...BranchInfoSharedFields,
    })
    .loose(),
]) satisfies StandardSchemaV1;
export type BranchInfoResponse = z.infer<typeof BranchInfoResponseSchema>;

export const CheckoutRequestSchema = z
  .object({
    branch: refineBranchName(z.string().min(1)),
    principalId: z.string().optional(),
  })
  .loose() satisfies StandardSchemaV1;
export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;

export const CheckoutFailureReasonSchema = z.enum([
  'dirty-conflict',
  'branch-not-found',
  'fetch-failed',
  'checkout-failed',
  'branch-in-other-worktree',
]) satisfies StandardSchemaV1;
export type CheckoutFailureReason = z.infer<typeof CheckoutFailureReasonSchema>;

export const CheckoutResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
    })
    .loose(),
  z
    .object({
      ok: z.literal(false),
      reason: CheckoutFailureReasonSchema,
      files: z.array(z.string().min(1)).optional(),
      otherWorktreePath: z.string().min(1).optional(),
    })
    .loose(),
]) satisfies StandardSchemaV1;
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>;
