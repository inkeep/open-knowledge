import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  buildShareContractManifest,
  SHARE_CONTRACT_CORPUS_SHA256,
} from './share-contract-manifest';

describe('share contract manifest', () => {
  test('attests the v2 epoch, checked-in fixture corpus, and Vercel deployment commit', async () => {
    const deploymentSha = '1234567890abcdef1234567890abcdef12345678';
    const corpusBytes = readFileSync(
      new URL('../../../test-support/fixtures/share-url-v1-v2.json', import.meta.url),
    );

    expect(buildShareContractManifest({ VERCEL_GIT_COMMIT_SHA: deploymentSha })).toEqual({
      epoch: 2,
      corpusSha256: SHARE_CONTRACT_CORPUS_SHA256,
      deploymentSha,
    });
    expect(SHARE_CONTRACT_CORPUS_SHA256).toBe(
      createHash('sha256').update(corpusBytes).digest('hex'),
    );
  });

  test('advertises an unusable deployment marker when no build commit is available', () => {
    expect(buildShareContractManifest({}).deploymentSha).toBe('unavailable');
  });
});
