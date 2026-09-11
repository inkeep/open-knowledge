import {
  UNINSTALL_RESULT_WAIT_TIMEOUT_MS,
  type UninstallScreenSpec,
} from '@inkeep/open-knowledge-core';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import {
  requestUninstallScreen,
  sendUninstallIntent,
  type UninstallScreenResponse,
} from './bridge';
import { UninstallNoticeScreen } from './UninstallNoticeScreen';
import { UninstallPickerScreen } from './UninstallPickerScreen';
import { UninstallProgressScreen } from './UninstallProgressScreen';
import { UninstallResultScreen } from './UninstallResultScreen';
import { UninstallSurveyScreen } from './UninstallSurveyScreen';

const MAX_TRANSIENT_SCREEN_FAILURES = 3;
const SCREEN_POLL_INTERVAL_MS = 250;

function canRetry(response: UninstallScreenResponse): boolean {
  if (response.kind !== 'unavailable') return false;
  switch (response.reason) {
    case 'request-failed':
    case 'timeout':
      return true;
    case 'missing-bridge':
    case 'unexpected-response':
      return false;
    default: {
      const exhaustive: never = response;
      return exhaustive;
    }
  }
}

export function UninstallApp() {
  const { t } = useLingui();
  const [unavailable, setUnavailable] = useState(false);
  const [screen, setScreen] = useState<UninstallScreenSpec | null>(null);

  useEffect(() => {
    let live = true;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const next = await requestUninstallScreen();
      if (!live) return;
      if (next.kind === 'screen') setScreen(next.screen);
      else {
        failures = failures + 1;
        if (canRetry(next) && failures < MAX_TRANSIENT_SCREEN_FAILURES)
          timer = setTimeout(() => void load(), SCREEN_POLL_INTERVAL_MS);
        else setUnavailable(true);
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  const screenKind = screen?.kind;
  const awaitResult = screen?.kind === 'progress' && screen.awaitResult === true;
  useEffect(() => {
    if (unavailable || screenKind !== 'progress') return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => sendUninstallIntent({ kind: 'progress-shown' }));
    });
    let failures = 0;
    const refresh = async () => {
      const next = await requestUninstallScreen();
      if (!live) return;
      if (next.kind !== 'screen') {
        failures = failures + 1;
        if (!canRetry(next) || failures >= MAX_TRANSIENT_SCREEN_FAILURES) {
          setUnavailable(true);
          return;
        }
      } else {
        failures = 0;
        if (next.screen.kind !== 'progress') {
          setScreen(next.screen);
          return;
        }
      }
      timer = setTimeout(() => void refresh(), SCREEN_POLL_INTERVAL_MS);
    };
    if (awaitResult) timer = setTimeout(() => void refresh(), SCREEN_POLL_INTERVAL_MS);
    const deadline = awaitResult
      ? setTimeout(() => {
          live = false;
          clearTimeout(timer);
          setUnavailable(true);
        }, UNINSTALL_RESULT_WAIT_TIMEOUT_MS)
      : undefined;
    return () => {
      live = false;
      clearTimeout(timer);
      clearTimeout(deadline);
      cancelAnimationFrame(frame);
    };
  }, [screenKind, awaitResult, unavailable]);

  if (unavailable) {
    return (
      <UninstallNoticeScreen
        notice={{
          title: t`Unable to show the cleanup result`,
          paragraphs: [t`Cleanup may still be running.`],
          confirmLabel: t`Close`,
        }}
        onConfirm={() => window.close()}
        onCancel={() => window.close()}
        onRevealLog={() => {}}
      />
    );
  }

  if (screen !== null) {
    switch (screen.kind) {
      case 'picker':
        return (
          <UninstallPickerScreen
            projects={screen.projects}
            onConfirm={(selectedIndexes) =>
              sendUninstallIntent({ kind: 'picker-confirm', selectedIndexes })
            }
            onCancel={() => sendUninstallIntent({ kind: 'picker-cancel' })}
          />
        );
      case 'survey':
        return (
          <UninstallSurveyScreen
            onSend={(answers) => sendUninstallIntent({ kind: 'survey-send', ...answers })}
            onSkip={() => sendUninstallIntent({ kind: 'survey-skip' })}
          />
        );
      case 'progress':
        return <UninstallProgressScreen />;
      case 'result':
        return (
          <UninstallResultScreen
            outcome={screen.outcome}
            onRevealLog={() => sendUninstallIntent({ kind: 'notice-reveal-log' })}
            onConfirm={() => sendUninstallIntent({ kind: 'notice-confirm' })}
            onCancel={() => sendUninstallIntent({ kind: 'notice-cancel' })}
          />
        );
      case 'notice':
        return (
          <UninstallNoticeScreen
            notice={screen.notice}
            onRevealLog={() => sendUninstallIntent({ kind: 'notice-reveal-log' })}
            onConfirm={() => sendUninstallIntent({ kind: 'notice-confirm' })}
            onCancel={() => sendUninstallIntent({ kind: 'notice-cancel' })}
          />
        );
      default: {
        const _exhaustive: never = screen;
        return _exhaustive;
      }
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-8 text-foreground">
      <p className="text-center text-muted-foreground text-sm">
        <Trans>Preparing to uninstall OpenKnowledge</Trans>
      </p>
    </main>
  );
}
