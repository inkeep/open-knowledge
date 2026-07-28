import { describe, expect, test } from 'vitest';
import { applyClaGate, BOT_ALLOWLIST, evaluateClaGate, isBot } from './cla-gate.mjs';

describe('evaluateClaGate', () => {
  test('an exempt author is released regardless of status', () => {
    for (const claStatus of ['failure', 'pending', 'error', null, undefined]) {
      expect(evaluateClaGate({ claStatus, exempt: true })).toEqual({
        gated: false,
        reason: 'exempt',
      });
    }
  });

  test('a signed non-exempt author is released', () => {
    expect(evaluateClaGate({ claStatus: 'success' })).toEqual({
      gated: false,
      reason: 'cla-signed',
    });
  });

  test('an unsigned (failure) non-exempt author is gated', () => {
    expect(evaluateClaGate({ claStatus: 'failure' })).toEqual({
      gated: true,
      reason: 'cla-unsigned',
    });
  });

  test('absent or pending status fails closed', () => {
    for (const claStatus of [null, undefined, 'pending']) {
      expect(evaluateClaGate({ claStatus })).toEqual({ gated: true, reason: 'cla-pending' });
    }
  });

  test('errored status fails closed with a distinct infra-error reason', () => {
    expect(evaluateClaGate({ claStatus: 'error' })).toEqual({ gated: true, reason: 'cla-errored' });
  });

  test('failure (unsigned) and error (infra) are distinct reasons', () => {
    expect(evaluateClaGate({ claStatus: 'failure' }).reason).toBe('cla-unsigned');
    expect(evaluateClaGate({ claStatus: 'error' }).reason).toBe('cla-errored');
  });
});

describe('isBot', () => {
  test('matches listed bots case-insensitively', () => {
    expect(isBot('inkeep-oss-sync[bot]')).toBe(true);
    expect(isBot('Copilot-SWE-Agent[bot]')).toBe(true);
  });

  test('non-bots and empty logins are not bots', () => {
    expect(isBot('outsider')).toBe(false);
    expect(isBot(null)).toBe(false);
    expect(isBot(undefined)).toBe(false);
  });

  test('the published BOT_ALLOWLIST holds only bot actors, no humans', () => {
    expect(BOT_ALLOWLIST.length).toBeGreaterThan(0);
    expect(BOT_ALLOWLIST.every((login) => login.endsWith('[bot]'))).toBe(true);
  });
});

