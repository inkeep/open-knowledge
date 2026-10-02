import { t } from '@lingui/core/macro';

export function buildResolveDraft(filePath: string): string {
  return t`Help me understand the conflict in ${filePath}. Explain what I should compare in the OpenKnowledge Conflict view; I will choose and apply the resolution there.`;
}

export function isLegacyResolveDraft(text: string, filePath: string): boolean {
  return text === `Resolve all the merge conflicts in ${filePath}.`;
}
