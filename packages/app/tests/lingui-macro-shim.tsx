import { i18n } from '@lingui/core';
import type { ReactNode } from 'react';

type MessageDescriptor = {
  id?: string;
  message?: string;
  values?: Record<string, unknown>;
  comment?: string;
};

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
