
import type {
  PrincipalSuccess,
  ProblemDetails,
  ProblemType,
  ServerInfoSuccess,
  UploadAssetSuccess,
  UploadRequest,
} from './api/index.ts';


const _validProblemType: ProblemType = 'urn:ok:error:malformed-upload';
void _validProblemType;

// @ts-expect-error -- ProblemType is the URN form `urn:ok:error:<kebab>`, not bare kebab.
const _bareKebab: ProblemType = 'malformed-upload';
void _bareKebab;

// @ts-expect-error -- ProblemType is URN form, not `/errors/<kebab>` relative URI.
const _relativeUri: ProblemType = '/errors/malformed-upload';
void _relativeUri;

// @ts-expect-error -- ProblemType is a closed literal-union; free-form strings rejected.
const _freeFormString: ProblemType = 'something-else';
void _freeFormString;


const _validProblem: ProblemDetails = {
  type: 'urn:ok:error:malformed-upload',
  title: 'The uploaded multipart payload is malformed.',
  status: 400,
};
void _validProblem;

// @ts-expect-error -- title is required.
const _missingTitle: ProblemDetails = {
  type: 'urn:ok:error:malformed-upload',
  status: 400,
};
void _missingTitle;

// @ts-expect-error -- status is required.
const _missingStatus: ProblemDetails = {
  type: 'urn:ok:error:malformed-upload',
  title: 'oops',
};
void _missingStatus;

const _widenedType: ProblemDetails = {
  // @ts-expect-error -- type must be ProblemType, not arbitrary string.
  type: 'arbitrary-string',
  title: 'oops',
  status: 400,
};
void _widenedType;


const _validSuccess: UploadAssetSuccess = { src: 'attachments/photo.png' };
void _validSuccess;

// @ts-expect-error -- src is required.
const _missingSrc: UploadAssetSuccess = { deduped: true };
void _missingSrc;

const _validHasSrc: UploadAssetSuccess = { src: 'foo.png' };
void _validHasSrc;


const _validRequest: UploadRequest = { parentDocName: 'notes/index' };
void _validRequest;

const _withAgentIdentity: UploadRequest = {
  parentDocName: 'notes/index',
  agentId: 'claude-1',
  agentName: 'Claude',
};
void _withAgentIdentity;

// @ts-expect-error -- parentDocName is required.
const _missingParent: UploadRequest = { agentId: 'claude-1' };
void _missingParent;


const _validPrincipal: PrincipalSuccess = {
  id: 'principal-abc',
  display_name: 'Miles',
  display_email: '',
  source: 'git-config',
  created_at: '2026-04-27T00:00:00Z',
};
void _validPrincipal;

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

// @ts-expect-error -- serverInstanceId is required, missing here.
const _missingServerInstanceId: ServerInfoSuccess = {
  currentBranch: 'main',
};
void _missingServerInstanceId;
