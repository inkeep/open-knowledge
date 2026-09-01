import { basename } from 'node:path';

const DEFAULT_USERDATA_NAMES = new Set(['OpenKnowledge', 'Open Knowledge', 'Electron']);

const DEV_WRAPPER = /^(?:OpenKnowledge|Open Knowledge) \((.+)\)$/;

export function resolveInstanceLabel(userDataDir: string): string | null {
  const base = basename(userDataDir);
  if (DEFAULT_USERDATA_NAMES.has(base)) return null;
  const wrapped = DEV_WRAPPER.exec(base);
  const label = (wrapped ? wrapped[1] : base).trim();
  return label.length > 0 ? label : null;
}

export function formatInstanceAppName(appName: string, label: string): string {
  return `${appName} (${label})`;
}
