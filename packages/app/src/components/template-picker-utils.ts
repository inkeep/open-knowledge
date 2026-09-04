import type { TemplateMenuEntry } from '@/hooks/use-folder-config';

const SCOPE_ORDER: Record<TemplateMenuEntry['scope'], number> = {
  local: 0,
  inherited: 1,
};

export function sortTemplatesForPicker(
  templates: readonly TemplateMenuEntry[],
): TemplateMenuEntry[] {
  return [...templates].sort((a, b) => {
    const scopeDelta = SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope];
    if (scopeDelta !== 0) return scopeDelta;
    const aLabel = (a.title ?? a.name).toLowerCase();
    const bLabel = (b.title ?? b.name).toLowerCase();
    return aLabel.localeCompare(bLabel);
  });
}
