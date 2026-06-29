import type { ElectronApplication, TestInfo } from '@playwright/test';

export interface ElectronStderrCapture {
  drain(): string;
  attachTo(testInfo: TestInfo): Promise<void>;
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

export function captureElectronStderr(app: ElectronApplication): ElectronStderrCapture {
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
    drain() {
      return buffer.join('');
    },
    async attachTo(testInfo) {
      await testInfo.attach('main-process-stderr', {
        body: buffer.join('') || '(no stdout/stderr captured)',
        contentType: 'text/plain',
      });
    },
  };
}
