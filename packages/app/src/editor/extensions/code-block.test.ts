import { describe, expect, test } from 'vitest';
import { createAppLowlight } from './code-block';
import { CODE_BLOCK_LANGUAGES } from './code-block-languages';

describe('createAppLowlight — picker/registry coverage guard', () => {
  test('every picker canonical (except plaintext) is a registered lowlight grammar', () => {
    const registered = new Set(createAppLowlight().listLanguages());
    const missing = CODE_BLOCK_LANGUAGES.filter((l) => l.value !== 'plaintext').filter(
      (l) => !registered.has(l.value),
    );
    expect(missing).toEqual([]);
  });

  test('gherkin specifically is registered (the reason `createAppLowlight` exists)', () => {
    expect(createAppLowlight().listLanguages()).toContain('gherkin');
  });
});
