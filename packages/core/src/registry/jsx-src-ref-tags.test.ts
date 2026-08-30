import { describe, expect, test, vi } from 'vitest';
import { builtInComponents } from './built-ins.ts';
import { JSX_SRC_REF_TAGS } from './jsx-src-ref-tags.ts';

describe('JSX_SRC_REF_TAGS registry', () => {
  test('module load fails when a registry tagName has no descriptor', async () => {
    // A real negative for the module-load guard: drop Mirror from the
    // descriptor set and re-import. The guard must throw — proving it can
    // reject a mismatched tagName, not merely ratify the happy path the
    // static import already exercised.
    vi.resetModules();
    vi.doMock('./built-ins.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./built-ins.ts')>();
      return {
        builtInComponents: actual.builtInComponents.filter(
          (component) => component.name !== 'Mirror',
        ),
      };
    });
    try {
      await expect(import('./jsx-src-ref-tags.ts')).rejects.toThrow(
        /no built-in component descriptor named 'Mirror'/,
      );
    } finally {
      vi.doUnmock('./built-ins.ts');
      vi.resetModules();
    }
  });

  test('module load succeeds against the real descriptors', async () => {
    vi.resetModules();
    await expect(import('./jsx-src-ref-tags.ts')).resolves.toBeDefined();
  });

  test('every entry names a built-in component descriptor and one of its props', () => {
    for (const spec of JSX_SRC_REF_TAGS) {
      const descriptor = builtInComponents.find((component) => component.name === spec.tagName);
      expect(descriptor, spec.tagName).toBeDefined();
      expect(
        descriptor?.props.some((prop) => prop.name === spec.attrName),
        `${spec.tagName}.${spec.attrName}`,
      ).toBe(true);
    }
  });
});
