import type { LucideIcon } from 'lucide-react';
import * as lucide from 'lucide-react';

export function resolveLucideIcon(identifier: string | undefined): LucideIcon | undefined {
  if (!identifier) return undefined;
  const parts = identifier.split(':');
  const name = (parts[1] ?? parts[0]).trim();
  if (!name) return undefined;
  const table = lucide as unknown as Record<string, unknown>;
  const candidate = table[name];
  if (typeof candidate === 'function' || (candidate && typeof candidate === 'object')) {
    return candidate as LucideIcon;
  }
  return undefined;
}
