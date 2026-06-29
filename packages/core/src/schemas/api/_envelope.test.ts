import { describe, expect, test } from 'bun:test';
import {
  LocalOpCloneRequestSchema,
  PrincipalSuccessSchema,
  ProblemDetailsSchema,
  ProblemTypeSchema,
  StreamingProblemEventSchema,
  UploadAssetSuccessSchema,
  UploadRequestSchema,
} from './index.ts';

const validPrincipal = {
  id: 'principal-abc123',
  display_name: 'Ada Lovelace-King',
  display_email: 'miles@example.com',
  source: 'git-config' as const,
  created_at: '2026-04-27T00:00:00.000Z',
};

describe('PrincipalSuccessSchema', () => {
  test('parses a valid git-config principal', () => {
    const result = PrincipalSuccessSchema.safeParse(validPrincipal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('principal-abc123');
      expect(result.data.display_name).toBe('Ada Lovelace-King');
      expect(result.data.source).toBe('git-config');
    }
  });

  test('parses a valid synthesized principal', () => {
    const result = PrincipalSuccessSchema.safeParse({
      ...validPrincipal,
      source: 'synthesized',
      display_name: 'Local User',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('synthesized');
    }
  });

  test('preserves unknown fields for forward-compat (loose schema)', () => {
    const result = PrincipalSuccessSchema.safeParse({
      ...validPrincipal,
      future_field: 'new-server-value',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).future_field).toBe('new-server-value');
    }
  });

  test('fails when id is missing', () => {
    const { id: _id, ...withoutId } = validPrincipal;
    const result = PrincipalSuccessSchema.safeParse(withoutId);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  test('fails when id is an empty string', () => {
    const result = PrincipalSuccessSchema.safeParse({ ...validPrincipal, id: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  test('fails when display_name is an empty string', () => {
    const result = PrincipalSuccessSchema.safeParse({ ...validPrincipal, display_name: '' });
    expect(result.success).toBe(false);
  });

  test('accepts empty display_email (field is server-only; absence should not discard usable name+id)', () => {
    const result = PrincipalSuccessSchema.safeParse({ ...validPrincipal, display_email: '' });
    expect(result.success).toBe(true);
  });

  test('fails when source is an invalid enum value', () => {
    const result = PrincipalSuccessSchema.safeParse({
      ...validPrincipal,
      source: 'ldap',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  test('fails when display_name is not a string', () => {
    const result = PrincipalSuccessSchema.safeParse({
      ...validPrincipal,
      display_name: 42,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  test('fails when the entire object is null', () => {
    const result = PrincipalSuccessSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});


describe('ProblemTypeSchema', () => {
  test('accepts the seeded upload-side URN tokens', () => {
    const tokens = [
      'urn:ok:error:malformed-upload',
      'urn:ok:error:collision-exhaustion',
      'urn:ok:error:storage-full',
      'urn:ok:error:storage-readonly',
      'urn:ok:error:storage-error',
      'urn:ok:error:no-file-received',
      'urn:ok:error:path-escape',
    ];
    for (const t of tokens) {
      const result = ProblemTypeSchema.safeParse(t);
      expect(result.success).toBe(true);
    }
  });

  test('accepts the cross-handler shared URN tokens', () => {
    const tokens = [
      'urn:ok:error:method-not-allowed',
      'urn:ok:error:invalid-request',
      'urn:ok:error:internal-server-error',
    ];
    for (const t of tokens) {
      const result = ProblemTypeSchema.safeParse(t);
      expect(result.success).toBe(true);
    }
  });

  test('accepts the local-op security gate URN tokens', () => {
    const tokens = ['urn:ok:error:loopback-required', 'urn:ok:error:invalid-origin'];
    for (const t of tokens) {
      const result = ProblemTypeSchema.safeParse(t);
      expect(result.success).toBe(true);
    }
  });

  test('accepts the local-op clone URN tokens (US-005)', () => {
    const tokens = [
      'urn:ok:error:url-not-allowed',
      'urn:ok:error:dir-outside-home',
      'urn:ok:error:concurrent-operation',
      'urn:ok:error:clone-failed',
      'urn:ok:error:clone-timeout',
      'urn:ok:error:server-start-failed',
    ];
    for (const t of tokens) {
      const result = ProblemTypeSchema.safeParse(t);
      expect(result.success).toBe(true);
    }
  });

  test('rejects relative-URI form (D38: URN form is canonical, not /errors/<kebab>)', () => {
    const result = ProblemTypeSchema.safeParse('/errors/malformed-upload');
    expect(result.success).toBe(false);
  });

  test('rejects bare kebab tokens (closed by policy, NG1)', () => {
    const result = ProblemTypeSchema.safeParse('malformed-upload');
    expect(result.success).toBe(false);
  });

  test('rejects undeclared URN tokens (closed by policy)', () => {
    const result = ProblemTypeSchema.safeParse('urn:ok:error:undeclared-token');
    expect(result.success).toBe(false);
  });
});

describe('ProblemDetailsSchema', () => {
  const validProblem = {
    type: 'urn:ok:error:malformed-upload' as const,
    title: 'The uploaded multipart payload is malformed.',
    status: 400,
  };

  test('parses a minimal valid problem (required fields only)', () => {
    const result = ProblemDetailsSchema.safeParse(validProblem);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('urn:ok:error:malformed-upload');
      expect(result.data.title).toBe('The uploaded multipart payload is malformed.');
      expect(result.data.status).toBe(400);
    }
  });

  test('parses a fully-populated problem with instance and detail', () => {
    const result = ProblemDetailsSchema.safeParse({
      ...validProblem,
      instance: 'urn:uuid:01234567-89ab-4def-8123-456789abcdef',
      detail: 'busboy reported a parse error during upload.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.instance).toBe('urn:uuid:01234567-89ab-4def-8123-456789abcdef');
      expect(result.data.detail).toBe('busboy reported a parse error during upload.');
    }
  });

  test('preserves unknown extension fields (RFC 9457 §3.2 / .loose())', () => {
    const result = ProblemDetailsSchema.safeParse({
      ...validProblem,
      errors: [{ field: 'parentDocName', message: 'required' }],
      documentation_url: 'https://example.com/docs/upload',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).errors).toBeDefined();
      expect((result.data as Record<string, unknown>).documentation_url).toBe(
        'https://example.com/docs/upload',
      );
    }
  });

  test('fails when title is missing', () => {
    const { title: _title, ...withoutTitle } = validProblem;
    const result = ProblemDetailsSchema.safeParse(withoutTitle);
    expect(result.success).toBe(false);
  });

  test('fails when title is empty string (D14: title required, non-empty)', () => {
    const result = ProblemDetailsSchema.safeParse({ ...validProblem, title: '' });
    expect(result.success).toBe(false);
  });

  test('fails when status is below 400 (errors only)', () => {
    const result = ProblemDetailsSchema.safeParse({ ...validProblem, status: 200 });
    expect(result.success).toBe(false);
  });

  test('fails when status is above 599 (HTTP status range)', () => {
    const result = ProblemDetailsSchema.safeParse({ ...validProblem, status: 600 });
    expect(result.success).toBe(false);
  });

  test('fails when status is not an integer', () => {
    const result = ProblemDetailsSchema.safeParse({ ...validProblem, status: 400.5 });
    expect(result.success).toBe(false);
  });

  test('fails when instance is a bare UUID without urn:uuid: prefix (RFC 9457 §3.1.6)', () => {
    const result = ProblemDetailsSchema.safeParse({
      ...validProblem,
      instance: '01234567-89ab-4def-8123-456789abcdef',
    });
    expect(result.success).toBe(false);
  });

  test('fails when instance has the prefix but malformed UUID body', () => {
    const result = ProblemDetailsSchema.safeParse({
      ...validProblem,
      instance: 'urn:uuid:not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  test('fails when type is not a registered URN token', () => {
    const result = ProblemDetailsSchema.safeParse({
      ...validProblem,
      type: 'urn:ok:error:fictional-token',
    });
    expect(result.success).toBe(false);
  });
});

describe('UploadAssetSuccessSchema', () => {
  test('parses a minimal valid success (src only)', () => {
    const result = UploadAssetSuccessSchema.safeParse({ src: 'attachments/photo.png' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.src).toBe('attachments/photo.png');
    }
  });

  test('parses a fully-populated success with dedup metadata', () => {
    const result = UploadAssetSuccessSchema.safeParse({
      src: 'photo.png',
      path: 'docs/photo.png',
      deduped: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.src).toBe('photo.png');
      expect(result.data.path).toBe('docs/photo.png');
      expect(result.data.deduped).toBe(true);
    }
  });

  test('preserves unknown fields for forward-compat (.loose())', () => {
    const result = UploadAssetSuccessSchema.safeParse({
      src: 'attachments/photo.png',
      future_field: 'new-server-value',
    });
    expect(result.success).toBe(true);
  });

  test('does NOT contain ok:true wrapper field (D22 success drops wrapper)', () => {
    const result = UploadAssetSuccessSchema.safeParse({ src: 'foo.png' });
    expect(result.success).toBe(true);
    if (result.success) {
      // @ts-expect-error -- ok is not a field on UploadAssetSuccess
      void result.data.ok;
    }
  });

  test('fails when src is missing', () => {
    const result = UploadAssetSuccessSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test('fails when src is empty', () => {
    const result = UploadAssetSuccessSchema.safeParse({ src: '' });
    expect(result.success).toBe(false);
  });

  test('fails when path is empty', () => {
    const result = UploadAssetSuccessSchema.safeParse({ src: 'foo.png', path: '' });
    expect(result.success).toBe(false);
  });
});

describe('UploadRequestSchema', () => {
  test('parses a valid request with parentDocName only', () => {
    const result = UploadRequestSchema.safeParse({ parentDocName: 'notes/index' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parentDocName).toBe('notes/index');
    }
  });

  test('parses a request with optional agent identity', () => {
    const result = UploadRequestSchema.safeParse({
      parentDocName: 'notes/index',
      agentId: 'claude-1',
      agentName: 'Claude',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agentId).toBe('claude-1');
      expect(result.data.agentName).toBe('Claude');
    }
  });

  test('fails when parentDocName is missing', () => {
    const result = UploadRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test('fails when parentDocName is empty', () => {
    const result = UploadRequestSchema.safeParse({ parentDocName: '' });
    expect(result.success).toBe(false);
  });
});

describe('LocalOpCloneRequestSchema (US-005)', () => {
  test('parses a valid request with url + dir', () => {
    const result = LocalOpCloneRequestSchema.safeParse({
      url: 'https://github.com/owner/repo',
      dir: '~/Documents/repo',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.url).toBe('https://github.com/owner/repo');
      expect(result.data.dir).toBe('~/Documents/repo');
    }
  });

  test('preserves unknown fields for forward-compat (.loose())', () => {
    const result = LocalOpCloneRequestSchema.safeParse({
      url: 'git@github.com:owner/repo',
      dir: '~/work/repo',
      branch: 'main',
    });
    expect(result.success).toBe(true);
  });

  test('fails when url is missing', () => {
    const result = LocalOpCloneRequestSchema.safeParse({ dir: '~/Documents/repo' });
    expect(result.success).toBe(false);
  });

  test('fails when dir is missing', () => {
    const result = LocalOpCloneRequestSchema.safeParse({ url: 'https://github.com/owner/repo' });
    expect(result.success).toBe(false);
  });

  test('fails when url is empty', () => {
    const result = LocalOpCloneRequestSchema.safeParse({ url: '', dir: '~/Documents/repo' });
    expect(result.success).toBe(false);
  });

  test('fails when dir is empty', () => {
    const result = LocalOpCloneRequestSchema.safeParse({
      url: 'https://github.com/owner/repo',
      dir: '',
    });
    expect(result.success).toBe(false);
  });

  test('rejects a leading-dash branch (git CLI flag injection)', () => {
    const result = LocalOpCloneRequestSchema.safeParse({
      url: 'https://github.com/owner/repo',
      dir: '~/Documents/repo',
      branch: '--upload-pack=evil',
    });
    expect(result.success).toBe(false);
  });

  test('rejects a branch containing colon (refspec separator)', () => {
    const result = LocalOpCloneRequestSchema.safeParse({
      url: 'https://github.com/owner/repo',
      dir: '~/Documents/repo',
      branch: 'HEAD:refs/heads/evil',
    });
    expect(result.success).toBe(false);
  });

  test('rejects a branch containing whitespace', () => {
    const result = LocalOpCloneRequestSchema.safeParse({
      url: 'https://github.com/owner/repo',
      dir: '~/Documents/repo',
      branch: 'main injected',
    });
    expect(result.success).toBe(false);
  });

  test('rejects a branch containing `..` segment', () => {
    const result = LocalOpCloneRequestSchema.safeParse({
      url: 'https://github.com/owner/repo',
      dir: '~/Documents/repo',
      branch: 'feat/../escape',
    });
    expect(result.success).toBe(false);
  });
});

describe('StreamingProblemEventSchema (US-005, D36 c)', () => {
  test('parses a valid mid-stream error event with full ProblemDetails', () => {
    const result = StreamingProblemEventSchema.safeParse({
      type: 'error',
      problem: {
        type: 'urn:ok:error:clone-failed',
        title: 'Clone subprocess exited with non-zero status.',
        status: 500,
        instance: 'urn:uuid:01234567-89ab-4def-8123-456789abcdef',
        detail: 'fatal: repository not found',
      },
    });
    expect(result.success).toBe(true);
  });

  test('parses a minimal mid-stream error event (problem with required fields only)', () => {
    const result = StreamingProblemEventSchema.safeParse({
      type: 'error',
      problem: {
        type: 'urn:ok:error:clone-timeout',
        title: 'Clone timed out after 10 minutes.',
        status: 504,
      },
    });
    expect(result.success).toBe(true);
  });

  test('fails when outer type is not "error" (streaming protocol discriminator)', () => {
    const result = StreamingProblemEventSchema.safeParse({
      type: 'progress',
      problem: { type: 'urn:ok:error:clone-failed', title: 'foo', status: 500 },
    });
    expect(result.success).toBe(false);
  });

  test('fails when problem field is missing', () => {
    const result = StreamingProblemEventSchema.safeParse({ type: 'error' });
    expect(result.success).toBe(false);
  });

  test('fails when problem field has invalid URN type', () => {
    const result = StreamingProblemEventSchema.safeParse({
      type: 'error',
      problem: { type: 'urn:ok:error:fictional-token', title: 'foo', status: 500 },
    });
    expect(result.success).toBe(false);
  });
});

