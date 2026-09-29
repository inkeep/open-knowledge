import type { CommentThreadPatch } from './types.ts';

// @ts-expect-error createdBy is deliberately outside CommentThreadPatch
const _identityPatch: CommentThreadPatch = { createdBy: 'principal-someone-else' };
void _identityPatch;
