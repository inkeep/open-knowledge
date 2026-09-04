import type { ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import type { TestInfo } from '@playwright/test';

export type StderrAttachTarget = Pick<TestInfo, 'outputPath' | 'attach'>;

export interface StderrCaptureSource {
  process(): Pick<ChildProcess, 'stdout' | 'stderr'>;
}

function stderrArtifactName(slot: number): string {
  return slot === 0 ? 'main-process-stderr' : `main-process-stderr-${slot + 1}`;
}

export interface ElectronStderrCapture {
  attachTo(testInfo: StderrAttachTarget, slot: number): Promise<void>;
}

export function shouldAttachStderr(
  testInfo: Pick<TestInfo, 'status' | 'retry' | 'project'>,
): boolean {
  const retries = testInfo.project.retries ?? 0;
  const isFinalAttempt = testInfo.retry >= retries;
  const isFailing =
    testInfo.status === 'failed' ||
    testInfo.status === 'timedOut' ||
    testInfo.status === 'interrupted';
  return isFinalAttempt && isFailing;
}

export async function attachCapturedStderr(
  testInfo: StderrAttachTarget,
  captures: readonly ElectronStderrCapture[],
): Promise<void> {
  for (const [slot, capture] of captures.entries()) {
    try {
      await capture.attachTo(testInfo, slot);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[electron-stderr] could not attach ${stderrArtifactName(slot)}.txt: ${reason}. ` +
          'An attach-only failure leaves the bytes under the output directory; ' +
          'a write failure leaves nothing there.',
      );
    }
  }
}

export function captureElectronStderr(app: StderrCaptureSource): ElectronStderrCapture {
  const buffer: string[] = [];
  const proc = app.process();

  function onChunk(stream: 'stdout' | 'stderr') {
    return (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      buffer.push(`[${stream}] ${text}`);
    };
  }

  proc.stdout?.on('data', onChunk('stdout'));
  proc.stderr?.on('data', onChunk('stderr'));

  return {
    async attachTo(testInfo, slot) {
      const text = buffer.join('') || '(no stdout/stderr captured)';
      const name = stderrArtifactName(slot);
      const file = testInfo.outputPath(`${name}.txt`);
      writeFileSync(file, text, 'utf8');
      await testInfo.attach(name, { path: file, contentType: 'text/plain' });
    },
  };
}
