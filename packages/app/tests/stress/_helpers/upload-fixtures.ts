export function uniqueAssetName(filename: string, runId: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1
    ? `${filename}-${runId}`
    : `${filename.slice(0, dot)}-${runId}${filename.slice(dot)}`;
}

export function createPngBuffer(salt?: string): Buffer {
  const base = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRElEQrkJggg==',
    'base64',
  );
  return salt === undefined ? base : Buffer.concat([base, Buffer.from(salt, 'utf8')]);
}

export function createMp4Buffer(salt?: string): Buffer {
  const base = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
    0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d,
  ]);
  return salt === undefined ? base : Buffer.concat([base, Buffer.from(salt, 'utf8')]);
}

export function createMp3Buffer(salt?: string): Buffer {
  const base = Buffer.from([
    0x49,
    0x44,
    0x33,
    0x04,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0xff,
    0xfb,
    0x90,
    0x44,
    ...new Array(28).fill(0x00),
  ]);
  return salt === undefined ? base : Buffer.concat([base, Buffer.from(salt, 'utf8')]);
}
