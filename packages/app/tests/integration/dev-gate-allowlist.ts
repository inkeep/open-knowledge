/**
 * Allowlist of source files permitted to assign to `window.__*` because
 * each assignment is itself DEV-gated by `if (import.meta.env.DEV) { ... }`
 * (or an early-return equivalent at the top of the containing scope).
 *
 * Used by `e2e-stop-rules.test.ts` to enforce the invariant:
 * any new `window.__*` write in `packages/app/src/**` MUST be DEV-gated so
 * Vite tree-shakes it from production bundles.
 *
 * To extend: add the file path here AND ensure the new write site sits
 * inside an `if (import.meta.env.DEV)` block (or a function whose first
 * statement is `if (!import.meta.env.DEV) return;`). The STOP rule does
 * NOT check the gate semantics — the allowlist is the human attestation
 * that "I have manually verified the DEV-gate is correct."
 */
export const DEV_GATED_WINDOW_WRITERS: ReadonlyArray<string> = [
  'packages/app/src/components/GraphView.tsx',
  'packages/app/src/components/SystemDocSubscriber.tsx',
  'packages/app/src/editor/DocumentContext.tsx',
  'packages/app/src/editor/TiptapEditor.tsx',
];
