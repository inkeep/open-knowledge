import type { TestInfo } from '@playwright/test';
import { shouldAttachStderr } from './electron-stderr';
import {
  bootGapLineFor,
  bootNarrationFor,
  formatBootGapLine,
  readBootLog,
  readyWaitsFor,
  tryBootLogFor,
  tryFirstWaitFor,
  tryLaunchHomeFor,
} from './launch-readiness';

export type BootGapAttachTarget = Pick<TestInfo, 'attach'> &
  Pick<TestInfo, 'status' | 'retry' | 'project'>;

export async function emitBootGapLines(
  apps: readonly object[],
  testInfo: BootGapAttachTarget,
  log: (line: string) => void = console.log,
  warn: (line: string) => void = console.warn,
): Promise<void> {
  const homes = apps.map((app) => tryLaunchHomeFor(app));
  for (const [slot, app] of apps.entries()) {
    const home = homes[slot];
    if (home === undefined) continue;
    const suffix = `-slot${slot}`;
    const narration = bootNarrationFor(tryBootLogFor(app), readBootLog(home));
    const readyWaits = readyWaitsFor(app);
    const firstWait = tryFirstWaitFor(app);
    const gap = bootGapLineFor({
      slot,
      narration,
      readyWaitCount: readyWaits?.length ?? 0,
      ...(firstWait === undefined ? {} : { firstWait }),
      homeShared: homes.filter((h) => h === home).length > 1,
    });
    log(formatBootGapLine(gap));
    let attempted = `boot-log-gaps${suffix}`;
    try {
      await testInfo.attach(attempted, {
        body: JSON.stringify(gap, null, 2),
        contentType: 'application/json',
      });
      if (narration.lines.length > 0 && shouldAttachStderr(testInfo)) {
        attempted = `boot-log${suffix}`;
        await testInfo.attach(attempted, {
          body: narration.lines.join('\n'),
          contentType: 'text/plain',
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warn(`[smoke-test] slot=${slot} could not attach ${attempted}: ${reason}`);
    }
  }
}
