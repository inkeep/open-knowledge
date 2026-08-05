import { describe, expect, test } from 'vitest';
import { createAppLowlight } from './code-block';
import { CODE_BLOCK_LANGUAGES } from './code-block-languages';

describe('createAppLowlight — picker/registry coverage guard', () => {
  test('every picker canonical (except plaintext) is a registered lowlight grammar', () => {
    // The load-bearing invariant this test guards: a language listed in
    // `CODE_BLOCK_LANGUAGES` must resolve inside the shared lowlight
    // instance, or the LowlightPlugin's `registeredLanguages.includes(lang)`
    // gate returns false and the block silently renders as plaintext —
    // no error, no warning, no failing test at any other layer.
    //
    // Adding a new picker entry that lives outside lowlight's `common`
    // set (like gherkin does today) requires an explicit `register()` call
    // inside `createAppLowlight`. Without this iteration the guard would
    // only exist as a code-comment discipline that the compiler cannot
    // enforce.
    //
    // `plaintext` is intentionally excluded: the plugin short-circuits on
    // the picker's explicit "no highlighting" choice before ever consulting
    // lowlight, so its registration status doesn't matter for paint.
    const registered = new Set(createAppLowlight().listLanguages());
    const missing = CODE_BLOCK_LANGUAGES.filter((l) => l.value !== 'plaintext').filter(
      (l) => !registered.has(l.value),
    );
    expect(missing).toEqual([]);
  });

  test('gherkin specifically is registered (the reason `createAppLowlight` exists)', () => {
    // Redundant against the coverage guard above but pins the concrete
    // language whose explicit registration this factory was extracted for.
    // If someone refactors `createAppLowlight` and accidentally drops the
    // gherkin `.register()` call while leaving the coverage guard intact
    // (e.g. by also removing gherkin from the picker), this test still
    // fires — the picker entry can drift, but the factory's contract with
    // gherkin as documented cannot.
    expect(createAppLowlight().listLanguages()).toContain('gherkin');
  });
});
