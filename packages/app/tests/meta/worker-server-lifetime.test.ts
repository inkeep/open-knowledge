import { beforeAll, describe, expect, it } from 'vitest';
import {
  type LifetimeObservation,
  OBSERVATION_LIMIT_MS,
  observeWorkerLifetime,
} from '../foundation/worker-lifetime/observe-worker-lifetime.test-helper.ts';

describe('ordinary worker server lifetime', () => {
  for (const mode of ['dev-server', 'prebuilt'] as const) {
    describe(`${mode}:`, () => {
      let observation: LifetimeObservation;
      beforeAll(async () => {
        observation = await observeWorkerLifetime(mode);
      }, OBSERVATION_LIMIT_MS + 10_000);

      it('an abrupt worker exit leaves no ready server at 10s and 60s', () => {
        expect(observation.ready.exit.apiStatus).toBe(200);
        expect(observation.serverBirths.exit.length).toBeGreaterThanOrEqual(2);
        expect(
          observation.native.find(
            (row) =>
              row.name === 'lifetime subject: worker exits after both real servers are ready',
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

      it('the normal peer executes and releases its ready server', () => {
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
  }
});
