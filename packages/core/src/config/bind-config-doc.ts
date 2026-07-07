/**
 * UI-side ConfigBinding.
 *
 * Browser-and-Node-compatible wrapper around a Hocuspocus-bound `Y.Doc` that
 * exposes a typed read/patch/subscribe API over the config doc's `Y.Text`.
 *
 * Three-layer defense-in-depth: this is L1 (client-side walker). Per-field
 * commits go through `patch()`; invalid patches return a typed `Result.err`
 * and never mutate `Y.Text`. L2 (`writeConfigPatch`, headless) and L3
 * (persistence-hook revert) are the safety nets for non-binding writers.
 *
 * Provider lifecycle: the caller owns the `HocuspocusProvider`. Each config
 * doc gets its OWN provider — pool reuse would require gating
 * `setupObservers` to keep the markdown bridge from running on Y.Text-only
 * docs (the bridge is already gated server-side; client-side a pooled
 * provider would also engage TipTap binding which we explicitly don't want).
 *
 * No client-side persistence: `bindConfigDoc` does NOT call
 * `createClientPersistence` / `IndexeddbPersistence`. Stale IDB cache would
 * race with fresh server LKG on reconnect. Cold-mount cost (~100-300ms) is
 * well under the 200ms first-open target's tolerance.
 */

import { isMap, type ParsedNode, parseDocument } from 'yaml';
import type * as Y from 'yjs';
import type { ConfigValidationError, WriteScope } from './errors.ts';
import type { Err, Ok, Result } from './result.ts';
import { type Config, type ConfigPatch, ConfigSchema } from './schema.ts';
import { addConfigSpanEvent, withConfigSpanSync } from './telemetry.ts';
import { validatePatchScopes } from './validate-patch-scopes.ts';
import { applyPatchToDocument, toConfigIssue } from './yaml-patch.ts';

/**
 * Structural type satisfied by `HocuspocusProvider` — keeps `@inkeep/open-
 * knowledge-core` free of a runtime `@hocuspocus/provider` dep. The concrete
 * `HocuspocusProvider` from `@hocuspocus/provider` satisfies this shape.
 *
 * Tests can pass a minimal mock with just `document` + a small event emitter.
 */
export interface ConfigDocProvider {
  /** The Y.Doc bound to this provider. */
  document: Y.Doc;
  /**
   * Subscribe to provider events. We only use `'synced'` for the
   * reconnect-fires-listener semantic — see `subscribe()` below.
   */
  on(event: 'synced', listener: () => void): void;
  off(event: 'synced', listener: () => void): void;
}

/** Successful patch outcome — same shape as `WriteConfigPatchSuccess` minus fs fields. */
export interface ConfigBindingPatchSuccess {
  /** The full merged Config after applying the patch + Zod defaults. */
  effective: Config;
  /** Dotted paths of leaves the patch touched. */
  appliedPaths: string[];
}

export type ConfigBindingPatchResult = Result<ConfigBindingPatchSuccess, ConfigValidationError>;

/** Returned from `subscribe()` — call to stop receiving updates. */
export type Unsubscribe = () => void;

/**
 * Typed read/patch/subscribe API over a config Y.Doc. Constructed via
 * `bindConfigDoc(provider, scope)`; consumer is responsible for the
 * provider's lifecycle.
 */
