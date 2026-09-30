import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const HTML = readFileSync(join(__dirname, '..', '..', 'index.html'), 'utf8');

describe('index.html inline scripts', () => {
  test('FOUC inline script body remains single-line (no inner newlines — biome HTML formatter constraint)', () => {
    const inlineScripts = HTML.match(/<script>[^<]+<\/script>/g) ?? [];
    for (const tag of inlineScripts) {
      const body = tag.replace(/^<script>/, '').replace(/<\/script>$/, '');
      expect(body).not.toMatch(/\n/);
    }
  });
});
