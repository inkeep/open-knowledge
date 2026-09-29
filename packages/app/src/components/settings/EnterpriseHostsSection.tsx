import { type ConfigBinding, humanFormat, normalizeGitHostname } from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { Trash2 } from 'lucide-react';
import { type SubmitEvent, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  declaredEnterpriseHosts,
  type EnterpriseHostInputResult,
  parseEnterpriseHostInput,
} from './enterprise-host-input';

export function EnterpriseHostsSection({ binding }: { binding: ConfigBinding }) {
  const { t } = useLingui();
  const hintId = useId();
  const errorId = useId();
  const [hosts, setHosts] = useState(() => declaredEnterpriseHosts(binding.current()));
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [focusAfterRemove, setFocusAfterRemove] = useState<{ host: string | null } | null>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusAfterRemove === null) return;
    const target =
      focusAfterRemove.host === null ? null : removeButtons.current.get(focusAfterRemove.host);
    (target ?? inputRef.current)?.focus();
    setFocusAfterRemove(null);
  }, [focusAfterRemove]);

  useEffect(() => binding.subscribe((next) => setHosts(declaredEnterpriseHosts(next))), [binding]);

  function rejectionMessage(
    reason: Extract<EnterpriseHostInputResult, { ok: false }>['reason'],
  ): string {
    switch (reason) {
      case 'empty':
        return t`Enter a hostname, such as github.example.com.`;
      case 'invalid':
        return t`That isn't a valid hostname. Enter just the server name, such as github.example.com.`;
      case 'github-com':
        return t`github.com is always recognized, so it doesn't need to be added.`;
      case 'duplicate':
        return t`That host is already in the list.`;
    }
  }

  function handleAdd(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseEnterpriseHostInput(
      draft,
      new Set(hosts.map((host) => normalizeGitHostname(host))),
    );
    if (!parsed.ok) {
      setError(rejectionMessage(parsed.reason));
      return;
    }
    const result = binding.patch({ git: { hosts: { [parsed.host]: { provider: 'github' } } } });
    if (!result.ok) {
      setError(humanFormat(result.error));
      return;
    }
    setHosts(declaredEnterpriseHosts(result.effective));
    setDraft('');
    setError(null);
    setPendingRestart(true);
  }

  function handleRemove(host: string) {
    const index = hosts.indexOf(host);
    const neighbor = hosts[index + 1] ?? hosts[index - 1] ?? null;
    const result = binding.patch({ git: { hosts: { [host]: null } } });
    if (!result.ok) {
      setError(humanFormat(result.error));
      return;
    }
    setHosts(declaredEnterpriseHosts(result.effective));
    setFocusAfterRemove({ host: neighbor });
    setError(null);
    setPendingRestart(true);
  }

  return (
    <section
      aria-labelledby="settings-enterprise-hosts-title"
      className="space-y-4 pt-5"
      data-field="section:enterprise-hosts"
      data-testid="settings-enterprise-hosts"
    >
      <div>
        <h4 id="settings-enterprise-hosts-title" className="text-sm font-medium">
          <Trans>GitHub Enterprise Server hosts</Trans>
        </h4>
        <p id={hintId} className="text-1sm text-muted-foreground">
          <Trans>
            If you use a GitHub Enterprise Server, add its host here so OpenKnowledge can sign in,
            check push permission, and create share links for repositories hosted there.
          </Trans>
        </p>
      </div>

      <div className="space-y-2 rounded-lg border bg-card p-3">
        {hosts.length > 0 ? (
          <ul className="space-y-1" data-testid="settings-enterprise-hosts-list">
            {hosts.map((host) => (
              <li key={host} className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{host}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t`Remove ${host}`}
                  ref={(element) => {
                    if (element) removeButtons.current.set(host, element);
                    else removeButtons.current.delete(host);
                  }}
                  onClick={() => handleRemove(host)}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p
            className="text-1sm text-muted-foreground"
            data-testid="settings-enterprise-hosts-empty"
          >
            <Trans>No Enterprise hosts added. Only github.com is treated as GitHub.</Trans>
          </p>
        )}

        <form className="flex items-center gap-2 pt-1" onSubmit={handleAdd} noValidate>
          <Input
            ref={inputRef}
            value={draft}
            aria-label={t`Add a host`}
            placeholder="github.example.com"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            className="h-7 flex-1 font-mono text-xs"
            aria-invalid={error !== null}
            aria-describedby={error !== null ? `${hintId} ${errorId}` : hintId}
            onChange={(event) => {
              setDraft(event.target.value);
              if (error !== null) setError(null);
            }}
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={draft.trim() === ''}
            className="h-7 px-2 font-normal text-xs"
          >
            <Trans>Add host</Trans>
          </Button>
        </form>

        {error !== null ? (
          <p id={errorId} role="alert" className="text-1sm text-destructive">
            {error}
          </p>
        ) : null}
        {pendingRestart ? (
          <p role="status" className="text-1sm text-muted-foreground">
            <Trans>Saved. Restart OpenKnowledge to apply the change.</Trans>
          </p>
        ) : null}
      </div>
    </section>
  );
}