export interface ConfigBinding {
  /**
   * Parse the current Y.Text content as YAML and return the merged
   * `Config`. On parse or schema failure, falls back to schema defaults
   * — the binding never throws from `current()`. Use `patch()` for
   * write-time validation feedback.
   */
  current(): Config;
  /**
   * Apply a deep-partial patch via yaml@2 Document round-trip. Validates
   * the merged document against `ConfigSchema` BEFORE mutating Y.Text.
   * Returns `Result.err` with no Y.Text mutation on validation failure;
   * returns `Result.ok` with the merged effective config + applied paths
   * on success.
   *
   * The Y.Text mutation runs inside `doc.transact(...)`. The transaction
   * has no marked origin — it propagates through Hocuspocus normally and
   * triggers the persistence-hook (L3) for end-to-end disk write.
   */
  patch(patch: ConfigPatch): ConfigBindingPatchResult;
  /**
   * Listen for changes to the bound config. Fires on every Y.Text change
   * (local + remote) AND on every provider `'synced'` event. The latter
   * guarantees reconnect-fresh-value semantics even when the post-sync
   * state is byte-identical to the pre-sync state. Returns an
   * `Unsubscribe` function; calling it removes the listener.
   *
   * The listener does NOT fire synchronously on subscribe — call
   * `current()` for the initial value, then react to subsequent updates.
   */
  subscribe(listener: (config: Config) => void): Unsubscribe;
  /**
   * Whether the binding has observed at least one provider `'synced'`
   * event. Latches false → true on the first emit and never reverts. Used
   * by gates that need to distinguish "Y.Text empty because the file is
   * empty" from "Y.Text empty because we haven't synced yet" — calling
   * `current()` alone returns schema defaults in both cases.
   */
  hasSynced(): boolean;
  /**
   * Subscribe to the false → true transition of `hasSynced()`. Fires
   * exactly once: on the first `'synced'` event after subscribe, OR
   * synchronously on the next microtask if the binding has already
   * synced. Returns an `Unsubscribe` that is a no-op after the listener
   * has fired.
   */
  subscribeSynced(listener: () => void): Unsubscribe;
  /**
   * Detach the binding's Y.Text observer + provider listener. The caller
   * still owns the provider — destroying the provider also tears down the
   * underlying Y.Doc, which would invalidate this binding even if
   * `dispose()` was never called.
   */
  dispose(): void;
}

interface BindConfigDocOptions {
  /**
   * Override the Y.Text key. Defaults to `'source'` (the convention used by
   * `loadConfigDoc` / `storeConfigDoc` / `applyExternalConfigChange` in
   * server/config-persistence.ts). Tests may pass `'test'` or similar.
   */
  ytextKey?: string;
}

const DEFAULT_YTEXT_KEY = 'source';

function err(error: ConfigValidationError): Err<ConfigValidationError> {
  return { ok: false, error };
}

function ok(value: ConfigBindingPatchSuccess): Ok<ConfigBindingPatchSuccess> {
  return { ok: true, ...value };
}

/**
 * Schema defaults. Returns a fresh-parsed `Config` per call so consumers can
 * mutate the result without poisoning future fallbacks. `ConfigSchema.parse({})`
 * is fast enough that caching the object is not worth the aliasing footgun.
 */
function schemaDefaults(): Config {
  return ConfigSchema.parse({});
}

function readCurrent(ytext: Y.Text, scope: WriteScope): Config {
  const content = ytext.toString();
  if (content.length === 0) return schemaDefaults();

  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    // Fallback to defaults (no-throw contract) but emit a diagnostic so
    // operators can trace "why are my settings showing defaults?". The
    // patch path's self-heal will overwrite the corrupt content on the
    // next mutation; until then `current()` callers see defaults.
    console.warn(
      `[bindConfigDoc:${scope}] Y.Text contains invalid YAML; returning schema defaults. Errors: ${doc.errors
        .map((e) => e.message)
        .join('; ')}`,
    );
    return schemaDefaults();
  }

  const merged = doc.toJSON() ?? {};
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    console.warn(
      `[bindConfigDoc:${scope}] Y.Text content fails schema validation; returning schema defaults. First issue: ${
        result.error.issues[0]?.message ?? '(unknown)'
      }`,
    );
    return schemaDefaults();
  }
  return result.data;
}

