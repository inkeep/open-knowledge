import { cssColorToHex } from './css-color-to-hex';

export type TokenColorReader = (token: string) => string | null;

function normalizeProbedColor(resolved: string | undefined): string | null {
  if (!resolved || resolved === 'rgba(0, 0, 0, 0)' || resolved === 'transparent') return null;
  if (resolved.includes('var(')) return null;
  return cssColorToHex(resolved, { alpha: true });
}

export function readTokenColors(tokens: readonly string[]): Map<string, string | null> {
  const resolved = new Map<string, string | null>();
  if (typeof document === 'undefined' || !document.body) return resolved;

  const fragment = document.createDocumentFragment();
  const probes = tokens.map((token) => {
    const probe = document.createElement('span');
    probe.style.display = 'none';
    probe.style.backgroundColor = `var(${token})`;
    fragment.appendChild(probe);
    return { token, probe };
  });
  document.body.appendChild(fragment);
  try {
    for (const { token, probe } of probes) {
      resolved.set(token, normalizeProbedColor(getComputedStyle(probe).backgroundColor));
    }
  } finally {
    for (const { probe } of probes) probe.remove();
  }
  return resolved;
}
