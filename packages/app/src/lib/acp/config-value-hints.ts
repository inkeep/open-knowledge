/**
 * Display-only hints for adapter config values that ship with no
 * `description` on the wire — today the various "Default" entries whose
 * meaning lives only in each harness's docs, so the menu reads "Effort:
 * Default" and tells the user nothing. Same posture as `permissive-mode.ts`:
 * best-effort, per-adapter, display-only — a miss just loses a hint, and an
 * adapter that starts shipping its own description wins over this table.
 *
 * Keyed on (registry agent id, option id, value id), never on names — ids are
 * the stable surface (claude-acp renamed mode `default`'s display name to
 * "Manual" without changing the wire id).
 */

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

/**
 * Resolve what a selected `default` option actually is from the adapter's own
 * data: claude-acp gives its "Default (recommended)" model entry the exact
 * description of the concrete model it resolves to, so an exact description
 * match against a sibling names the resolution ("Opus (1M context)") with no
 * adapter-version knowledge. Keyed on the wire value id, not the display name;
 * null (no matching sibling, or no description) falls back to the entry name.
 */
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
