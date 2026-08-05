/**
 * Settings → Search — opt-in semantic (embeddings) ranking for the MCP search
 * tool. Per-machine (project-local scope) because enabling it sends content to
 * a third-party embeddings provider; each teammate opts in deliberately on
 * their own machine rather than inheriting one collaborator's egress choice
 * through git.
 *
 * The toggle reads the synchronous project-local CRDT preference (the same
 * pattern as the Sync section's Switch — never the server's resolved state,
 * which round-trips through the persistence debounce + config file-watcher and
 * would make the control appear to lag). Every off → on transition is gated by
 * a confirmation dialog that discloses the egress; on → off commits immediately
 * (the safe direction).
 *
 * The status panel below the toggle derives from the server's
 * `GET /api/semantic-status` probe (`keyPresent` / `ready` / `capable`).
 *
 * The API key lives on THIS screen now (per-project, next to its endpoint — no
 * more machine-global Account key): a write-only field that stores the key,
 * bound to the project's configured endpoint, in the 0600 `~/.ok/secrets.yml`
 * (never in the project tree). It's optional — a localhost endpoint needs none.
 *
 * The endpoint and model live behind a "Custom endpoint" disclosure: they are
 * power-user knobs, but they auto-expand when either is already overridden so a
 * value set from the CLI is never hidden from the person who set it. Both are
 * destructive to change — the cached vectors are keyed by provider + model, so
 * a change re-embeds and re-sends the whole corpus — hence the confirmation.
 */
// biome-ignore-all lint/plugin/no-physical-direction-utility: pre-rule backlog — physical margin/padding/inset utilities predate the rule; drain by swapping ml/mr → ms/me, pl/pr → ps/pe, left/right → start/end, then deleting this line. See https://github.com/inkeep/open-knowledge/blob/main/biome-plugins/README.md#no-physical-direction-utilitygrit

import {
  checkEmbeddingsBaseUrl,
  DEFAULT_EMBEDDINGS_BASE_URL,
  DEFAULT_EMBEDDINGS_MODEL,
  humanFormat,
  type LocalOpEmbeddingsTestResponse,
} from '@inkeep/open-knowledge-core';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  Dialog as DialogRoot,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useSemanticSearchStatus } from '@/hooks/use-semantic-search-status';
import { useConfigContext } from '@/lib/config-provider';
import {
  type EmbeddingsKeyTransport,
  httpEmbeddingsKeyTransport,
} from '@/lib/transports/embeddings-key-transport';

// Refetch `/api/semantic-status` at these delays (ms) after a toggle so the
// coverage panel repaints once the persistence debounce + config file-watcher
// have carried the new `search.semantic.enabled` into the server. The `files`
// CC1 channel doesn't fire for config-doc edits, so this is the catch-up path.
const SETTLE_REFRESH_DELAYS_MS = [2500, 5000] as const;

