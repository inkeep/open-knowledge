import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  isBetaRelease,
  KEY_REJECTED_OUTPUT,
  LinearKeyRejectedError,
  linear,
  planTicketReconciliation,
  recordFailureOutputs,
  summarize,
} from './stamp-by-containment.mjs';

const rel = (id, version) => ({ id, name: `v${version}`, version });

const R = {
  '0.35.1': rel('r-0351', '0.35.1'),
  '0.35.6': rel('r-0356', '0.35.6'),
  '0.36.0': rel('r-0360', '0.36.0'),
  '0.42.0': rel('r-0420', '0.42.0'),
  '0.43.0': rel('r-0430', '0.43.0'),
  '0.45.3': rel('r-0453', '0.45.3'),
  '0.46.0': rel('r-0460', '0.46.0'),
  '0.46.1': rel('r-0461', '0.46.1'),
  '0.46.0-beta.35': rel('r-b35', '0.46.0-beta.35'),
  '0.47.0-beta.5': rel('r-b5', '0.47.0-beta.5'),
};
const byVersion = new Map(Object.entries(R));

const plan = (args) => planTicketReconciliation({ releaseByVersion: byVersion, ...args });

describe('isBetaRelease', () => {
  test.each([
    ['0.46.0-beta.35', true],
    ['0.47.0-beta.5', true],
    ['0.46.0', false],
    ['0.45.3', false],
  ])('%s -> beta=%s', (version, expected) => {
    expect(isBetaRelease({ version })).toBe(expected);
  });

  test('a missing version is not treated as a beta', () => {
    expect(isBetaRelease({})).toBe(false);
    expect(isBetaRelease(null)).toBe(false);
  });
});

describe('planTicketReconciliation', () => {
  test('an unresolvable fix commit is never acted on', () => {
    const p = plan({
      attachedReleases: [R['0.46.0']],
      shippedTag: null,
      evidence: 'unresolvable',
    });
    expect(p).toMatchObject({ action: 'skip', add: [], remove: [] });
  });

  test('an already-correct ticket is a noop', () => {
    expect(
      plan({ attachedReleases: [R['0.36.0']], shippedTag: 'v0.36.0', evidence: 'shipped' }).action,
    ).toBe('noop');
  });

  test('a ticket stamped ~10 releases late is moved to the earliest container', () => {
    const p = plan({
      attachedReleases: [R['0.46.0']],
      shippedTag: 'v0.36.0',
      evidence: 'shipped',
    });
    expect(p.action).toBe('attach');
    expect(p.add).toEqual([R['0.36.0'].id]);
    expect(p.remove).toEqual([R['0.46.0'].id]);
  });

  test('a spurious extra stable is dropped while the correct one is kept', () => {
    const p = plan({
      attachedReleases: [R['0.35.1'], R['0.35.6']],
      shippedTag: 'v0.35.6',
      evidence: 'shipped',
    });
    expect(p.action).toBe('reattach');
    expect(p.add).toEqual([]);
    expect(p.remove).toEqual([R['0.35.1'].id]);
  });

  test('an accumulator artifact is dropped without disturbing the real stamp', () => {
    const p = plan({
      attachedReleases: [R['0.45.3'], R['0.46.0']],
      shippedTag: 'v0.45.3',
      evidence: 'shipped',
    });
    expect(p.remove).toEqual([R['0.46.0'].id]);
    expect(p.add).toEqual([]);
  });

  test('BETA attachments are never touched', () => {
    const p = plan({
      attachedReleases: [R['0.46.0-beta.35'], R['0.46.0']],
      shippedTag: 'v0.46.1',
      evidence: 'shipped',
    });
    expect(p.add).toEqual([R['0.46.1'].id]);
    expect(p.remove).toEqual([R['0.46.0'].id]);
    expect(p.remove).not.toContain(R['0.46.0-beta.35'].id);
  });

  test('a beta-only ticket whose fix is not yet in a stable stays untouched', () => {
    const p = plan({
      attachedReleases: [R['0.47.0-beta.5']],
      shippedTag: null,
      evidence: 'proven-not-shipped',
    });
    expect(p).toMatchObject({ action: 'noop', add: [], remove: [], reason: 'not-in-any-stable' });
  });

  test('a stable stamp is withdrawn when the fix is PROVABLY not in any stable', () => {
    const p = plan({
      attachedReleases: [R['0.46.0'], R['0.47.0-beta.5']],
      shippedTag: null,
      evidence: 'proven-not-shipped',
    });
    expect(p.action).toBe('reattach');
    expect(p.remove).toEqual([R['0.46.0'].id]);
    expect(p.add).toEqual([]);
  });

  test('an UNRESOLVABLE fix commit never strips a stable, unlike a proven one', () => {
    const attachedReleases = [R['0.46.0'], R['0.47.0-beta.5']];
    const proven = plan({ attachedReleases, shippedTag: null, evidence: 'proven-not-shipped' });
    const unknown = plan({ attachedReleases, shippedTag: null, evidence: 'unresolvable' });

    expect(proven.remove).toEqual([R['0.46.0'].id]);
    expect(unknown.remove).toEqual([]);
    expect(unknown.action).toBe('skip');
  });

  test('a containing stable with no release object is reported, not invented', () => {
    const p = plan({
      attachedReleases: [R['0.46.0']],
      shippedTag: 'v0.99.9',
      evidence: 'shipped',
    });
    expect(p.action).toBe('skip');
    expect(p.reason).toBe('no-release-object:0.99.9');
    expect(p.remove).toEqual([]);
  });

  test('a ticket with no attachments at all gets the correct stable attached', () => {
    const p = plan({ attachedReleases: [], shippedTag: 'v0.43.0', evidence: 'shipped' });
    expect(p).toMatchObject({ action: 'attach', add: [R['0.43.0'].id], remove: [] });
  });
});

