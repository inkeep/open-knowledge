import { beforeAll, describe, expect, it } from 'vitest';
import {
  type LifetimeObservation,
  OBSERVATION_LIMIT_MS,
  observeStandalonePrebuiltWorkerLifetime,
} from '../foundation/worker-lifetime/observe-standalone-prebuilt-lifetime.test-helper.ts';

describe('standalone prebuilt worker server lifetime:', () => {
  let observation: LifetimeObservation;
  beforeAll(async () => {
    observation = await observeStandalonePrebuiltWorkerLifetime();
  }, OBSERVATION_LIMIT_MS + 10_000);

  it('an abrupt worker exit leaves no ready server at 10s and 60s', () => {
    expect(observation.ready.exit.apiStatus).toBe(200);
    expect(observation.serverBirths.exit.length).toBeGreaterThanOrEqual(2);
    expect(
      observation.native.find(
        (row) => row.name === 'lifetime subject: worker exits after both real servers are ready',
      )?.errors,
    ).toContain('Error: worker process exited unexpectedly (code=83, signal=null)');
    expect(
      observation.samples
        .filter((sample) => sample.at === 10 || sample.at === 60)
        .map((sample) => {
          const server = sample.servers.find((entry) => entry.kind === 'exit');
          return {
            at: sample.at,
            livePids: server?.livePids,
            ownedListener: server?.ownedListener,
          };
        }),
    ).toEqual([
      { at: 10, livePids: [], ownedListener: false },
      { at: 60, livePids: [], ownedListener: false },
    ]);
  });

  it('a normal worker releases its ready server at 10s and 60s', () => {
    expect(observation.ready.peer.apiStatus).toBe(200);
    expect(observation.serverBirths.peer.length).toBeGreaterThanOrEqual(2);
    expect(
      observation.native.find(
        (row) => row.name === 'lifetime subject: peer uses its separate real server',
      )?.status,
    ).toBe('passed');
    expect(
      observation.samples
        .filter((sample) => sample.at === 10 || sample.at === 60)
        .map((sample) => {
          const server = sample.servers.find((entry) => entry.kind === 'peer');
          return {
            at: sample.at,
            livePids: server?.livePids,
            ownedListener: server?.ownedListener,
          };
        }),
    ).toEqual([
      { at: 10, livePids: [], ownedListener: false },
      { at: 60, livePids: [], ownedListener: false },
    ]);
  });
});