describe('applyClaGate', () => {
  const fakeGh = (
    claStatus,
    { isMember = false, throwOnRead = false, throwOnMembership = false } = {},
  ) => {
    const recorded = {
      draft: undefined,
      status: undefined,
      description: undefined,
      reads: 0,
      memberChecks: 0,
    };
    return {
      recorded,
      isOrgMember: async () => {
        recorded.memberChecks += 1;
        if (throwOnMembership) throw new Error('membership api unavailable');
        return isMember;
      },
      readClaStatus: async () => {
        recorded.reads += 1;
        if (throwOnRead) throw new Error('status api unavailable');
        return claStatus;
      },
      setDraft: async (_pr, shouldBeDraft) => {
        recorded.draft = shouldBeDraft;
      },
      setVerifiedStatus: async (_pr, state, description) => {
        recorded.status = state;
        recorded.description = description;
      },
    };
  };
  const publicPr = (login, draft = false) => ({
    user: { login },
    draft,
    head: { sha: 'public-sha' },
  });
  const internalPr = { head: { sha: 'internal-sha' } };

  test('unsigned non-member external PR is held draft with a failing cla/verified status', async () => {
    const gh = fakeGh('failure');
    const gate = await applyClaGate({ gh, publicPr: publicPr('outsider'), internalPr });
    expect(gh.recorded.draft).toBe(true);
    expect(gh.recorded.status).toBe('failure');
    expect(gate).toMatchObject({ gated: true, reason: 'cla-unsigned' });
  });

  test('signed non-member external PR is set ready with a success status', async () => {
    const gh = fakeGh('success');
    const gate = await applyClaGate({ gh, publicPr: publicPr('outsider'), internalPr });
    expect(gh.recorded.draft).toBe(false);
    expect(gh.recorded.status).toBe('success');
    expect(gate.gated).toBe(false);
  });

  test('an org member is released without reading the CLA status', async () => {
    const gh = fakeGh(null, { isMember: true });
    const gate = await applyClaGate({ gh, publicPr: publicPr('employee'), internalPr });
    expect(gate).toMatchObject({ gated: false, reason: 'exempt' });
    expect(gh.recorded.reads).toBe(0);
    expect(gh.recorded.draft).toBe(false);
    expect(gh.recorded.status).toBe('success');
  });

  test('a listed bot is released without any membership or status read', async () => {
    const gh = fakeGh(null);
    const gate = await applyClaGate({ gh, publicPr: publicPr('inkeep-oss-sync[bot]'), internalPr });
    expect(gate).toMatchObject({ gated: false, reason: 'exempt' });
    expect(gh.recorded.memberChecks).toBe(0);
    expect(gh.recorded.reads).toBe(0);
  });

  test('a membership read failure fails closed', async () => {
    const gh = fakeGh('success', { throwOnMembership: true });
    const gate = await applyClaGate({ gh, publicPr: publicPr('outsider'), internalPr });
    expect(gate.reason).toBe('cla-read-error');
    expect(gh.recorded.draft).toBe(true);
    expect(gh.recorded.status).toBe('failure');
  });

  test('a status read failure fails closed', async () => {
    const gh = fakeGh(null, { throwOnRead: true });
    const gate = await applyClaGate({ gh, publicPr: publicPr('outsider'), internalPr });
    expect(gate.reason).toBe('cla-read-error');
    expect(gh.recorded.draft).toBe(true);
    expect(gh.recorded.status).toBe('failure');
  });

  test("an errored CLA check is held but not told to 'sign the CLA'", async () => {
    const gh = fakeGh('error');
    const gate = await applyClaGate({ gh, publicPr: publicPr('outsider'), internalPr });
    expect(gate.reason).toBe('cla-errored');
    expect(gh.recorded.draft).toBe(true);
    expect(gh.recorded.description).not.toMatch(/sign the cla/i);
  });

  test('re-sync after a new unsigned head re-blocks a released PR', async () => {
    const signed = fakeGh('success');
    await applyClaGate({ gh: signed, publicPr: publicPr('outsider'), internalPr });
    expect(signed.recorded.draft).toBe(false);

    const reUnsigned = fakeGh('failure');
    await applyClaGate({ gh: reUnsigned, publicPr: publicPr('outsider'), internalPr });
    expect(reUnsigned.recorded.draft).toBe(true);
    expect(reUnsigned.recorded.status).toBe('failure');
  });

  test('a signed PR that is itself a draft upstream stays draft, with success status', async () => {
    const gh = fakeGh('success');
    await applyClaGate({ gh, publicPr: publicPr('outsider', true), internalPr });
    expect(gh.recorded.draft).toBe(true);
    expect(gh.recorded.status).toBe('success');
  });

  test('forceDraft holds a signed, ungated PR draft (conflict markers need manual resolution)', async () => {
    const gh = fakeGh('success');
    const gate = await applyClaGate({
      gh,
      publicPr: publicPr('outsider'),
      internalPr,
      forceDraft: true,
    });
    expect(gh.recorded.draft).toBe(true);
    // The gate itself is not gated (CLA is signed); the draft is purely the
    // conflict hold, so cla/verified still reports success.
    expect(gate.gated).toBe(false);
    expect(gh.recorded.status).toBe('success');
  });

  test('a missing author is gated (no bot or member match, fails closed on status)', async () => {
    const gh = fakeGh(null);
    const gate = await applyClaGate({
      gh,
      publicPr: { draft: false, head: { sha: 's' } },
      internalPr,
    });
    expect(gate.gated).toBe(true);
    expect(gh.recorded.memberChecks).toBe(0);
  });
});
