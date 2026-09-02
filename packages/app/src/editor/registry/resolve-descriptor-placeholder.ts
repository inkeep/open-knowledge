import type { LucideIcon } from 'lucide-react';
import { getAutoFocusedPropName } from '../utils/editor-strings.ts';
import { resolveIcon } from './icons.ts';
import type { JsxComponentDescriptor } from './types.ts';

export function shouldRenderPlaceholder(
  descriptor: JsxComponentDescriptor,
  props: Record<string, unknown>,
): boolean {
  if (descriptor.hasChildren) return false;
  const autoFocusName = getAutoFocusedPropName(descriptor.props);
  if (autoFocusName === null) return false;
  return props[autoFocusName] === '';
}

export function resolveDescriptorPlaceholder(descriptor: JsxComponentDescriptor): {
  label: string;
  Icon: LucideIcon;
} {
  const overrideLabel = descriptor.placeholder?.label;
  const fallbackLabel = `Add ${(descriptor.displayName ?? descriptor.name).toLowerCase()}`;
  const label = overrideLabel ?? fallbackLabel;

  const iconName = descriptor.placeholder?.icon ?? descriptor.icon;
  const Icon = resolveIcon(iconName);

  return { label, Icon };
}
