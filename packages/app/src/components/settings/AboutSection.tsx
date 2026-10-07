import { Trans } from '@lingui/react/macro';
import { ArrowUpRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { OkAboutInfo } from '@/lib/desktop-bridge-types';
import { SettingsSectionHeader } from './SettingsSectionHeader';

const UNAVAILABLE_REREAD_INTERVAL_MS = 3000;
const UNAVAILABLE_REREAD_LIMIT = 20;

export function AboutSection() {
  const bridge = typeof window !== 'undefined' ? (window.okDesktop ?? null) : null;
  const [about, setAbout] = useState<OkAboutInfo | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    const reads: {
      latest: number;
      scheduledRereads: number;
      timer: ReturnType<typeof setTimeout> | undefined;
    } = { latest: 0, scheduledRereads: 0, timer: undefined };
    const scheduleReread = () => {
      if (reads.scheduledRereads >= UNAVAILABLE_REREAD_LIMIT) return;
      reads.scheduledRereads += 1;
      reads.timer = setTimeout(readAbout, UNAVAILABLE_REREAD_INTERVAL_MS);
    };
    const readAbout = () => {
      clearTimeout(reads.timer);
      reads.timer = undefined;
      const read = reads.latest + 1;
      reads.latest = read;
      bridge.state
        .query()
        .then((snapshot) => {
          if (cancelled || read !== reads.latest || !snapshot.about) return;
          setAbout(snapshot.about);
          if (snapshot.about.updateChecks === 'unavailable') scheduleReread();
        })
        .catch((err: unknown) => {
          console.warn('[about-section] bridge.state.query() failed', err);
          if (cancelled || read !== reads.latest) return;
          scheduleReread();
        });
    };
    const readAboutWhenVisible = () => {
      if (document.visibilityState === 'visible') readAbout();
    };
    readAbout();
    window.addEventListener('focus', readAbout);
    document.addEventListener('visibilitychange', readAboutWhenVisible);
    const unsubscribeManualCheck = bridge.onUpdateManualCheck(({ phase }) => {
      setChecking(phase === 'started');
      readAbout();
    });
    return () => {
      cancelled = true;
      clearTimeout(reads.timer);
      window.removeEventListener('focus', readAbout);
      document.removeEventListener('visibilitychange', readAboutWhenVisible);
      unsubscribeManualCheck();
    };
  }, [bridge]);

  if (!bridge) return null;
  const version = about?.version ?? bridge.appVersion;
  const updatesUnavailable = about?.updateChecks === 'unavailable';

  return (
    <section
      aria-labelledby="settings-about-title"
      className="space-y-3"
      data-testid="settings-about"
    >
      <SettingsSectionHeader
        titleId="settings-about-title"
        title={<Trans>About & updates</Trans>}
      />
      <div className="space-y-3 rounded-md border p-3">
        <div>
          {about ? <div className="text-sm font-medium">{about.productName}</div> : null}
          <p
            className="select-text font-mono text-1sm text-muted-foreground"
            data-testid="settings-about-version"
          >
            v{version}
          </p>
        </div>
        {about ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={updatesUnavailable}
              aria-disabled={checking || undefined}
              className="aria-disabled:opacity-50"
              onClick={() => {
                if (checking) return;
                bridge.update.checkNow().catch((err: unknown) => {
                  console.warn('[about-section] bridge.update.checkNow() failed', err);
                });
              }}
              data-testid="settings-about-check-for-updates"
            >
              {checking ? (
                <>
                  <Spinner aria-hidden="true" />
                  <Trans>Checking for updates</Trans>
                </>
              ) : (
                <Trans>Check for updates</Trans>
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void bridge.shell.openExternal(about.releaseNotesUrl);
              }}
              data-testid="settings-about-release-notes"
            >
              <Trans>Release notes</Trans>
              <ArrowUpRight aria-hidden="true" className="size-3" />
            </Button>
          </div>
        ) : null}
        {updatesUnavailable ? (
          <p className="text-1sm text-muted-foreground">
            <Trans>Automatic updates are not available right now.</Trans>
          </p>
        ) : null}
      </div>
    </section>
  );
}
