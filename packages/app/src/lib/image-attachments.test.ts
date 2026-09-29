import { describe, expect, test } from 'vitest';
import {
  ACCEPTED_IMAGE_TYPES,
  formatFileSize,
  imageAttachmentsProblem,
  isImageAttachmentType,
  MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES,
  totalImageAttachmentBytes,
} from './image-attachments.ts';

function fakeFile(name: string, type: string, size: number): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('isImageAttachmentType', () => {
  test('accepts exactly the three wire types', () => {
    for (const type of ACCEPTED_IMAGE_TYPES) expect(isImageAttachmentType(type)).toBe(true);
    expect(isImageAttachmentType('image/gif')).toBe(false);
    expect(isImageAttachmentType('application/zip')).toBe(false);
  });
});

describe('imageAttachmentsProblem', () => {
  test('an empty or in-bounds list has no problem', () => {
    expect(imageAttachmentsProblem([])).toBeNull();
    expect(imageAttachmentsProblem([fakeFile('a.png', 'image/png', 1024)])).toBeNull();
  });

  test('reports count, type, and total in that precedence', () => {
    const four = Array.from({ length: 4 }, (_, i) => fakeFile(`${i}.png`, 'image/png', 1));
    expect(imageAttachmentsProblem(four)).toBe('count');
    expect(imageAttachmentsProblem([fakeFile('a.gif', 'image/gif', 1)])).toBe('type');
    expect(
      imageAttachmentsProblem([
        fakeFile('a.png', 'image/png', MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES + 1),
      ]),
    ).toBe('total');
  });

  test('the total is the sum across files, not a per-file bound', () => {
    const half = Math.ceil(MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES / 2) + 1;
    const files = [fakeFile('a.png', 'image/png', half), fakeFile('b.png', 'image/png', half)];
    expect(totalImageAttachmentBytes(files)).toBeGreaterThan(MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES);
    expect(imageAttachmentsProblem(files)).toBe('total');
  });
});

describe('formatFileSize', () => {
  test('scales bytes, kilobytes, and megabytes', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2 KB');
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
