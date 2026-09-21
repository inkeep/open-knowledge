import { isDeepStrictEqual } from 'node:util';
import type { OkTerminalDockState } from '@inkeep/open-knowledge-core/desktop-bridge';
import { expect } from '@playwright/test';

export type AgentsDockRecord = NonNullable<OkTerminalDockState['agents']>;

export interface WaitForAgentsDockPublishOptions {
  timeout: number;
  interval?: number;
}

const PUBLISHED = 'agents dock record published';

export async function waitForAgentsDockPublish(
  readDockState: () => Promise<Pick<OkTerminalDockState, 'agents'> | undefined>,
  priorAgents: AgentsDockRecord | undefined,
  { timeout, interval = 250 }: WaitForAgentsDockPublishOptions,
): Promise<void> {
  if (!(timeout > 0)) {
    throw new Error(
      `waitForAgentsDockPublish needs a positive timeout budget; received ${timeout}. ` +
        `toPass({ timeout: 0 }) waits without a deadline and fails as an unattributable test timeout.`,
    );
  }
  await expect(async () => {
    expect(describeAgentsPublish(await readDockState(), priorAgents)).toBe(PUBLISHED);
  }).toPass({ timeout, intervals: [interval] });
}

function describeAgentsPublish(
  state: Pick<OkTerminalDockState, 'agents'> | undefined,
  prior: AgentsDockRecord | undefined,
): string {
  if (state === undefined) return 'no dock state read from the desktop bridge';
  const latest = state.agents;
  if (latest === undefined) return 'no agents dock record published';
  if (prior !== undefined && isDeepStrictEqual(latest, prior)) {
    return `agents dock record unchanged from ${JSON.stringify(prior)}`;
  }
  return PUBLISHED;
}
