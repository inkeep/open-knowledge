import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  AGENT_COLORS,
  colorFromSeed,
  computeInitials,
  displayNameFromClientName,
  generateRandomColor,
  generateRandomName,
  getIdentity,
  HUMAN_COLORS,
  iconFromClientName,
} from './identity';

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  get length() {
    return storage.size;
  },
  key: (_index: number) => null,
};

beforeEach(() => {
  storage.clear();
  (globalThis as Record<string, unknown>).localStorage = localStorageStub;
  (globalThis as Record<string, unknown>).window = {
    location: { search: '' },
  };
});

afterEach(() => {
  storage.clear();
});

describe('generateRandomName', () => {
  test('returns a two-word name (adjective + animal)', () => {
    const name = generateRandomName();
    const parts = name.split(' ');
    expect(parts.length).toBe(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });
});

describe('generateRandomColor', () => {
  test('returns a color from the palette', () => {
    const color = generateRandomColor();
    expect((HUMAN_COLORS as readonly string[]).includes(color)).toBe(true);
  });
});

describe('colorFromSeed', () => {
  test('default palette is AGENT_COLORS (backward compat)', () => {
    const color = colorFromSeed('some-agent-id');
    expect((AGENT_COLORS as readonly string[]).includes(color)).toBe(true);
  });

  test('single-arg call returns same value as explicit AGENT_COLORS call', () => {
    const seed = 'claude-1';
    expect(colorFromSeed(seed)).toBe(colorFromSeed(seed, AGENT_COLORS));
  });

  test('HUMAN_COLORS palette returns one of the 7 human pastels', () => {
    const color = colorFromSeed('principal-abc', HUMAN_COLORS);
    expect((HUMAN_COLORS as readonly string[]).includes(color)).toBe(true);
  });

  test('is deterministic for the same seed + palette', () => {
    const seed = 'stable-seed';
    expect(colorFromSeed(seed, HUMAN_COLORS)).toBe(colorFromSeed(seed, HUMAN_COLORS));
    expect(colorFromSeed(seed, AGENT_COLORS)).toBe(colorFromSeed(seed, AGENT_COLORS));
  });

  test('HUMAN_COLORS and AGENT_COLORS produce different values for the same seed', () => {
    const seed = 'test-seed';
    const human = colorFromSeed(seed, HUMAN_COLORS);
    const agent = colorFromSeed(seed, AGENT_COLORS);
    expect((HUMAN_COLORS as readonly string[]).includes(agent)).toBe(false);
    expect((AGENT_COLORS as readonly string[]).includes(human)).toBe(false);
  });
});

describe('computeInitials', () => {
  test('hyphenated Unix username: ada-kt-lovelace → AK', () => {
    expect(computeInitials('ada-kt-lovelace')).toBe('AK');
  });

  test('full name with hyphenated surname: Ada Lovelace-King → AL', () => {
    expect(computeInitials('Ada Lovelace-King')).toBe('AL');
  });

  test('single word: Miles → MI', () => {
    expect(computeInitials('Miles')).toBe('MI');
  });

  test('camelCase: MilesKT → MK', () => {
    expect(computeInitials('MilesKT')).toBe('MK');
  });

  test('empty string returns fallback without throwing', () => {
    const result = computeInitials('');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  test('whitespace-only input returns fallback without throwing', () => {
    const result = computeInitials('   ');
    expect(typeof result).toBe('string');
  });

  test('result is always at most 2 characters', () => {
    for (const name of ['Ada Lovelace-King', 'ada-kt-lovelace', 'MilesKT', 'A B C D E']) {
      expect(computeInitials(name).length).toBeLessThanOrEqual(2);
    }
  });

  test('result is always uppercase', () => {
    expect(computeInitials('ada-kt-lovelace')).toBe(
      computeInitials('ada-kt-lovelace').toUpperCase(),
    );
    expect(computeInitials('john bird')).toBe('JB');
  });

  test('space-separated two-word name: John Bird → JB', () => {
    expect(computeInitials('John Bird')).toBe('JB');
  });
});

describe('iconFromClientName', () => {
  test('maps known clients to brand icons', () => {
    expect(iconFromClientName('claude-code')).toBe('claude');
    expect(iconFromClientName('claude-ai')).toBe('claude');
    expect(iconFromClientName('cursor')).toBe('cursor');
    expect(iconFromClientName('codex-mcp-client')).toBe('openai');
  });
  test('maps Claude Cowork local-agent-mode-* to claude', () => {
    expect(iconFromClientName('local-agent-mode-open-knowledge')).toBe('claude');
    expect(iconFromClientName('local-agent-mode-some-other-server')).toBe('claude');
  });
  test('unknown or absent → bot', () => {
    expect(iconFromClientName('mystery-client')).toBe('bot');
    expect(iconFromClientName(undefined)).toBe('bot');
    expect(iconFromClientName('')).toBe('bot');
    expect(iconFromClientName('local-agent-mode')).toBe('bot');
  });
});

describe('displayNameFromClientName', () => {
  test('known clients → brand name', () => {
    expect(displayNameFromClientName('claude-code')).toBe('Claude');
    expect(displayNameFromClientName('local-agent-mode-open-knowledge')).toBe('Claude');
    expect(displayNameFromClientName('cursor')).toBe('Cursor');
    expect(displayNameFromClientName('codex-mcp-client')).toBe('Codex');
  });
  test('unknown client → raw sanitized name preserved', () => {
    expect(displayNameFromClientName('some-custom-agent')).toBe('some-custom-agent');
  });
  test('absent/empty → Agent', () => {
    expect(displayNameFromClientName(undefined)).toBe('Agent');
    expect(displayNameFromClientName('   ')).toBe('Agent');
  });
});

describe('getIdentity', () => {
  test('returns expected shape', () => {
    const identity = getIdentity();
    expect(identity).toHaveProperty('name');
    expect(identity).toHaveProperty('color');
    expect(identity).toHaveProperty('coeditor');
    expect(identity).toHaveProperty('tabId');
    expect(typeof identity.name).toBe('string');
    expect(typeof identity.color).toBe('string');
    expect(typeof identity.coeditor).toBe('string');
    expect(typeof identity.tabId).toBe('string');
  });

  test('generates UUID tabId', () => {
    const identity = getIdentity();
    expect(identity.tabId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test('tabId is unique per call', () => {
    const a = getIdentity();
    const b = getIdentity();
    expect(a.tabId).not.toBe(b.tabId);
  });

  test('persists name to localStorage (v3 key)', () => {
    const identity = getIdentity();
    expect(localStorage.getItem('ok-user-name-v3')).toBe(identity.name);
  });

  test('persists color to localStorage (v3 key)', () => {
    const identity = getIdentity();
    expect(localStorage.getItem('ok-user-color-v3')).toBe(identity.color);
  });

  test('reads persisted name from localStorage (v3 key)', () => {
    localStorage.setItem('ok-user-name-v3', 'Test User');
    const identity = getIdentity();
    expect(identity.name).toBe('Test User');
  });

  test('reads persisted color from localStorage (v3 key)', () => {
    localStorage.setItem('ok-user-color-v3', '#FF0000');
    const identity = getIdentity();
    expect(identity.color).toBe('#FF0000');
  });

  test('defaults coeditor to standalone', () => {
    const identity = getIdentity();
    expect(identity.coeditor).toBe('standalone');
  });

  test('reads coeditor from query param', () => {
    (globalThis as Record<string, unknown>).window = {
      location: { search: '?coeditor=cursor' },
    };
    const identity = getIdentity();
    expect(identity.coeditor).toBe('cursor');
  });

  test('color is from the curated palette on first generation', () => {
    const identity = getIdentity();
    expect((HUMAN_COLORS as readonly string[]).includes(identity.color)).toBe(true);
  });
});