export function SearchSection({ transport }: { transport?: EmbeddingsKeyTransport }) {
  const { t } = useLingui();
  const { projectLocalConfig, projectLocalSynced, projectLocalBinding } = useConfigContext();
  const { status, refresh } = useSemanticSearchStatus();
  const resolvedTransport = transport ?? httpEmbeddingsKeyTransport();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
  // Don't nag mid-typing: surface the endpoint error only after the field has
  // been committed once (blur/Enter), then keep it live so a fix clears it.
  const [baseUrlTouched, setBaseUrlTouched] = useState(false);
  const settleTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  useEffect(
    () => () => {
      for (const timer of settleTimersRef.current) clearTimeout(timer);
    },
    [],
  );

  const configuredBaseUrl =
    projectLocalConfig?.search?.semantic?.baseUrl ?? DEFAULT_EMBEDDINGS_BASE_URL;
  const configuredModel = projectLocalConfig?.search?.semantic?.model ?? DEFAULT_EMBEDDINGS_MODEL;

  const [baseUrlDraft, setBaseUrlDraft] = useState(configuredBaseUrl);
  const [modelDraft, setModelDraft] = useState(configuredModel);
  // The committed-but-unconfirmed provider change awaiting the re-index warning.
  const [pendingProvider, setPendingProvider] = useState<{
    baseUrl: string;
    model: string;
  } | null>(null);
  // null = follow the auto-expand rule; a boolean = the user has decided.
  const [disclosureOverride, setDisclosureOverride] = useState<boolean | null>(null);
  const [testing, setTesting] = useState(false);
  // `null` inside the result means the request itself never got a verdict.
  const [testResult, setTestResult] = useState<{
    response: LocalOpEmbeddingsTestResponse | null;
  } | null>(null);

  // When the persisted values change externally (e.g. `ok embeddings set-url` in
  // a terminal while Settings is open), re-seed the drafts and clear the
  // validation gate + any stale test verdict. This is the React "adjust state
  // during render on a changed value" pattern (no effect).
  const [prevConfigured, setPrevConfigured] = useState({
    baseUrl: configuredBaseUrl,
    model: configuredModel,
  });
  if (configuredBaseUrl !== prevConfigured.baseUrl || configuredModel !== prevConfigured.model) {
    setPrevConfigured({ baseUrl: configuredBaseUrl, model: configuredModel });
    setBaseUrlDraft(configuredBaseUrl);
    setModelDraft(configuredModel);
    setBaseUrlTouched(false);
    setBaseUrlError(null);
    setTestResult(null);
  }

  const enabled = projectLocalConfig?.search?.semantic?.enabled ?? false;
  const bindingReady = projectLocalSynced && projectLocalBinding !== null;
  const hasProviderOverride =
    configuredBaseUrl !== DEFAULT_EMBEDDINGS_BASE_URL ||
    configuredModel !== DEFAULT_EMBEDDINGS_MODEL;
  // Auto-expand when either knob is already overridden: an endpoint set from the
  // CLI must not be invisible to the person looking for it in Settings.
  const disclosureOpen = disclosureOverride ?? hasProviderOverride;

  function scheduleSettleRefresh() {
    for (const timer of settleTimersRef.current) clearTimeout(timer);
    settleTimersRef.current = SETTLE_REFRESH_DELAYS_MS.map((delay) => setTimeout(refresh, delay));
  }

  function write(next: boolean): boolean {
    if (projectLocalBinding === null) {
      toast.error(t`Search settings not yet loaded — try again in a moment`);
      return false;
    }
    const result = projectLocalBinding.patch({ search: { semantic: { enabled: next } } });
    if (!result.ok) {
      const detail = humanFormat(result.error);
      toast.error(
        next
          ? t`Failed to enable semantic search — ${detail}`
          : t`Failed to disable semantic search — ${detail}`,
      );
      return false;
    }
    refresh();
    scheduleSettleRefresh();
    return true;
  }

  function normalizeBaseUrl(next: string): string {
    return next.trim() || DEFAULT_EMBEDDINGS_BASE_URL;
  }

  function normalizeModel(next: string): string {
    return next.trim() || DEFAULT_EMBEDDINGS_MODEL;
  }

  function writeProvider(next: { baseUrl: string; model: string }): boolean {
    if (projectLocalBinding === null) {
      toast.error(t`Search settings not yet loaded — try again in a moment`);
      return false;
    }
    const result = projectLocalBinding.patch({
      search: { semantic: { baseUrl: next.baseUrl, model: next.model } },
    });
    if (!result.ok) {
      const detail = humanFormat(result.error);
      toast.error(t`Failed to update the embeddings provider — ${detail}`);
      return false;
    }
    // The previous provider's verdict says nothing about the new one.
    setTestResult(null);
    refresh();
    scheduleSettleRefresh();
    return true;
  }

  /**
   * Commit a field edit. A change to either knob invalidates every cached
   * vector, so it goes through the re-index + egress warning first; a no-op
   * edit (retyping the same value, or blurring an untouched field) doesn't.
   */
  function requestProviderChange(next: { baseUrl: string; model: string }): void {
    if (next.baseUrl === configuredBaseUrl && next.model === configuredModel) return;
    setPendingProvider(next);
  }

  function onConfirmProviderChange(): void {
    if (pendingProvider && writeProvider(pendingProvider)) setPendingProvider(null);
  }

  function onCancelProviderChange(): void {
    setPendingProvider(null);
    setBaseUrlDraft(configuredBaseUrl);
    setModelDraft(configuredModel);
    setBaseUrlError(null);
  }

  async function onTestConnection(): Promise<void> {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    // The transport contracts to resolve `null` rather than throw, but a
    // rejection here would otherwise leave the button reading "Testing"
    // forever with no way back. Catch-and-continue rather than `finally` —
    // React Compiler cannot lower a `try` with a finalizer.
    let response: LocalOpEmbeddingsTestResponse | null = null;
    try {
      response = await resolvedTransport.testConnection();
    } catch {
      response = null;
    }
    setTesting(false);
    setTestResult({ response });
  }

  function onToggleRequest(next: boolean) {
    if (next) {
      // Off → on: gate behind the egress confirmation. On → off is the safe
      // direction and commits immediately.
      setConfirmOpen(true);
      return;
    }
    write(false);
  }

  function onConfirm() {
    // Close only on success so a failed write leaves the dialog open to retry.
    if (write(true)) setConfirmOpen(false);
  }

  // Mirror the server's pre-flight guard (`checkEmbeddingsBaseUrl`) so a
  // guaranteed-to-fail endpoint is flagged at entry instead of surfacing later
  // as a provider-rejected status. Empty resets to the default (always valid).
  function baseUrlProblemMessage(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const problem = checkEmbeddingsBaseUrl(trimmed);
    if (problem === null) return null;
    return problem === 'invalid-url'
      ? t`Enter a valid URL (for example https://api.openai.com/v1).`
      : t`Use an https:// URL — http:// is only allowed for localhost.`;
  }

  // Live-validate only after the field has been committed once (touched), so the
  // error doesn't flash while the user is still typing a URL.
  function onBaseUrlChange(value: string): void {
    setBaseUrlDraft(value);
    if (baseUrlTouched) setBaseUrlError(baseUrlProblemMessage(value));
  }

  // Both fields commit together: one confirmation covers the single re-index
  // they'd otherwise trigger twice, and a bad URL blocks the model edit too
  // rather than persisting half of the change.
  function commitProviderEdits(): void {
    setBaseUrlTouched(true);
    const message = baseUrlProblemMessage(baseUrlDraft);
    setBaseUrlError(message);
    if (message !== null) return;
    requestProviderChange({
      baseUrl: normalizeBaseUrl(baseUrlDraft),
      model: normalizeModel(modelDraft),
    });
  }

  // Status derives from the server's resolved view, not the client preference:
  // `serverEnabled` lags the toggle until the file-watcher settles. `keyPresent`
  // is a free, prompt-free read (secrets file / env) so "no key" shows the
  // instant the toggle flips — no waiting for a warm. `ready` = the service has
  // warmed (used for the coverage line); `capable` = warmed AND the key actually
  // worked, so `keyPresent && ready && !capable` is "provider rejected the key".
  const serverEnabled = status?.enabled ?? false;
  const keyPresent = status?.keyPresent ?? false;
  const keyNotRequired = status?.keyNotRequired ?? false;
  const keyHint = status?.keyHint ?? null;
  const keySource = status?.keySource ?? null;
  const ready = status?.ready ?? false;
  const capable = status?.capable ?? false;
  const embedded = status?.embedded ?? 0;
  const total = status?.total ?? 0;

  const endpointHost = hostOf(configuredBaseUrl) ?? configuredBaseUrl;

  return (
    <section
      aria-labelledby="settings-search-title"
      className="space-y-3"
      data-testid="settings-search"
    >
      <div className="space-y-1">
        <h3 id="settings-search-title" className="text-base font-semibold">
          <Trans>Semantic search</Trans>
        </h3>
        <p className="text-sm text-muted-foreground">
          <Trans>
            Add meaning-based ranking to search so conceptually-related pages surface even when they
            share no keywords. This setting applies only to this computer.
          </Trans>
        </p>
      </div>

      <div className="rounded-md border p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <label htmlFor="settings-search-semantic-toggle" className="text-sm font-medium">
              <Trans>Semantic search</Trans>
            </label>
            <p className="text-muted-foreground text-1sm" data-testid="settings-search-body">
              {enabled ? (
                <Trans>
                  On — your search queries and the text of matching pages are sent to your
                  embeddings provider (OpenAI by default) to compute embeddings.
                </Trans>
              ) : (
                <Trans>Off — search ranks by keyword only. No content leaves this computer.</Trans>
              )}
            </p>
          </div>
          <Switch
            id="settings-search-semantic-toggle"
            checked={enabled}
            disabled={!bindingReady}
            onCheckedChange={onToggleRequest}
            aria-label={enabled ? t`Disable semantic search` : t`Enable semantic search`}
            data-testid="settings-search-semantic-toggle"
          />
        </div>

        {enabled ? (
          <SemanticStatusPanel
            loaded={status !== null}
            serverEnabled={serverEnabled}
            keyPresent={keyPresent}
            keyNotRequired={keyNotRequired}
            ready={ready}
            capable={capable}
            embedded={embedded}
            total={total}
          />
        ) : null}
      </div>

      <EmbeddingsKeyField
        transport={resolvedTransport}
        refresh={refresh}
        endpointHost={endpointHost}
        keyPresent={keyPresent}
        keyHint={keyHint}
        keySource={keySource}
        keyNotRequired={keyNotRequired}
        loaded={status !== null}
      />

      <Collapsible
        open={disclosureOpen}
        onOpenChange={setDisclosureOverride}
        className="rounded-md border"
        data-testid="settings-search-custom-endpoint"
      >
        <CollapsibleTrigger
          className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium hover:bg-muted/50"
          data-testid="settings-search-custom-endpoint-trigger"
        >
          <Trans>Custom endpoint</Trans>
          <ChevronRight
            className="size-4 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 border-t px-3 py-3">
          <p className="text-muted-foreground text-1sm">
            <Trans>
              Point semantic search at any OpenAI-compatible embeddings endpoint — a self-hosted
              server or another provider. The API key above is for whichever endpoint you set here.
            </Trans>
          </p>

          <div className="space-y-2">
            <label htmlFor="settings-search-base-url" className="block text-sm font-medium">
              <Trans>Endpoint</Trans>
            </label>
            <Input
              id="settings-search-base-url"
              value={baseUrlDraft}
              onChange={(e) => onBaseUrlChange(e.currentTarget.value)}
              onBlur={commitProviderEdits}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitProviderEdits();
                }
              }}
              placeholder={DEFAULT_EMBEDDINGS_BASE_URL}
              disabled={!bindingReady}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={baseUrlError !== null}
              aria-describedby="settings-search-base-url-message"
              data-testid="settings-search-base-url"
              className="h-8 font-mono text-sm"
            />
            {/* One persistent live region (not a conditionally-mounted node) so a
                screen reader reliably announces the error when it appears — swapping
                in a fresh aria-live element WITH content is often missed. */}
            <p
              id="settings-search-base-url-message"
              aria-live="polite"
              className={
                baseUrlError ? 'text-1sm text-destructive' : 'text-muted-foreground text-1sm'
              }
              data-testid={
                baseUrlError ? 'settings-search-base-url-error' : 'settings-search-base-url-help'
              }
            >
              {baseUrlError ?? (
                <Trans>Clear the field to reset back to the default OpenAI endpoint.</Trans>
              )}
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="settings-search-model" className="block text-sm font-medium">
              <Trans>Model</Trans>
            </label>
            <Input
              id="settings-search-model"
              value={modelDraft}
              onChange={(e) => setModelDraft(e.currentTarget.value)}
              onBlur={commitProviderEdits}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitProviderEdits();
                }
              }}
              placeholder={DEFAULT_EMBEDDINGS_MODEL}
              disabled={!bindingReady}
              spellCheck={false}
              autoComplete="off"
              aria-describedby="settings-search-model-help"
              data-testid="settings-search-model"
              className="h-8 font-mono text-sm"
            />
            <p
              id="settings-search-model-help"
              className="text-muted-foreground text-1sm"
              data-testid="settings-search-model-help"
            >
              <Trans>
                The model id your endpoint serves. Its vector size is detected automatically — clear
                the field to go back to {DEFAULT_EMBEDDINGS_MODEL}.
              </Trans>
            </p>
          </div>

          <div className="space-y-2">
            <Button
              variant="outline"
              onClick={() => void onTestConnection()}
              disabled={testing || !bindingReady}
              data-testid="settings-search-test-connection"
            >
              {testing ? <Trans>Testing</Trans> : <Trans>Test connection</Trans>}
            </Button>
            <TestConnectionResult
              result={testResult}
              testing={testing}
              configuredBaseUrl={configuredBaseUrl}
              configuredModel={configuredModel}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

      <EnableSemanticSearchConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={onConfirm}
      />
      <ProviderChangeConfirmDialog
        pending={pendingProvider}
        pageCount={total}
        onCancel={onCancelProviderChange}
        onConfirm={onConfirmProviderChange}
      />
    </section>
  );
}

