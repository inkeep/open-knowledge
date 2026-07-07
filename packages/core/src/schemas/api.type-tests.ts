/**
 * Negative type tests for canonical Zod API schemas.
 *
 * Each `@ts-expect-error` block asserts that a regression in schema shape
 * fails to compile. If a regression silently makes one of these blocks
 * compile, TypeScript surfaces it as an "unused @ts-expect-error directive"
 * error during typecheck.
 *
 * Pure type-level — no runtime statements (no `bun test` execution). This
 * file is consumed by `tsc --noEmit` only.
 */

import type {
  PrincipalSuccess,
  ProblemDetails,
  ProblemType,
  ServerInfoSuccess,
  UploadAssetSuccess,
  UploadRequest,
} from './api/index.ts';

// ---------------------------------------------------------------------------
// ProblemType (URN literal-union, closed by policy)
// ---------------------------------------------------------------------------

// A registered URN token must satisfy ProblemType.
const _validProblemType: ProblemType = 'urn:ok:error:malformed-upload';
void _validProblemType;

// Bare kebab tokens must NOT satisfy ProblemType.
// @ts-expect-error -- ProblemType is the URN form `urn:ok:error:<kebab>`, not bare kebab.
const _bareKebab: ProblemType = 'malformed-upload';
void _bareKebab;

// Relative-URI form must NOT satisfy ProblemType.
// @ts-expect-error -- ProblemType is URN form, not `/errors/<kebab>` relative URI.
const _relativeUri: ProblemType = '/errors/malformed-upload';
void _relativeUri;

// Free-form string must NOT satisfy ProblemType (closed by policy).
// @ts-expect-error -- ProblemType is a closed literal-union; free-form strings rejected.
const _freeFormString: ProblemType = 'something-else';
void _freeFormString;

// ---------------------------------------------------------------------------
// ProblemDetails (RFC 9457 body)
// ---------------------------------------------------------------------------

// Required fields satisfied → compiles.
const _validProblem: ProblemDetails = {
  type: 'urn:ok:error:malformed-upload',
  title: 'The uploaded multipart payload is malformed.',
  status: 400,
};
void _validProblem;

// Missing `title` (REQUIRED) must NOT compile.
// @ts-expect-error -- title is required.
const _missingTitle: ProblemDetails = {
  type: 'urn:ok:error:malformed-upload',
  status: 400,
};
void _missingTitle;

// Missing `status` (REQUIRED) must NOT compile.
// @ts-expect-error -- status is required.
const _missingStatus: ProblemDetails = {
  type: 'urn:ok:error:malformed-upload',
  title: 'oops',
};
void _missingStatus;

// `type` widened to a free-form string (regression of closed union) must NOT compile.
const _widenedType: ProblemDetails = {
  // @ts-expect-error -- type must be ProblemType, not arbitrary string.
  type: 'arbitrary-string',
  title: 'oops',
  status: 400,
};
void _widenedType;

// ---------------------------------------------------------------------------
// UploadAssetSuccess (success path, no `ok: true` wrapper)
// ---------------------------------------------------------------------------

const _validSuccess: UploadAssetSuccess = { src: 'attachments/photo.png' };
void _validSuccess;

// Missing `src` must NOT compile.
// @ts-expect-error -- src is required.
const _missingSrc: UploadAssetSuccess = { deduped: true };
void _missingSrc;

// `ok: true` wrapper is not a structurally-typed field on UploadAssetSuccess
// — the wrapper is dropped. The Zod schema is `.loose()` so the inferred TS
// type carries an `[x: string]: unknown` index signature — runtime `.loose()`
// preserves unknown fields rather than rejecting them. The wire-shape change
// is enforced structurally at the emit site (handlers no longer write
// `ok: true`) and by the allowlist meta-test, not by the inferred type.
// What we *can* assert here: required fields like `src` are still required.
const _validHasSrc: UploadAssetSuccess = { src: 'foo.png' };
void _validHasSrc;

// ---------------------------------------------------------------------------
// UploadRequest (multipart metadata fields validated by withValidation)
// ---------------------------------------------------------------------------

const _validRequest: UploadRequest = {
  parentDocName: 'notes/index',
  placement: 'configured-attachments',
};
void _validRequest;

const _withAgentIdentity: UploadRequest = {
  parentDocName: 'notes/index',
  placement: 'parent-dir',
  agentId: 'claude-1',
  agentName: 'Claude',
};
void _withAgentIdentity;

// Missing parentDocName must NOT compile.
// @ts-expect-error -- parentDocName is required.
const _missingParent: UploadRequest = { agentId: 'claude-1' };
void _missingParent;

// ---------------------------------------------------------------------------
// PrincipalSuccess / ServerInfoSuccess (existing schemas, regression guards)
// ---------------------------------------------------------------------------

const _validPrincipal: PrincipalSuccess = {
  id: 'principal-abc',
  display_name: 'Miles',
  display_email: '',
  source: 'git-config',
  created_at: '2026-04-27T00:00:00Z',
};
void _validPrincipal;

// Source must be a literal of the enum.
const _invalidSource: PrincipalSuccess = {
  id: 'p-1',
  display_name: 'Miles',
  display_email: '',
  // @ts-expect-error -- source is a closed enum, 'ldap' not in union.
  source: 'ldap',
  created_at: '2026-04-27T00:00:00Z',
};
void _invalidSource;

const _validServerInfo: ServerInfoSuccess = {
  serverInstanceId: 'a1b2c3',
};
void _validServerInfo;

// Missing serverInstanceId must NOT satisfy ServerInfoSuccess (`.min(1)` required).
// @ts-expect-error -- serverInstanceId is required, missing here.
const _missingServerInstanceId: ServerInfoSuccess = {
  currentBranch: 'main',
};
void _missingServerInstanceId;