/**
 * Bind a Hocuspocus-attached Y.Doc as a typed config source. The caller is
 * responsible for creating + destroying the provider; the binding does NOT
 * instantiate any client-side persistence layer.
 *
 * The `scope` parameter is informational — it does NOT enforce scope-as-
 * constraint (the Settings pane filters fields per `getFieldMeta(field).scope`).
 * Callers should ensure `provider` is connected to a config doc matching
 * `scope` (`__config__/project` for `'project'`, `__user__/config.yml`
 * for `'user'`, `__local__/project` for `'project-local'`).
 */
export function bindConfigDoc(
  provider: ConfigDocProvider,
  scope: WriteScope,
  options: BindConfigDocOptions = {},
): ConfigBinding {
  return withConfigSpanSync(
    'config.bind',
    { 'config.scope': scope, 'config.transport': 'ytext' },
    () => bindConfigDocInner(provider, scope, options),
  );
}

function bindConfigDocInner(
  provider: ConfigDocProvider,
  scope: WriteScope,
  options: BindConfigDocOptions,
): ConfigBinding {
  const { ytextKey = DEFAULT_YTEXT_KEY } = options;
  const ydoc = provider.document;
  const ytext = ydoc.getText(ytextKey);

  const listeners = new Set<(config: Config) => void>();
  const syncedListeners = new Set<() => void>();
  let disposed = false;
  let synced = false;

  function fireListeners(): void {
    if (disposed) return;
    const config = readCurrent(ytext, scope);
    for (const listener of listeners) {
      try {
        listener(config);
      } catch (e) {
        console.warn(`[bindConfigDoc:${scope}] listener threw:`, e);
      }
    }
  }

  function onSynced(): void {
    if (disposed) return;
    fireListeners();
    if (synced) return;
    synced = true;
    // Latch listeners fire once on the false → true transition, then are
    // discarded — late `subscribeSynced` callers fire synchronously on the
    // next microtask via the `synced` short-circuit below.
    const toFire = [...syncedListeners];
    syncedListeners.clear();
    for (const listener of toFire) {
      try {
        listener();
      } catch (e) {
        console.warn(`[bindConfigDoc:${scope}] synced listener threw:`, e);
      }
    }
  }

  // Y.Text observer fires on every change (local + remote post-sync deltas).
  ytext.observe(fireListeners);
  // Provider 'synced' fires after every successful sync. When the post-sync
  // state is identical to the pre-sync state, the Y.Text observer doesn't
  // fire — but subscribers expect at least one notification on reconnect with
  // the fresh value. Wiring 'synced' to `onSynced` covers both cases AND
  // latches the `synced` flag for `hasSynced` / `subscribeSynced`. The
  // double-fire on a reconnect that produces a delta is idempotent in React
  // (state-equality bailout).
  provider.on('synced', onSynced);

  function patchInner(patch: ConfigPatch): ConfigBindingPatchResult {
    if (disposed) {
      return err({
        code: 'WRITE_ERROR',
        detail: `ConfigBinding (${scope}) has been disposed`,
      });
    }

    // Scope-violation gate: a `'project-local'` binding must reject patches
    // for fields registered as `scope: 'project'` (and inverse). Catches
    // misrouted clicks (e.g., a future surface that sends a project-scoped
    // field through the project-local binding) before any Y.Text mutation.
    const scopeViolation = validatePatchScopes(patch, scope);
    if (scopeViolation !== null) {
      return err(scopeViolation);
    }

    const currentContent = ytext.toString();
    let doc = parseDocument(currentContent);

    // Self-heal: if the existing Y.Text is unparseable (duplicate keys, tab
    // indentation, etc.) or has a non-mapping top-level, drop it and apply
    // the patch onto a fresh empty document. The corrupt content was already
    // dead weight — every subsequent patch would fail YAML_PARSE until
    // someone cleared it manually. Surface via telemetry so we still notice;
    // user-visible behavior becomes "next click recovers" instead of a
    // permanent lockout.
    //
    // Mirrors L3's revert-to-LKG semantics, but L3 only fires after a
    // successful Y.Text write — without this branch a corrupt seed leaves
    // patchInner permanently failing.
    const topLevelNonMap = doc.contents !== null && !isMap(doc.contents);
    if (doc.errors.length > 0 || topLevelNonMap) {
      addConfigSpanEvent('config.corrupt-ytext-reset', {
        'config.scope': scope,
        'config.parse.errorCount': doc.errors.length,
        'config.parse.topLevelNonMap': topLevelNonMap,
      });
      // Mirror the OTel event with a console.warn so headless operators
      // (no telemetry collector) still see the recovery happen.
      const summary =
        doc.errors.length > 0
          ? doc.errors.map((e) => e.message).join('; ')
          : 'top-level YAML is not a mapping';
      console.warn(
        `[bindConfigDoc:${scope}] dropping corrupt Y.Text and re-applying patch onto empty doc. Reason: ${summary}`,
      );
      doc = parseDocument('');
    }
    if (doc.contents === null) {
      doc.contents = doc.createNode({}) as ParsedNode;
    }

    const appliedPaths = applyPatchToDocument(doc, patch);
    const merged = doc.toJSON() ?? {};
    // L1 of the three-layer defense. Wrapped in a config.validate span
    // with `validation.layer: 'L1'` so traces correlate the client-side gate
    // with the L2 (writeConfigPatch) and L3 (persistence-hook) passes.
    const parsed = withConfigSpanSync(
      'config.validate',
      { 'config.scope': scope, 'config.validation.layer': 'L1' },
      (validateSpan) => {
        const r = ConfigSchema.safeParse(merged);
        validateSpan.setAttribute('config.outcome', r.success ? 'success' : 'rejected');
        if (!r.success) {
          for (const issue of r.error.issues) {
            addConfigSpanEvent('config.validation.issue', {
              'issue.path': issue.path.map((p) => String(p)).join('.'),
              'issue.message': issue.message,
            });
          }
        }
        return r;
      },
    );
    if (!parsed.success) {
      return err({
        code: 'SCHEMA_INVALID',
        issues: parsed.error.issues.map(toConfigIssue),
      });
    }

    // Serialize and replace Y.Text content atomically. The transaction
    // has no marked origin — propagates through Hocuspocus normally so
    // the persistence-hook (L3) and any other connected clients see the
    // update.
    const newContent = doc.toString();
    ydoc.transact(() => {
      if (ytext.length > 0) ytext.delete(0, ytext.length);
      ytext.insert(0, newContent);
    });

    return ok({
      effective: parsed.data,
      appliedPaths,
    });
  }

  return {
    current(): Config {
      return readCurrent(ytext, scope);
    },

    patch(patch: ConfigPatch): ConfigBindingPatchResult {
      return withConfigSpanSync(
        'config.patch',
        { 'config.scope': scope, 'config.transport': 'ytext' },
        (patchSpan) => {
          const result = patchInner(patch);
          patchSpan.setAttribute('config.outcome', result.ok ? 'success' : 'rejected');
          if (!result.ok) patchSpan.setAttribute('config.error.code', result.error.code);
          return result;
        },
      );
    },

    subscribe(listener: (config: Config) => void): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    hasSynced(): boolean {
      return synced;
    },

    subscribeSynced(listener: () => void): Unsubscribe {
      if (disposed) return () => {};
      if (synced) {
        // Already synced — schedule a one-shot async fire so callers always
        // see consistent timing (never synchronous on subscribe). Mirrors the
        // contract on `subscribe()` where the listener does not fire
        // synchronously.
        let cancelled = false;
        queueMicrotask(() => {
          if (cancelled || disposed) return;
          try {
            listener();
          } catch (e) {
            console.warn(`[bindConfigDoc:${scope}] synced listener threw:`, e);
          }
        });
        return () => {
          cancelled = true;
        };
      }
      syncedListeners.add(listener);
      return () => {
        syncedListeners.delete(listener);
      };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      ytext.unobserve(fireListeners);
      provider.off('synced', onSynced);
      listeners.clear();
      syncedListeners.clear();
    },
  };
}