describe('summarize', () => {
  test('counts every action kind', () => {
    const plans = [
      { plan: { action: 'noop' } },
      { plan: { action: 'attach' } },
      { plan: { action: 'attach' } },
      { plan: { action: 'reattach' } },
      { plan: { action: 'skip' } },
    ];
    expect(summarize(plans)).toEqual({ noop: 1, attach: 2, reattach: 1, skip: 1 });
  });
});

describe('linear', () => {
  const reply = (status, body) => async () => ({
    ok: status < 400,
    status,
    text: async () => body,
  });

  test('a 401 names the rejected key so the alert can ask for rotation', async () => {
    const call = linear(
      'query {}',
      {},
      {
        apiKey: 'k',
        fetchImpl: reply(401, '{"errors":[{"code":"AUTHENTICATION_ERROR"}]}'),
      },
    );
    await expect(call).rejects.toBeInstanceOf(LinearKeyRejectedError);
    await expect(call).rejects.toThrow(/rotate the LINEAR_API_KEY secret/);
    await expect(call).rejects.toThrow(/AUTHENTICATION_ERROR/);
  });

  test('other HTTP failures keep the generic error', async () => {
    const call = linear('query {}', {}, { apiKey: 'k', fetchImpl: reply(503, 'upstream') });
    await expect(call).rejects.toThrow('linear HTTP 503: upstream');
    await expect(call).rejects.not.toBeInstanceOf(LinearKeyRejectedError);
  });
});

describe('recordFailureOutputs', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const outputFile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'stamp-output-'));
    dirs.push(dir);
    const path = join(dir, 'output');
    writeFileSync(path, '');
    return path;
  };

  test('a rejected key leaves the output the alert step reads', () => {
    const path = outputFile();
    recordFailureOutputs(new LinearKeyRejectedError('{}'), path);
    expect(readFileSync(path, 'utf8')).toBe(`${KEY_REJECTED_OUTPUT}=true\n`);
  });

  test('any other failure leaves the output empty', () => {
    const path = outputFile();
    recordFailureOutputs(new Error('linear HTTP 503: upstream'), path);
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  test('without an output file nothing is written and nothing throws', () => {
    expect(() => recordFailureOutputs(new LinearKeyRejectedError('{}'), undefined)).not.toThrow();
  });
});
