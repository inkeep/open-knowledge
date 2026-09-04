import { describe, expect, test } from 'vitest';
import {
  classifyUploadFailure,
  probeFileReadable,
  reportUploadFailure,
  uploadFailureMessage,
} from './upload-failure.ts';

function unreadableBlob(size: number): Blob {
  const blob = new Blob(['x'.repeat(size)]);
  return Object.assign(blob, {
    slice: () =>
      Object.assign(new Blob(), {
        arrayBuffer: () => Promise.reject(new DOMException('denied', 'NotReadableError')),
      }),
  }) as unknown as Blob;
}

function stalledBlob(size: number): Blob {
  const blob = new Blob(['x'.repeat(size)]);
  return Object.assign(blob, {
    slice: () =>
      Object.assign(new Blob(), {
        arrayBuffer: () => new Promise<ArrayBuffer>(() => {}),
      }),
  }) as unknown as Blob;
}

function fileOf(parts: BlobPart[], name: string, type = 'image/png'): File {
  return new File(parts, name, { type });
}

describe('probeFileReadable', () => {
  test('reports readable when the bytes are still there', async () => {
    const file = new Blob(['hello world']);
    const probe = await probeFileReadable(file, file.size);
    expect(probe.readable).toBe(true);
    expect(probe.bytesRead).toBe(1);
  });

  test('reports UNREADABLE when the backing store vanished (size collapsed to 0)', async () => {
    const probe = await probeFileReadable(new Blob([]), 788646);
    expect(probe.readable).toBe(false);
    expect(probe.bytesRead).toBe(0);
  });

  test('reports UNREADABLE when the read itself throws', async () => {
    const probe = await probeFileReadable(unreadableBlob(10), 10);
    expect(probe.readable).toBe(false);
    expect(probe.error).toContain('NotReadableError');
  });

  test('treats a genuinely empty file as readable', async () => {
    const probe = await probeFileReadable(new Blob([]), 0);
    expect(probe.readable).toBe(true);
  });

  test('bounds the read by the drop-time size, not the current size', async () => {
    const vanished = await probeFileReadable(new Blob([]), 1024);
    const genuinelyEmpty = await probeFileReadable(new Blob([]), 0);
    expect(vanished.readable).toBe(false);
    expect(genuinelyEmpty.readable).toBe(true);
  });

  test('gives up on a read that never settles instead of hanging', async () => {
    const probe = await probeFileReadable(stalledBlob(1024), 1024, 20);
    expect(probe.timedOut).toBe(true);
    expect(probe.readable).toBe(false);
  });
});

describe('classifyUploadFailure', () => {
  test('an unreadable file classifies as file-unreadable', () => {
    expect(classifyUploadFailure({ readable: false, bytesRead: 0 })).toBe('file-unreadable');
  });

  test('a readable file classifies as network', () => {
    expect(classifyUploadFailure({ readable: true, bytesRead: 1 })).toBe('network');
  });

  test('a stalled read is not reported as a server problem', () => {
    expect(classifyUploadFailure({ readable: false, bytesRead: 0, timedOut: true })).toBe(
      'file-unreadable',
    );
  });
});

describe('uploadFailureMessage', () => {
  test('the unreadable message names the file and does not blame the server', () => {
    const message = uploadFailureMessage('file-unreadable', 'shot.png');
    expect(message).toContain('shot.png');
    expect(message.toLowerCase()).not.toContain('server');
  });

  test('the network message names the file and points at the server', () => {
    const message = uploadFailureMessage('network', 'shot.png');
    expect(message).toContain('shot.png');
    expect(message.toLowerCase()).toContain('server');
  });

  test('the two kinds do not share copy', () => {
    expect(uploadFailureMessage('file-unreadable', 'a.png')).not.toBe(
      uploadFailureMessage('network', 'a.png'),
    );
  });
});

describe('reportUploadFailure', () => {
  test('a vanished file yields the unreadable kind, message and log', async () => {
    const report = await reportUploadFailure({
      file: fileOf([], 'shot.png'),
      sizeAtDrop: 788646,
      error: new TypeError('Failed to fetch'),
    });
    expect(report.kind).toBe('file-unreadable');
    expect(report.message).toContain('shot.png');
    expect(report.log).toMatchObject({
      kind: 'file-unreadable',
      name: 'shot.png',
      type: 'image/png',
      sizeAtDrop: 788646,
      sizeAtSend: 0,
      error: 'TypeError: Failed to fetch',
    });
  });

  test('a readable file yields the network kind', async () => {
    const report = await reportUploadFailure({
      file: fileOf(['hello'], 'ok.png'),
      sizeAtDrop: 5,
      error: new TypeError('Failed to fetch'),
    });
    expect(report.kind).toBe('network');
    expect(report.log).toMatchObject({ sizeAtDrop: 5, sizeAtSend: 5, bytesRead: 1 });
  });
});
