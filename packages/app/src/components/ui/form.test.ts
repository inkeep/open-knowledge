/**
 * Smoke test for the shadcn Form primitive — verifies the named exports
 * exist and are functions. Behavioral coverage for the harness lives in
 * `settings/use-config-form.test.ts` and `settings/SettingsDialog.test.ts`.
 */

import { describe, expect, test } from 'bun:test';

describe('ui/form module', () => {
  test('exports the shadcn Form primitives as functions', async () => {
    const mod = await import('./form');
    expect(typeof mod.Form).toBe('function');
    expect(typeof mod.FormField).toBe('function');
    expect(typeof mod.FormItem).toBe('function');
    expect(typeof mod.FormLabel).toBe('function');
    expect(typeof mod.FormControl).toBe('function');
    expect(typeof mod.FormDescription).toBe('function');
    expect(typeof mod.FormMessage).toBe('function');
    expect(typeof mod.useFormField).toBe('function');
  });
});