interface EmbeddingsKeyFieldProps {
  transport: EmbeddingsKeyTransport;
  refresh: () => void;
  endpointHost: string;
  keyPresent: boolean;
  keyHint: string | null;
  keySource: 'project' | 'file' | 'env' | null;
  keyNotRequired: boolean;
  loaded: boolean;
}

/**
 * The embeddings API key — now on THIS screen, next to the endpoint it belongs
 * to (no more hunting in Account). Write-only: the key is never displayed or
 * returned, only presence + a redacted hint; the input sets / replaces / clears
 * it through the loopback transport, which binds it to the project's currently
 * configured endpoint. Optional — a localhost endpoint needs none.
 */
function EmbeddingsKeyField({
  transport,
  refresh,
  endpointHost,
  keyPresent,
  keyHint,
  keySource,
  keyNotRequired,
  loaded,
}: EmbeddingsKeyFieldProps) {
  const { t } = useLingui();
  const [keyInput, setKeyInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSave() {
    const key = keyInput.trim();
    if (!key || busy) return;
    setBusy(true);
    setError(null);
    const result = await transport.setKey(key);
    setBusy(false);
    if (result.ok) {
      setKeyInput(''); // Don't keep the secret in component state after it lands.
      refresh();
    } else {
      setError(result.error ?? t`Couldn't save the key — please try again.`);
    }
  }

  async function onClear() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await transport.clearKey();
    setBusy(false);
    if (result.ok) refresh();
    else setError(result.error ?? t`Couldn't clear the key — please try again.`);
  }

  return (
    <section className="space-y-3 rounded-md border p-3" data-testid="settings-search-key">
      <div className="space-y-1">
        <h4 className="text-sm font-medium">
          <Trans>Embeddings API key</Trans>
        </h4>
        <p className="text-muted-foreground text-1sm">
          {keyNotRequired ? (
            <Trans>
              Not required for a localhost endpoint like{' '}
              <span className="font-medium">{endpointHost}</span> — most local servers ignore it.
              Add one only if yours needs it.
            </Trans>
          ) : (
            <Trans>
              Sent to <span className="font-medium">{endpointHost}</span> to embed your content.
              Stored on this machine only (in{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                ~/.ok/secrets.yml
              </code>
              ), never in the project.
            </Trans>
          )}
        </p>
      </div>

      {keySource === 'env' ? (
        <p className="text-muted-foreground text-1sm" data-testid="settings-search-key-env">
          <Trans>
            Using the{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              OK_EMBEDDINGS_API_KEY
            </code>{' '}
            environment variable (managed outside OpenKnowledge).
          </Trans>
        </p>
      ) : (
        <>
          {keyPresent ? (
            <div
              className="flex items-center justify-between gap-3"
              data-testid="settings-search-key-set"
            >
              <div className="min-w-0">
                <div className="mb-1.5 text-sm font-medium">
                  <Trans>API key set</Trans>
                </div>
                {keyHint ? (
                  <p
                    className="truncate font-mono text-muted-foreground text-xs"
                    title={t`Key ending in ${keyHint}`}
                    data-testid="settings-search-key-hint"
                  >
                    <span aria-hidden="true">••••••••</span>
                    {keyHint}
                  </p>
                ) : null}
              </div>
              <Button
                variant="outline"
                onClick={() => void onClear()}
                disabled={busy}
                data-testid="settings-search-key-clear"
              >
                <Trans>Clear</Trans>
              </Button>
            </div>
          ) : null}

          <div>
            <label htmlFor="settings-search-key-input" className="mb-2 block text-sm font-medium">
              {keyPresent ? <Trans>Replace key</Trans> : <Trans>Add a key</Trans>}
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="settings-search-key-input"
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  // Enter-to-save, matching the endpoint/model inputs and the
                  // strong submit expectation on a password field.
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void onSave();
                  }
                }}
                placeholder={t`Paste your API key`}
                autoComplete="off"
                spellCheck={false}
                disabled={busy || !loaded}
                data-testid="settings-search-key-input"
                className="h-8 font-mono text-sm"
              />
              <Button
                onClick={() => void onSave()}
                disabled={busy || keyInput.trim().length === 0}
                data-testid="settings-search-key-save"
              >
                {busy ? <Trans>Saving</Trans> : <Trans>Save</Trans>}
              </Button>
            </div>
          </div>
        </>
      )}

      {error ? (
        <p
          role="alert"
          className="text-sm text-destructive"
          data-testid="settings-search-key-error"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}

interface SemanticStatusPanelProps {
  loaded: boolean;
  serverEnabled: boolean;
  keyPresent: boolean;
  keyNotRequired: boolean;
  ready: boolean;
  capable: boolean;
  embedded: number;
  total: number;
}

/**
 * Read-only readout under the toggle. States, in order: still settling (server
 * hasn't picked up the toggle), no-key (instant — driven off the free
 * `keyPresent` read, not a warm), provider-rejected-the-key, not-yet-warmed
 * (indexes on first search), and live coverage (with a lazy-embedding note while
 * nothing is embedded yet).
 */
function SemanticStatusPanel({
  loaded,
  serverEnabled,
  keyPresent,
  keyNotRequired,
  ready,
  capable,
  embedded,
  total,
}: SemanticStatusPanelProps) {
  if (!loaded || !serverEnabled) {
    return (
      <p
        role="status"
        aria-live="polite"
        className="text-muted-foreground text-1sm mt-2"
        data-testid="settings-search-settling"
      >
        <Trans>Applying your change</Trans>
      </p>
    );
  }

  if (!keyPresent && !keyNotRequired) {
    // No key resolvable — instant (a free file read, no warm needed). Point at
    // the key field right below, on this same screen.
    return (
      <div
        role="alert"
        className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-1sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
        data-testid="settings-search-needs-key"
      >
        <Trans>
          Semantic search is on, but no API key is set — search falls back to keyword matching. Add
          one below.
        </Trans>
      </div>
    );
  }

  if (ready && !capable) {
    // A key is present and the service warmed, but the embedder failed to load —
    // a bad key or an unreachable provider. Distinct from "no key" above.
    return (
      <div
        role="alert"
        className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-1sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
        data-testid="settings-search-provider-error"
      >
        <Trans>
          A key is set, but the embeddings provider rejected it or was unreachable — search fell
          back to keyword matching. Use <span className="font-medium">Test connection</span> under
          Custom endpoint to see what went wrong.
        </Trans>
      </div>
    );
  }

  if (!ready) {
    return (
      <p
        role="status"
        className="text-muted-foreground text-1sm mt-2"
        data-testid="settings-search-pending"
      >
        <Trans>Semantic ranking activates the first time an agent runs a search.</Trans>
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-0.5" data-testid="settings-search-coverage">
      <p className="text-muted-foreground text-1sm">
        <Trans>
          Indexed {embedded} of {total} pages.
        </Trans>
      </p>
      {embedded === 0 ? (
        <p className="text-muted-foreground text-1sm">
          <Trans>Pages are embedded the first time a search needs them.</Trans>
        </p>
      ) : null}
    </div>
  );
}

interface TestConnectionResultProps {
  result: { response: LocalOpEmbeddingsTestResponse | null } | null;
  testing: boolean;
  configuredBaseUrl: string;
  configuredModel: string;
}

/**
 * The verdict from one live probe. This is the whole answer to "is my endpoint
 * actually working" — every embeddings failure otherwise degrades quietly to
 * keyword search, so a wrong URL / key / model looks exactly like a working
 * setup that hasn't indexed yet.
 *
 * The detected vector size doubles as the readout for a value the user can no
 * longer enter by hand.
 */
function TestConnectionResult({
  result,
  testing,
  configuredBaseUrl,
  configuredModel,
}: TestConnectionResultProps) {
  if (testing || result === null) return null;

  const { response } = result;
  if (response === null) {
    return (
      <TestConnectionMessage tone="error" testId="settings-search-test-unreachable">
        <Trans>Couldn't run the test. Check that OpenKnowledge is still running.</Trans>
      </TestConnectionMessage>
    );
  }

  // The probe reads the SAVED config, which trails an edit by the time it takes
  // the change to reach disk. Say so rather than report a verdict for the
  // endpoint the user just replaced.
  if (response.endpoint !== configuredBaseUrl || response.model !== configuredModel) {
    return (
      <TestConnectionMessage tone="warn" testId="settings-search-test-stale">
        <Trans>Your change is still being saved — run the test again in a moment.</Trans>
      </TestConnectionMessage>
    );
  }

  if (response.ok) {
    return (
      <TestConnectionMessage tone="ok" testId="settings-search-test-ok">
        <Trans>Connected — this endpoint returns {response.dimensions}-dimension vectors.</Trans>
      </TestConnectionMessage>
    );
  }

  return (
    <TestConnectionMessage tone="error" testId="settings-search-test-error">
      <TestConnectionFailure response={response} />
    </TestConnectionMessage>
  );
}

/** Reason-specific copy — each one names the next thing to try. */
function TestConnectionFailure({
  response,
}: {
  response: Extract<LocalOpEmbeddingsTestResponse, { ok: false }>;
}) {
  switch (response.reason) {
    case 'no_key':
      return <Trans>No API key is set for this endpoint. Add one above.</Trans>;
    case 'invalid_endpoint':
      return (
        <Trans>
          That endpoint can't be used. Enter an https:// URL — http:// is only allowed for
          localhost.
        </Trans>
      );
    case 'rate_limit':
      return <Trans>The provider is rate-limiting this key. Try again in a moment.</Trans>;
    case 'timeout':
      return <Trans>The endpoint didn't respond in time.</Trans>;
    case 'network':
      return <Trans>Couldn't reach the endpoint. Check the URL and that the server is up.</Trans>;
    case 'dims_mismatch':
      return (
        <Trans>
          This endpoint ignored the vector size you configured. Remove{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            search.semantic.dimensions
          </code>{' '}
          to use the model's own size.
        </Trans>
      );
    case 'malformed_response':
      return (
        <Trans>
          The endpoint answered, but not with an OpenAI-compatible embeddings response. Check the
          base URL.
        </Trans>
      );
    default:
      // http_error — the status is the actionable part (401 key, 404 model).
      return response.status !== undefined ? (
        <Trans>
          The provider rejected the request (HTTP {response.status}). Check the API key and the
          model id.
        </Trans>
      ) : (
        <Trans>The provider rejected the request. Check the API key and the model id.</Trans>
      );
  }
}

function TestConnectionMessage({
  tone,
  testId,
  children,
}: {
  tone: 'ok' | 'warn' | 'error';
  testId: string;
  children: ReactNode;
}) {
  // A failed probe must not look like the transient "still saving" notice —
  // colour is the first thing read here, so a real failure gets the
  // destructive palette rather than sharing amber with a warning.
  const toneClass = {
    ok: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200',
    warn: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200',
    error: 'border-destructive/50 bg-destructive/10 text-destructive',
  }[tone];
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      // `role="alert"` implies assertive; leaving an explicit "polite" here
      // makes the two disagree, and screen readers split on which wins.
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      className={`rounded-md border px-3 py-2 text-1sm ${toneClass}`}
      data-testid={testId}
    >
      {children}
    </p>
  );
}

interface ProviderChangeConfirmDialogProps {
  pending: { baseUrl: string; model: string } | null;
  pageCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Guards a change to the endpoint or model. Both are part of the vector cache's
 * identity, so changing either throws away every cached vector and re-sends the
 * full text of the corpus to the new destination — the same egress the enable
 * toggle warns about, aimed somewhere new.
 */
function ProviderChangeConfirmDialog({
  pending,
  pageCount,
  onCancel,
  onConfirm,
}: ProviderChangeConfirmDialogProps) {
  const host = pending ? (hostOf(pending.baseUrl) ?? pending.baseUrl) : '';
  return (
    <DialogRoot
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-lg" data-testid="settings-search-provider-confirm">
        <DialogHeader>
          <DialogTitle>
            <Trans>Change the embeddings provider?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Cached embeddings belong to the endpoint and model that produced them, so this
              rebuilds the index from scratch.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div
            role="alert"
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
          >
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <Plural
                  value={pageCount}
                  one={
                    <Trans>
                      The full text of your 1 page will be sent to{' '}
                      <span className="font-medium">{host}</span> as it is re-embedded.
                    </Trans>
                  }
                  other={
                    <Trans>
                      The full text of all {pageCount} pages will be sent to{' '}
                      <span className="font-medium">{host}</span> as they are re-embedded.
                    </Trans>
                  }
                />
              </li>
              <li>
                <Trans>
                  Model: <span className="font-mono">{pending?.model}</span>
                </Trans>
              </li>
              <li>
                <Trans>
                  Re-embedding happens as searches run, so coverage restarts at zero and refills.
                </Trans>
              </li>
            </ul>
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">
              <Trans>Cancel</Trans>
            </Button>
          </DialogClose>
          <Button onClick={onConfirm} data-testid="settings-search-provider-confirm-apply">
            <Trans>Change provider</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}

/** Host of a base URL, or null when it isn't parseable (shown verbatim then). */
function hostOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

interface EnableSemanticSearchConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

/**
 * Guards every off → on transition. The egress disclosure is the load-bearing
 * content — turning semantic search on is the moment content first leaves the
 * machine, so the dialog spells out what is sent, where, and that it's
 * per-machine.
 */
function EnableSemanticSearchConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: EnableSemanticSearchConfirmDialogProps) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="settings-search-confirm">
        <DialogHeader>
          <DialogTitle>
            <Trans>Turn on semantic search?</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Semantic search adds meaning-based ranking to the search tool so conceptually-related
              pages surface even without shared keywords.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div
            role="alert"
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
          >
            <p className="mb-2 font-medium">
              <Trans>This sends content off your machine</Trans>
            </p>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <Trans>
                  Your search queries and the full text of matching pages are sent to your
                  embeddings provider (OpenAI by default) to compute embeddings.
                </Trans>
              </li>
              <li>
                <Trans>
                  Embeddings are computed only when a search runs and are cached locally under{' '}
                  <code className="rounded bg-amber-100 px-1 py-0.5 font-mono text-xs dark:bg-amber-900">
                    .ok/local
                  </code>
                  .
                </Trans>
              </li>
              <li>
                <Trans>
                  This setting is per-machine and isn't shared with collaborators. It needs an API
                  key (set below) unless your endpoint is a local server that doesn't require one.
                </Trans>
              </li>
            </ul>
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">
              <Trans>Cancel</Trans>
            </Button>
          </DialogClose>
          <Button onClick={onConfirm} data-testid="settings-search-confirm-enable">
            <Trans>Turn on</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
