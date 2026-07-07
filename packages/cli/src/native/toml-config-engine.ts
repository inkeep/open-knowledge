/**
 * Resolves the engine used to read (and, later, format-preservingly write)
 * Codex TOML harness configs: the native `toml_edit` addon when its `.node`
 * loads, or a pure-JS `smol-toml` fallback otherwise.
 *
 * The native parser is strictly more capable than `smol-toml`: it accepts
 * 64-bit integers past the JS safe-integer boundary and microsecond/offset
 * datetimes that `smol-toml` throws on. That throw is the root enabler of the
 * reported config reset — a valid config mis-classified as corrupt. Reading
 * through this engine so a capable parser decides the classification is the
 * primary fix; the fallback keeps the CLI working on a platform with no
 * prebuilt binary, where it declines (never destroys) a present config it
 * cannot safely edit.
 *
 * The load-probe + graceful-fallback shape mirrors `createTokenStore`
 * (`../auth/token-store.ts`): dynamically resolve the addon, prove it actually
 * runs, and degrade to the JS path rather than crash the classify path on a
 * binding that loads but can't execute. A present-but-broken binary (one that
 * fails to load, or loads but fails the probe) is surfaced under
 * `OK_DEBUG_NATIVE` so it's distinguishable from the silent no-binary case.
 */
import { parse as parseToml } from 'smol-toml';
import { isObject } from '../utils/is-object.ts';
import { debugNativeLoadFailure, requireNativeConfigModule } from './load-native-config.ts';

/** Result of the native insert-only upsert (mirrors the addon's `McpEditResult`). */
interface NativeMcpEditResult {
  /** The serialized document — toml_edit's LF-normalized, BOM-stripped form. */
  text: string;
  /** Whether the edit changed the document (a no-op match reports `false`). */
  changed: boolean;
  /** Whether OK's entry already existed before the edit. */
  existed: boolean;
}

/** The functions the native addon exposes to the read + write/classify path. */
export interface NativeTomlBinding {
  /**
   * Parse TOML text and return its data as a JSON string. Throws only on
   * genuinely-unparseable input; accepts large integers and microsecond
   * datetimes.
   */
  parseTomlToJson(tomlText: string): string;
  /**
   * Insert or update only `[mcp_servers.<serverName>]` from a JSON object of the
   * entry's managed keys, preserving every other document token. Throws only on
   * unparseable TOML or a non-object entry payload.
   */
  upsertMcpServer(tomlText: string, serverName: string, entryJson: string): NativeMcpEditResult;
  /**
   * Remove only `[mcp_servers.<serverName>]`, leaving the surrounding
   * `[mcp_servers]` table and every sibling intact. Removing an absent entry is
   * a byte-identical no-op (`changed: false`, `existed: false`). Throws only on
   * unparseable TOML. Backs the `ok uninstall` / `ok deinit` surgical removal
   * (the sibling of `upsertMcpServer`).
   */
  removeMcpServer(tomlText: string, serverName: string): NativeMcpEditResult;
}

/**
 * Outcome of a format-preserving edit (upsert OR remove): the serialized
 * document in toml_edit's normalized form (LF line endings, no BOM) — the write
 * wrapper re-applies the source file's byte-level encoding — and whether OK's
 * entry already existed (so the caller labels the write register-vs-update, or
 * reports removed vs not-present, without re-parsing).
 */
export interface TomlUpsertResult {
  text: string;
  existed: boolean;
}

interface TomlConfigEngineBase {
  /**
   * Parse TOML text to a plain object, throwing on genuinely-unparseable input
   * or a non-table root. The native engine accepts values the fallback rejects.
   */
  parseToObject(raw: string): Record<string, unknown>;
}

/**
 * The native engine: a format-preserving document model. Only this backend can
 * upsert OK's entry without re-serializing (and reflowing) the whole file, so
 * `upsertEntry` lives on the `native` arm of the union — the `backend`
 * discriminant forces callers to handle the fallback's absence of it.
 */
interface NativeTomlConfigEngine extends TomlConfigEngineBase {
  readonly backend: 'native';
  /**
   * Format-preserving insert-only upsert of OK's own `[mcp_servers.<serverName>]`
   * entry. Throws on unparseable TOML.
   */
  upsertEntry(raw: string, serverName: string, entry: Record<string, unknown>): TomlUpsertResult;
  /**
   * Format-preserving removal of OK's own `[mcp_servers.<serverName>]` entry,
   * preserving the surrounding table and every sibling. Throws on unparseable
   * TOML. Only the native backend can remove without reflowing the whole file,
   * so — like `upsertEntry` — this lives on the `native` arm of the union.
   * `existed` reports whether OK's entry was present before the remove.
   */
  removeEntry(raw: string, serverName: string): TomlUpsertResult;
}

/** The pure-JS fallback: capable of parsing only, never a format-preserving write. */
interface FallbackTomlConfigEngine extends TomlConfigEngineBase {
  readonly backend: 'fallback';
}

/**
 * The resolved TOML engine. `backend` is the capability discriminant: only the
 * `native` arm carries `upsertEntry`, so callers must narrow on it before a
 * format-preserving write (the fallback can only parse).
 */
export type TomlConfigEngine = NativeTomlConfigEngine | FallbackTomlConfigEngine;

/**
 * Resolve the native addon, returning `null` (rather than throwing) when no
 * binary can be loaded for this platform. Delegates the dist-relative vs
 * workspace-package lookup to the shared loader and narrows to the parse/upsert
 * binding shape.
 */
function requireNativeBinding(): NativeTomlBinding | null {
  const mod = requireNativeConfigModule();
  return mod && typeof (mod as Partial<NativeTomlBinding>).parseTomlToJson === 'function'
    ? (mod as NativeTomlBinding)
    : null;
}

/**
 * Prove the binding actually runs before trusting it, so an addon that loads
 * but can't execute (an ABI mismatch) degrades to the fallback instead of
 * crashing the classify path on first real use.
 */
function probeBinding(binding: NativeTomlBinding): boolean {
  try {
    const probe = binding.parseTomlToJson('probe = 1');
    return typeof probe === 'string' && probe.includes('probe');
  } catch (err) {
    // Loaded but can't execute (an ABI mismatch): surface under OK_DEBUG_NATIVE
    // so the broken-binary case is debuggable, then fall back to the JS path.
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

/**
 * Build an engine, probing the native addon resolved by `loadNative`. The
 * loader is a parameter so tests can force either backend deterministically
 * without depending on whether a `.node` happens to be present.
 */
export function createTomlConfigEngine(
  loadNative: () => NativeTomlBinding | null = requireNativeBinding,
): TomlConfigEngine {
  const native = loadNative();
  if (native && probeBinding(native)) return makeNativeEngine(native);
  return makeFallbackEngine();
}

let cachedEngine: TomlConfigEngine | null = null;

/**
 * The process-wide engine, resolved once on first use. Probing the addon on
 * every classify would re-pay the dynamic-require cost for no benefit — the
 * binding's availability does not change within a process.
 */
export function getTomlConfigEngine(): TomlConfigEngine {
  if (cachedEngine === null) cachedEngine = createTomlConfigEngine();
  return cachedEngine;
}

/**
 * Test-only: override the cached engine (pass `null` to reset to lazy default).
 * Lets a test exercise the fallback decline path or the native path
 * deterministically regardless of whether the addon is built on the host.
 */
export function setTomlConfigEngineForTesting(engine: TomlConfigEngine | null): void {
  cachedEngine = engine;
}
