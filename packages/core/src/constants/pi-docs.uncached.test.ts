import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { piToolNamespace } from './editors.ts';
import { DESKTOP_PRODUCTS, PACKAGED_DESKTOP_PRODUCT_NAMES } from './product.ts';

const PI_PAGE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/content/integrations/pi.mdx'),
  'utf8',
);

function verifySection(): string {
  const start = PI_PAGE.indexOf('\n## Verify\n');
  if (start === -1) throw new Error('pi.mdx has no "## Verify" section');
  const end = PI_PAGE.indexOf('\n## ', start + 1);
  return PI_PAGE.slice(start, end === -1 ? undefined : end);
}

describe('Pi integration page', () => {
  test.each(PACKAGED_DESKTOP_PRODUCT_NAMES.map((name) => DESKTOP_PRODUCTS[name]))(
    'Verify names the $productName tool and prefix',
    (product) => {
      const namespace = piToolNamespace(product);
      const verify = verifySection();
      expect(verify).toContain(`\`${namespace}_exec\``);
      expect(verify).toContain(`\`${namespace}_\``);
    },
  );
});
