import {
  incrementJsxPropDropped,
  isRelativeUrl,
  SAFE_URL_SCHEMES,
} from '@inkeep/open-knowledge-core';

const URL_SCHEME_ALLOWLIST = new Set(SAFE_URL_SCHEMES.map((s) => `${s}:`));

const DROP_WARN_WINDOW_MS = 60_000;
const DROP_WARN_LIMIT_PER_WINDOW = 10;
const dropWarnState = new Map<string, { windowStart: number; count: number }>();

function emitPropDroppedEvent(reason: string, key: string): void {
  const lower = key.toLowerCase();
  incrementJsxPropDropped(lower);
  const now = Date.now();
  const state = dropWarnState.get(lower);
  if (!state || now - state.windowStart >= DROP_WARN_WINDOW_MS) {
    dropWarnState.set(lower, { windowStart: now, count: 1 });
  } else {
    state.count += 1;
    if (state.count > DROP_WARN_LIMIT_PER_WINDOW) return;
  }
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(
      JSON.stringify({
        event: 'jsx-prop-dropped',
        reason,
        prop: key,
      }),
    );
  }
}

export const URL_PROP_NAMES = new Set([
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'cite',
  'data',
  'manifest',
  'background',
  'ping',
  'xlinkhref',
  'xlinkactuate',
  'xlinkrole',
  'xlinkarcrole',
  'xlinkshow',
  'url',
  'link',
]);

const DANGEROUS_PROP_NAMES = new Set([
  'dangerouslysetinnerhtml',
  'ref',
  'key',
  'defaultvalue',
  'defaultchecked',
  '__proto__',
  'constructor',
  'prototype',
]);

const MAX_STYLE_SCAN_LEN = 10_000;

export function isDangerousPropName(rawName: string): boolean {
  const name = rawName.toLowerCase();
  if (DANGEROUS_PROP_NAMES.has(name)) return true;
  if (name.length >= 3 && name.startsWith('on')) return true;
  return false;
}

export function isUrlPropName(rawName: string): boolean {
  return URL_PROP_NAMES.has(rawName.toLowerCase());
}

export function sanitizeUrlValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const value = raw.trim();
  if (!value) return raw;

  if (value.startsWith('#')) return raw;

  if (value.startsWith('//')) return raw;

  if (isRelativeUrl(value)) return raw;

  const colonIdx = value.indexOf(':');
  const scheme = value.slice(0, colonIdx + 1).toLowerCase();
  if (URL_SCHEME_ALLOWLIST.has(scheme)) return raw;
  return '#';
}

function sanitizeStyleString(value: string): string {
  if (value.length > MAX_STYLE_SCAN_LEN) return '';
  const lower = value.toLowerCase();
  if (/url\s*\(\s*['"]?\s*(?:javascript|vbscript|data)\s*:/.test(lower)) return '';
  if (/\bexpression\s*\(/.test(lower)) return '';
  return value;
}

function sanitizeNested(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const sanitized = sanitizeNested(value[i]);
      next[i] = sanitized;
      if (sanitized !== value[i]) changed = true;
    }
    return changed ? next : value;
  }
  if (typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const obj = value as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isDangerousPropName(k)) {
      emitPropDroppedEvent('dangerous-prop-name-nested', k);
      changed = true;
      continue;
    }
    if (isUrlPropName(k) && typeof v === 'string') {
      const safe = sanitizeUrlValue(v);
      if (safe !== v) changed = true;
      out[k] = safe;
    } else {
      const safe = sanitizeNested(v);
      if (safe !== v) changed = true;
      out[k] = safe;
    }
  }
  return changed ? out : value;
}

export function sanitizeComponentProps(props: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (isDangerousPropName(key)) {
      emitPropDroppedEvent('dangerous-prop-name', key);
      changed = true;
      continue;
    }
    if (isUrlPropName(key)) {
      const safe = sanitizeUrlValue(value);
      if (safe !== value) changed = true;
      result[key] = safe;
      continue;
    }
    if (key === 'style') {
      if (typeof value === 'string') {
        const safe = sanitizeStyleString(value);
        if (safe !== value) changed = true;
        result[key] = safe;
      } else {
        changed = true;
      }
      continue;
    }
    const safe = sanitizeNested(value);
    if (safe !== value) changed = true;
    result[key] = safe;
  }
  return changed ? result : props;
}
