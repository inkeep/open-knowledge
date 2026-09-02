import type { SessionConfigOption } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { t } from '@lingui/core/macro';

type SelectConfigOption = Extract<SessionConfigOption, { type: 'select' }>;

interface SelectEntry {
  value: string;
  name: string;
  description?: string | null;
}

function flattenEntries(option: SelectConfigOption): SelectEntry[] {
  const flat: SelectEntry[] = [];
  for (const entry of option.options) {
    if ('value' in entry) flat.push(entry);
    else flat.push(...entry.options);
  }
  return flat;
}

export function resolveDefaultOptionLabel(option: SelectConfigOption): string | null {
  const entries = flattenEntries(option);
  const current = entries.find((entry) => entry.value === option.currentValue);
  if (current === undefined || current.value !== 'default' || !current.description) return null;
  const sibling = entries.find(
    (entry) => entry.value !== current.value && entry.description === current.description,
  );
  if (sibling === undefined) return null;
  return t`${sibling.name} · default`;
}

export function configValueHint(agentId: string, optionId: string, valueId: string): string | null {
  if (agentId === 'claude-acp' && optionId === 'effort' && valueId === 'default') {
    return t`Model's default effort`;
  }
  if (agentId === 'codex-acp' && optionId === 'collaboration_mode' && valueId === 'default') {
    return t`Work directly, no plan step`;
  }
  return null;
}
