
import { isMap, type ParsedNode, parseDocument } from 'yaml';
import type * as Y from 'yjs';
import type { ConfigValidationError, WriteScope } from './errors.ts';
import type { Err, Ok, Result } from './result.ts';
import { type Config, type ConfigPatch, ConfigSchema } from './schema.ts';
import { addConfigSpanEvent, withConfigSpanSync } from './telemetry.ts';
import { validatePatchScopes } from './validate-patch-scopes.ts';
import { applyPatchToDocument, toConfigIssue } from './yaml-patch.ts';

export interface ConfigDocProvider {
  document: Y.Doc;
  on(event: 'synced', listener: () => void): void;
  off(event: 'synced', listener: () => void): void;
}

export interface ConfigBindingPatchSuccess {
  effective: Config;
  appliedPaths: string[];
}

export type ConfigBindingPatchResult = Result<ConfigBindingPatchSuccess, ConfigValidationError>;

export type Unsubscribe = () => void;

export interface ConfigBinding {
  current(): Config;
  patch(patch: ConfigPatch): ConfigBindingPatchResult;
  subscribe(listener: (config: Config) => void): Unsubscribe;
  hasSynced(): boolean;
  subscribeSynced(listener: () => void): Unsubscribe;
  dispose(): void;
}

interface BindConfigDocOptions {
  ytextKey?: string;
}

const DEFAULT_YTEXT_KEY = 'source';

function err(error: ConfigValidationError): Err<ConfigValidationError> {
  return { ok: false, error };
}

function ok(value: ConfigBindingPatchSuccess): Ok<ConfigBindingPatchSuccess> {
  return { ok: true, ...value };
}

function schemaDefaults(): Config {
  return ConfigSchema.parse({});
}

function readCurrent(ytext: Y.Text, scope: WriteScope): Config {
  const content = ytext.toString();
  if (content.length === 0) return schemaDefaults();

  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
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

  ytext.observe(fireListeners);
  provider.on('synced', onSynced);

  function patchInner(patch: ConfigPatch): ConfigBindingPatchResult {
    if (disposed) {
      return err({
        code: 'WRITE_ERROR',
        detail: `ConfigBinding (${scope}) has been disposed`,
      });
    }

    const scopeViolation = validatePatchScopes(patch, scope);
    if (scopeViolation !== null) {
      return err(scopeViolation);
    }

    const currentContent = ytext.toString();
    let doc = parseDocument(currentContent);

    const topLevelNonMap = doc.contents !== null && !isMap(doc.contents);
    if (doc.errors.length > 0 || topLevelNonMap) {
      addConfigSpanEvent('config.corrupt-ytext-reset', {
        'config.scope': scope,
        'config.parse.errorCount': doc.errors.length,
        'config.parse.topLevelNonMap': topLevelNonMap,
      });
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
