import { parse as parseToml } from 'smol-toml';
import { isObject } from '../utils/is-object.ts';
import { debugNativeLoadFailure, requireNativeConfigModule } from './load-native-config.ts';

interface NativeMcpEditResult {
  text: string;
  changed: boolean;
  existed: boolean;
}

export interface NativeTomlBinding {
  parseTomlToJson(tomlText: string): string;
  upsertMcpServer(tomlText: string, serverName: string, entryJson: string): NativeMcpEditResult;
  removeMcpServer(tomlText: string, serverName: string): NativeMcpEditResult;
}

export interface TomlUpsertResult {
  text: string;
  existed: boolean;
}

interface TomlConfigEngineBase {
  parseToObject(raw: string): Record<string, unknown>;
}

interface NativeTomlConfigEngine extends TomlConfigEngineBase {
  readonly backend: 'native';
  upsertEntry(raw: string, serverName: string, entry: Record<string, unknown>): TomlUpsertResult;
  removeEntry(raw: string, serverName: string): TomlUpsertResult;
}

interface FallbackTomlConfigEngine extends TomlConfigEngineBase {
  readonly backend: 'fallback';
}

export type TomlConfigEngine = NativeTomlConfigEngine | FallbackTomlConfigEngine;

function requireNativeBinding(): NativeTomlBinding | null {
  const mod = requireNativeConfigModule();
  return mod && typeof (mod as Partial<NativeTomlBinding>).parseTomlToJson === 'function'
    ? (mod as NativeTomlBinding)
    : null;
}

function probeBinding(binding: NativeTomlBinding): boolean {
  try {
    const probe = binding.parseTomlToJson('probe = 1');
    return typeof probe === 'string' && probe.includes('probe');
  } catch (err) {
    debugNativeLoadFailure('addon loaded but probe failed', err);
    return false;
  }
}

function assertTable(parsed: unknown): Record<string, unknown> {
  if (!isObject(parsed)) throw new Error('TOML root is not a table');
  return parsed;
}

function makeNativeEngine(binding: NativeTomlBinding): NativeTomlConfigEngine {
  return {
    backend: 'native',
    parseToObject(raw) {
      return assertTable(JSON.parse(binding.parseTomlToJson(raw)));
    },
    upsertEntry(raw, serverName, entry) {
      const result = binding.upsertMcpServer(raw, serverName, JSON.stringify(entry));
      return { text: result.text, existed: result.existed };
    },
    removeEntry(raw, serverName) {
      const result = binding.removeMcpServer(raw, serverName);
      return { text: result.text, existed: result.existed };
    },
  };
}

function makeFallbackEngine(): FallbackTomlConfigEngine {
  return {
    backend: 'fallback',
    parseToObject(raw) {
      return assertTable(parseToml(raw));
    },
  };
}

export function createTomlConfigEngine(
  loadNative: () => NativeTomlBinding | null = requireNativeBinding,
): TomlConfigEngine {
  const native = loadNative();
  if (native && probeBinding(native)) return makeNativeEngine(native);
  return makeFallbackEngine();
}

let cachedEngine: TomlConfigEngine | null = null;

export function getTomlConfigEngine(): TomlConfigEngine {
  if (cachedEngine === null) cachedEngine = createTomlConfigEngine();
  return cachedEngine;
}

export function getNativeTomlMcpEditor(): NativeTomlConfigEngine | undefined {
  const engine = getTomlConfigEngine();
  return engine.backend === 'native' ? engine : undefined;
}

export function setTomlConfigEngineForTesting(engine: TomlConfigEngine | null): void {
  cachedEngine = engine;
}
