/**
 * Empty-state placeholder helpers — decide WHEN to swap the rendered
 * component for the placeholder pill, and WHAT label / Icon to display.
 *
 * Both functions are pure and synchronous so JsxComponentView can call them
 * inline during render. No DOM, no editor, no React.
 *
 * The predicate is intentionally STRICTER than `JsxComponentView`'s
 * `needsConfig` — `needsConfig` flags any required string prop with a
 * missing-key decision (e.g. `alt` absent on an `<img>`) and uses the
 * gear-hint chrome nudge, but the placeholder only fires when the component
 * literally cannot render anything useful (the autoFocus-flagged required
 * prop is empty string). Conflating the two would regress images with valid
 * src + unset alt into placeholder mode AND lose the tri-state alt
 * distinction (missing key fires the nudge; `alt=''` is the WCAG decorative
 * opt-in and does NOT fire either signal).
 */
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
