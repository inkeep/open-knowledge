/**
 * Test-only runtime stand-in for the Lingui macros (`@lingui/react/macro` +
 * `@lingui/core/macro`).
 *
 * `bun test` does not run the Lingui Babel macro transform, so importing the
 * real `@lingui/{react,core}/macro` modules throws ("Cannot find package
 * 'babel-plugin-macros'"). `tests/lingui-macro-preload.ts` aliases the macro
 * specifiers to this shim.
 *
 * The shim is English-passthrough: it renders the source-locale text directly.
 * That is exactly what the real macro-transformed code renders once the `en`
 * catalog is active, so component behaviour tests — which assert source-locale
 * strings — stay valid. The shim deliberately does NOT exercise catalog lookup
 * or message-ID generation; those are build-time concerns covered by
 * `lingui extract` + the production build.
 */
import { i18n } from '@lingui/core';
import type { ReactNode } from 'react';

/**
 * A Lingui message descriptor — the object call shape, e.g.
 * `t({ message: 'Back', comment: 'nav' })`. The real macro accepts both this
 * and the tagged-template form, so the shim must accept both as well.
 */
type MessageDescriptor = {
  id?: string;
  message?: string;
  values?: Record<string, unknown>;
  comment?: string;
};

// A plain `string` is in the set because the shim's own `msg` returns a
// string (English passthrough), and the real macro `t` accepts a `msg`
// result — so `t(msg\`…\`)` reaches the shim as `t(string)` and must pass
// the string straight through rather than treat it as a descriptor.
type MacroArg = TemplateStringsArray | MessageDescriptor | string;

function isTemplateStrings(arg: MacroArg): arg is TemplateStringsArray {
  return Array.isArray(arg) && 'raw' in arg;
}

function interpolate(strings: TemplateStringsArray, values: readonly unknown[]): string {
  return strings.reduce(
    (acc, segment, index) => acc + segment + (index < values.length ? String(values[index]) : ''),
    '',
  );
}

function fromDescriptor(descriptor: MessageDescriptor): string {
  let out = descriptor.message ?? descriptor.id ?? '';
  if (descriptor.values) {
    for (const [key, value] of Object.entries(descriptor.values)) {
      out = out.split(`{${key}}`).join(String(value));
    }
  }
  return out;
}

function resolveMessage(arg: MacroArg, values: readonly unknown[]): string {
  if (typeof arg === 'string') return arg;
  return isTemplateStrings(arg) ? interpolate(arg, values) : fromDescriptor(arg);
}

/* ---------- @lingui/core/macro ---------- */

// Each accepts BOTH call shapes the real macro supports: the tagged-template
// form (`` t`Back` ``) and the descriptor-object form (`t({ message: 'Back',
// comment: 'nav' })`).

export function t(arg: MacroArg, ...values: unknown[]): string {
  return resolveMessage(arg, values);
}

export function msg(arg: MacroArg, ...values: unknown[]): string {
  return resolveMessage(arg, values);
}

export function defineMessage(arg: MacroArg, ...values: unknown[]): string {
  return resolveMessage(arg, values);
}

export function plural(value: number, options: Record<string, string>): string {
  const branch = options[value === 1 ? 'one' : 'other'] ?? options.other ?? '';
  return branch.replace(/#/g, String(value));
}

export function select(value: string, options: Record<string, string>): string {
  return options[value] ?? options.other ?? '';
}

export const selectOrdinal = select;

/* ---------- @lingui/react/macro ---------- */

// Renders the macro's children form (`<Trans>Hello {name}</Trans>` — children
// already carry the interpolated nodes). Also tolerates the descriptor-prop
// form (`message` + `values`, no children) and ignores translator-only props
// (`id`, `comment`, `components`).
export function Trans({
  children,
  message,
  values,
}: {
  children?: ReactNode;
  message?: string;
  values?: Record<string, unknown>;
  id?: string;
  comment?: string;
  components?: Record<string, ReactNode>;
}) {
  if (children !== undefined) return <>{children}</>;
  if (message) return <>{fromDescriptor({ message, values })}</>;
  return null;
}

export function Plural({
  value,
  one,
  other,
}: {
  value: number;
  one?: ReactNode;
  other?: ReactNode;
}) {
  const branch = value === 1 ? (one ?? other) : other;
  return <>{typeof branch === 'string' ? branch.replace(/#/g, String(value)) : branch}</>;
}

export function Select({
  value,
  other,
  ...cases
}: { value: string; other?: ReactNode } & Record<string, ReactNode>) {
  return <>{cases[`_${value}`] ?? cases[value] ?? other}</>;
}

export const SelectOrdinal = Select;

// `_` is the low-level runtime translate fn from `useLingui()` — it takes a
// message id/descriptor (often a `msg` result) and optional values. Route
// objects through `fromDescriptor` so a descriptor never stringifies to
// `[object Object]`.
function underscore(
  descriptor: string | MessageDescriptor,
  values?: Record<string, unknown>,
): string {
  if (typeof descriptor === 'string') return descriptor;
  return fromDescriptor(values ? { ...descriptor, values } : descriptor);
}

export function useLingui() {
  return { t, i18n, _: underscore };
}
